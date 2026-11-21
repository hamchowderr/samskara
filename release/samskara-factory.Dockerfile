# Coolify's Factory app builds this: the image GitHub Actions already built for this commit (release/README.md).
ARG SOURCE_COMMIT
FROM ghcr.io/hamchowderr/samskara-factory:sha-${SOURCE_COMMIT}
