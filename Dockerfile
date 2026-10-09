# syntax=docker/dockerfile:1

# Samskara for Coolify on the VPS. Boots under `infisical run`: every key comes
# from the server's own Infisical project (docs/setup/deploy-coolify.md), at
# prod:/samskara; Coolify holds only the machine-identity pair. The entrypoint
# is the shared Otaku one, copied unchanged (history: an external owner note).

# Base image, identical in all four stages: Node 24.21.0 on Debian bookworm
# (glibc 2.36, the reason this is slim and not Alpine), pinned by digest so a
# retagged image cannot change a build. Dependabot (.github/dependabot.yml)
# refreshes the digest on all four lines together and never bumps the Node
# version. The lines are literal because Dependabot skips `FROM ${ARG}`.

# ── build ────────────────────────────────────────────────────────────────────
# node:24-slim, not Alpine: onnxruntime-node needs glibc. Pinned to the floor in
# package.json engines, which is also what CI runs. Not 22.19: its undici
# cancels a request body when a discarded clone is garbage-collected, which
# broke web sessions in prod (samskara-z1i; tests/runtime/request-body-gc).
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
COPY package.json package-lock.json ./
# npm workspaces: `npm ci` needs each workspace's manifest to link it.
COPY packages/factory-beads/package.json packages/factory-beads/
# npm's download cache lives in a BuildKit cache mount: it persists between
# builds on the same builder but is never written into a layer, so a rebuild
# only downloads packages that changed (docs.docker.com/build/cache/optimize).
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
# prebuild regenerates .branded-ui from node_modules; mastra build writes
# .mastra/output. Its node_modules are dropped: the runtime stage installs from
# the output's package.json + package-lock.json instead (Mastra's documented
# Dockerfile, docs-deployment-workers.md "Deploy split workers"). The build's
# install is kept rather than skipped (MASTRA_BUILD_SKIP_INSTALL) because it is
# also what writes that lockfile.
RUN --mount=type=cache,target=/root/.npm \
    npm run build && rm -rf .mastra/output/node_modules

# ── infisical cli ────────────────────────────────────────────────────────────
# Same pin as the other Otaku images. Only the binary reaches the runtime stage.
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS infisical-cli
ARG INFISICAL_CLI_VERSION=0.43.110
# pipefail so a failed download fails the build instead of piping nothing to
# bash (Docker best practices, "Using pipes").
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
 && curl -1sLf 'https://artifacts-cli.infisical.com/setup.deb.sh' | bash \
 && apt-get update \
 && apt-get install -y --no-install-recommends "infisical=${INFISICAL_CLI_VERSION}" \
 && infisical --version

# ── bd (beads) ───────────────────────────────────────────────────────────────
# The beads integration (packages/factory-beads, on unless BEADS_INTEGRATION=0)
# shells out to `bd` on the host. Pinned release binary from the official
# gastownhall/beads releases, verified against the release's checksums.txt;
# bumping BD_VERSION without the matching checksums fails the build. Needs
# glibc >= 2.34 (bookworm has 2.36). See docs/operations/beads.md.
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS bd-cli
ARG BD_VERSION=1.3.1
ARG BD_SHA256_AMD64=3219443a9734b89b93fb16ee8d65844759fa1b3cd3cf139c606b7353cfb0715c
ARG BD_SHA256_ARM64=c3b32c71a6c0cd6358a12c28272b17e6818db991da192f87df52339c222e423a
ARG TARGETARCH
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && arch="${TARGETARCH:-amd64}" \
 && case "$arch" in amd64) sum="$BD_SHA256_AMD64" ;; arm64) sum="$BD_SHA256_ARM64" ;; *) echo "unsupported arch $arch" >&2; exit 1 ;; esac \
 && curl -fsSL -o /tmp/bd.tar.gz "https://github.com/gastownhall/beads/releases/download/v${BD_VERSION}/beads_${BD_VERSION}_linux_${arch}.tar.gz" \
 && echo "${sum}  /tmp/bd.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/bd.tar.gz -C /usr/local/bin bd \
 && /usr/local/bin/bd --version

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runtime

# git: agent sessions clone and push repositories. tini: PID 1 that signals
# the whole group, since `infisical run` forks rather than execs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

COPY --from=infisical-cli /usr/bin/infisical /usr/local/bin/infisical
COPY --from=bd-cli /usr/local/bin/bd /usr/local/bin/bd
# bd sends anonymous usage metrics unless told not to. The integration's runner
# already turns them off for every bd call it makes; these cover a bd started by
# hand in the container (docker exec). See docs/operations/beads.md.
ENV BD_DISABLE_METRICS=1 \
    BD_DISABLE_EVENT_FLUSH=1

COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Strip CRLF: a Windows checkout would otherwise break the shebang.
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
 && chmod 0755 /usr/local/bin/docker-entrypoint.sh

# /app is owned by node up front, and everything below is copied or installed
# as node. A trailing `chown -R` would copy the whole tree into a second layer.
RUN mkdir /app && chown node:node /app
WORKDIR /app
USER node

# Mastra's documented pattern: install from the output's manifest first, then
# copy the rest, so a code-only change reuses the cached dependency layer.
# `npm ci` where the doc has `npm install`: the doc copies no lockfile, this
# does, and ci installs exactly that lockfile or fails instead of re-resolving.
COPY --chown=node:node --from=build /app/.mastra/output/package.json /app/.mastra/output/package-lock.json ./
# Runs as node, so the cache mount must be node-owned (uid/gid 1000); it
# defaults to root and npm would fail with EACCES. No `npm cache clean`: the
# cache is in the mount, not the layer.
RUN --mount=type=cache,target=/home/node/.npm,uid=1000,gid=1000 \
    npm ci --omit=dev
COPY --chown=node:node --from=build /app/.mastra/output/ ./
# `mastra build` copies Mastra's UNBRANDED Factory UI into output/factory, and
# the server prefers MASTRACODE_UI_DIST over it (@mastra/factory
# dist/spa-static.js resolveUiDistDir). Without this the sign-in page says
# "Mastra Factory". See docs/operations/white-label-ui.md.
COPY --chown=node:node --from=build /app/.branded-ui ./branded-ui
ENV MASTRACODE_UI_DIST=/app/branded-ui

ENV NODE_ENV=production
ENV PORT=4111
# The auth gate and SPA are useless without auth; `mastra factory dev` is not
# used here, but pin it anyway so no default can turn it off.
ENV MASTRACODE_AUTH_DISABLED=0

# Which Infisical secrets this container boots on. The identity credentials
# (INFISICAL_UNIVERSAL_AUTH_CLIENT_ID / _CLIENT_SECRET) come from Coolify at
# runtime and are the ONLY secret it holds. Unset them and the entrypoint boots
# on the ambient environment (the rollback lever).
# The project is VPS, not the laptop's project: on Infisical's free plan an
# identity's access covers a whole project, so the `vps` identity must only be
# able to open a project that holds VPS keys and nothing else.
ENV INFISICAL_PROJECT_ID=56fe6a1e-69bf-487d-b885-3ac9851e2f1f
ENV INFISICAL_ENVIRONMENT=prod
ENV INFISICAL_SECRET_PATH=/samskara
ENV INFISICAL_DISABLE_UPDATE_CHECK=true
# Floor for the entrypoint's pre-flight: fewer than this means the identity is
# scoped to the wrong path.
ENV INFISICAL_MIN_SECRETS=12

EXPOSE 4111

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4111/auth/me').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "index.mjs"]
