# Releases

GitHub Actions (`.github/workflows/image.yml`) builds the root `Dockerfile`. A pull request only builds it. A push to
`main` publishes `ghcr.io/hamchowderr/samskara-factory:sha-<commit>` and then pushes that commit to
`release/samskara-factory`.

Coolify's Factory app deploys from `release/samskara-factory` with `release/samskara-factory.Dockerfile`, which is only
`FROM` that commit's image, so the VPS downloads the image and never builds from source.

The release branch only moves forward: the push is never forced, so re-running an older commit cannot roll the app
back. To roll back, revert on `main`.

The package is private. The VPS pulls it with its own ghcr.io login (a `read:packages` token).
