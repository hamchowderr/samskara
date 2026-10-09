# Setting up Samskara

Samskara is a self-hosted [Mastra Factory](https://factory.mastra.ai/). These
runbooks take a fresh clone to a running Factory that can accept work from
GitHub and Slack.

They are written to be followed by an AI coding agent. Steps only a human can
do — creating accounts, approving OAuth in a browser, pasting secret values —
are marked **HUMAN**. An agent that reaches one stops and asks.

## Order

Follow these in order. Each one depends on the ones before it.

| # | Runbook | What it gets you |
|---|---------|------------------|
| 1 | [mastra-docs-mcp.md](mastra-docs-mcp.md) | Documentation tooling, so every later step can be checked against the installed packages rather than guessed |
| 2 | [secrets-infisical.md](secrets-infisical.md) | A secret store, and every key this project needs created as a placeholder |
| 3 | [tunnel.md](tunnel.md) | A public HTTPS address for your machine |
| 4 | [github-app.md](github-app.md) | Repository access and issue intake |
| 5 | [slack-app.md](slack-app.md) | Chat intake (optional) |
| 6 | [deploy-coolify.md](deploy-coolify.md) | An always-on server deployment (optional) |
| 7 | [new-project.md](new-project.md) | A factory with its repositories, models, memory, Slack routing and beads, checked end to end |

Running Samskara both on your own machine and on a server? Read
[environments.md](environments.md) before steps 4 and 5: each environment needs
its own GitHub App and Slack app, and each repository is worked in exactly one
of the two. A server needs no tunnel: skip step 3 for it.

Do 1 before the rest. The docs MCP server is how an agent verifies claims about
Mastra behaviour, and this project requires that verification — see
[CLAUDE.md](../../CLAUDE.md).

Do 2 before 4 and 5, so there is somewhere to put the credentials those steps
produce.

On your own machine, do 3 before 4 and 5. Both GitHub and Slack need to reach
it over HTTPS, and both bake that address into their app configuration.

Do 7 once per project, after the server runs: it is where a factory is created,
repositories are linked and models are connected.

## Model providers

Background runs (board work, GitHub events, Slack messages) need an
**organization-scoped** model credential, and production or client
organizations use an **organization API key** only. The onboarding wizard does
not offer an API key for Anthropic, OpenAI or xAI (`samskara-nn2`), and keys in
the server's environment never reach tenant runs. The rules, and where each
setting lives, are in [new-project.md](new-project.md#4-connect-models).

## What you need first

- **Node.js 24.21.0 or newer**, the version pinned in `package.json` engines,
  CI and the Docker image. Avoid Node 22.19: its bundled undici cancels a
  request body when a discarded clone is garbage-collected, which breaks web
  sessions (see `tests/runtime/request-body-gc.test.ts`).
- **An E2B account** for cloud sandboxes, or nothing extra if you intend to run
  agent commands on the host (see `FACTORY_SANDBOX_PROVIDER` in `.env.example`).
- **A Turso database** for anything beyond a single machine. Without it,
  Samskara writes to a local libSQL file, which does not survive a container
  restart and cannot be shared across replicas. Measure a region for stalls
  before creating the database there; see
  [operations/turso.md](../operations/turso.md).
- **Locally, `MASTRA_DB_PATH` in `.env`**, set to an absolute path inside the
  repository (for example `<repo>/data/samskara.db`), with the `data/`
  directory created. Unset, the server shares the Mastra Code CLI's database;
  see `.env.example`.

## After setup

```bash
npm run check    # typecheck
npm run dev      # plain .env
npm run dev:secure   # secrets injected from Infisical; checks the key matches dev
```

The Factory serves on <http://localhost:4111>. Continue with
[new-project.md](new-project.md).

## Conventions used in these runbooks

- **HUMAN** marks a step an agent must hand back to a person.
- Commands are given for PowerShell on Windows and a POSIX shell elsewhere.
  Where the two differ, both are shown.
- No command in these runbooks prints a secret value. If you find one that
  does, that is a bug in the runbook.
- A `/web/...` route is called from a signed-in session, never with a bare
  `curl`; see
  [troubleshooting.md](../troubleshooting.md#calling-the-factory-api-by-hand).
