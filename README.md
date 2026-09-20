# Samskara

A self-hosted [Mastra Factory](https://factory.mastra.ai/) — agents turn work
items into plans, implementations and reviewed pull requests — that treats chat
as a first-class intake path alongside GitHub.

Built on `@mastra/factory` as a dependency, not a fork. Runs entirely on
infrastructure you own: your own authentication, database, and sandbox
provider, with no dependency on Mastra's hosted platform.

## What is different from a stock Factory

A Factory scaffolded with `npm create factory` defaults to Mastra's platform for
auth, storage and sandboxes, and its built-in Work board is shaped around
GitHub issues. Samskara changes four things.

**Storage is libSQL only.** A local file for single-machine use, [Turso](https://turso.tech)
when `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are set. Postgres is
deliberately not wired: an injected `DATABASE_URL` is ignored rather than
silently repointing the backend, and the server says so at startup.

**Vectors live in their own database.** `LibSQLVector` is passed explicitly.
The Factory always injects a storage instance, which suppresses the SDK's
documented default-vector resolution, so omitting it yields no vector store at
all rather than the default.

**The sandbox provider is an explicit choice.** `local`, `e2b` or `platform`
via `FACTORY_SANDBOX_PROVIDER`, auto-detected when unset. A provider named
without its credentials throws at startup; it never downgrades to a less
isolated one. Running agent commands against untrusted repositories on the host
should be a decision, not a fallback.

**Chat-submitted work gets its own board.** `src/mastra/boards/requests-board.ts`
wires `manual` work items into triage, which the built-in Work board does not
do — it declares triage for GitHub and Linear items only, so a chat-sourced card
reaches Triage and receives a generic stage message instead of running the
triage skill.

## Setup

The runbooks in [`docs/setup/`](docs/setup/) take a fresh clone to a running
Factory. They are written to be followed by an AI coding agent; steps only a
human can do — creating accounts, browser authentication, pasting secrets — are
marked **HUMAN**.

| # | Runbook | What it gets you |
|---|---------|------------------|
| 1 | [mastra-docs-mcp.md](docs/setup/mastra-docs-mcp.md) | Documentation tooling, so later steps can be verified rather than guessed |
| 2 | [secrets-infisical.md](docs/setup/secrets-infisical.md) | A secret store, and every key this project needs created as a placeholder |
| 3 | [tunnel.md](docs/setup/tunnel.md) | A public HTTPS address, for local development only |
| 4 | [github-app.md](docs/setup/github-app.md) | Repository access and issue intake |
| 5 | [slack-app.md](docs/setup/slack-app.md) | Chat intake (optional) |

Requires Node.js 22.13.0 or newer.

```bash
npm install
npm run dev          # plain .env
npm run dev:secure   # secrets injected from Infisical
```

The Factory serves its UI and API together on <http://localhost:4111>.

## Commands

```bash
npm run check        # tsc --noEmit
npm run build        # bundles to .mastra/output
npm run db:backup    # snapshot to ~/.samskara-backups (VACUUM INTO)
```

`mastra build` deletes the whole `.mastra/` directory, so nothing worth keeping
belongs there. The database lives in `data/` for that reason, and backups are
written outside the repository.

## Configuration

`.env.example` documents every variable with its effect. The ones that decide
the shape of a deployment:

| Variable | Effect |
|----------|--------|
| `MASTRACODE_PUBLIC_URL` | The origin users reach the Factory at. Builds OAuth callbacks and the deep links posted into chat, so a `localhost` value produces links that resolve for nobody else. |
| `MASTRACODE_CHANNELS_PUBLIC_URL` | Origin for channel webhooks and the Slack OIDC redirect. Falls back to the above. |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Hosted database. Without them, a local libSQL file that does not survive a container restart and cannot be shared across replicas. |
| `FACTORY_SANDBOX_PROVIDER` | `local`, `e2b` or `platform`. |
| `FACTORY_CREDENTIAL_ENCRYPTION_KEY` | Encrypts stored provider credentials. Losing it makes them unreadable. |

Secrets belong in a secret manager rather than `.env` — see
[secrets-infisical.md](docs/setup/secrets-infisical.md). An entry in `.env`
shadows an injected value, so a key should live in one place, not both.

## Status

Version 0.1.0, running but not yet serving anyone other than its author. Known
gaps are tracked in the issue tracker that ships with this repository (see
below).

Pinned to `@mastra/factory@0.15.0` exactly. The package ships breaking minors
weekly, so the pin is deliberate; upgrading is a task, not a bump.

## Issue tracking

Issues are tracked with [beads](https://github.com/gastownhall/beads) and travel
with this repository on a separate git ref, so a clone can read them:

```bash
bd init --remote git+https://github.com/hamchowderr/samskara.git
bd ready
```

`.beads/issues.jsonl` is a disposable export and is not tracked; the database is
the source of truth.

## Licence

[Apache-2.0](LICENSE).
