# syntax=docker/dockerfile:1

# Samskara for Coolify on the VPS. Boots under `infisical run`, so every key is
# read from Infisical at start-up (project VPS, prod:/samskara); Coolify holds
# only the machine-identity pair. The entrypoint is the shared Otaku one (see the
# Coolify + Infisical cutover note), copied unchanged.

# ── build ────────────────────────────────────────────────────────────────────
# node:24-slim, not Alpine: onnxruntime-node needs glibc. Pinned to the floor in
# package.json engines, which is also what CI runs. Not 22.19: its undici
# cancels a request body when a discarded clone is garbage-collected, which
# broke web sessions in prod (samskara-z1i; tests/runtime/request-body-gc).
FROM node:24.21.0-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# prebuild regenerates .branded-ui from node_modules; mastra build writes
# .mastra/output with its own node_modules.
RUN npm run build

# ── infisical cli ────────────────────────────────────────────────────────────
# Same pin as the other Otaku images. Only the binary reaches the runtime stage.
FROM node:24.21.0-slim AS infisical-cli
ARG INFISICAL_CLI_VERSION=0.43.110
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
 && curl -1sLf 'https://artifacts-cli.infisical.com/setup.deb.sh' | bash \
 && apt-get update \
 && apt-get install -y --no-install-recommends "infisical=${INFISICAL_CLI_VERSION}" \
 && infisical --version

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:24.21.0-slim AS runtime

# git: agent sessions clone and push repositories. tini: PID 1 that signals
# the whole group, since `infisical run` forks rather than execs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

COPY --from=infisical-cli /usr/bin/infisical /usr/local/bin/infisical

WORKDIR /app
COPY --from=build /app/.mastra/output ./
# `mastra build` copies Mastra's UNBRANDED Factory UI into output/factory, and
# the server prefers MASTRACODE_UI_DIST over it (@mastra/factory
# dist/spa-static.js resolveUiDistDir). Without this the sign-in page says
# "Mastra Factory". See docs/operations/white-label-ui.md.
COPY --from=build /app/.branded-ui ./branded-ui
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

COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Strip CRLF: a Windows checkout would otherwise break the shebang.
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
 && chmod 0755 /usr/local/bin/docker-entrypoint.sh \
 && chown -R node:node /app

USER node
EXPOSE 4111

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4111/auth/me').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "index.mjs"]
