# Setting up Samskara

Samskara is a self-hosted [Mastra Factory](https://code.mastra.ai/). These
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
| 2 | [secrets-infisical.md](secrets-infisical.md) | A secret store, and every key this project needs created as an empty placeholder |
| 3 | [tunnel.md](tunnel.md) | A public HTTPS address for your machine |
| 4 | [github-app.md](github-app.md) | Repository access and issue intake |
| 5 | [slack-app.md](slack-app.md) | Chat intake (optional) |
| 6 | [deploy-coolify.md](deploy-coolify.md) | An always-on server deployment (optional) |

Running Samskara both on your own machine and on a server? Read
[environments.md](environments.md) before steps 4 and 5: each environment needs
its own GitHub App and Slack app. A server needs no tunnel: skip step 3 for it.

Do 1 before the rest. The docs MCP server is how an agent verifies claims about
Mastra behaviour, and this project requires that verification — see
[CLAUDE.md](../../CLAUDE.md).

Do 2 before 4 and 5, so there is somewhere to put the credentials those steps
produce.

On your own machine, do 3 before 4 and 5. Both GitHub and Slack need to reach
it over HTTPS, and both bake that address into their app configuration.

## Connect model providers with an API key, not OAuth

The Factory lets you connect a model provider either by signing in to it (OAuth)
or by entering an API key. Prefer the **API key, scoped to the organization**.

OAuth connects the provider to *you* personally. Anything that runs in the
background — a message from Slack, a GitHub event, a scheduled run — resolves
credentials organization-first and cannot see a personal connection. Those runs
fail at the model layer with "No usable `<provider>` credential is configured",
after the session has already started, which makes it look like a problem with
whatever triggered the run.

An organization API key works for both interactive and background runs, and is
the only shape that works when other people use your Factory.

## What you need first

- **Node.js 24.21.0 or newer**, the version pinned in `package.json` engines,
  CI and the Docker image. Avoid Node 22.19: its bundled undici cancels a
  request body when a discarded clone is garbage-collected, which breaks web
  sessions (see `tests/runtime/request-body-gc.test.ts`).
- **An E2B account** for cloud sandboxes, or nothing extra if you intend to run
  agent commands on the host (see `FACTORY_SANDBOX_PROVIDER` in `.env`).
- **A Turso database** for anything beyond a single machine. Without it,
  Samskara writes to a local libSQL file, which does not survive a container
  restart and cannot be shared across replicas.

## After setup

```bash
npm run check    # typecheck
npm run dev      # plain .env
npm run dev:secure   # secrets injected from Infisical; checks the key matches dev
```

The Factory serves on <http://localhost:4111>.

## Conventions used in these runbooks

- **HUMAN** marks a step an agent must hand back to a person.
- Commands are given for PowerShell on Windows and a POSIX shell elsewhere.
  Where the two differ, both are shown.
- No command in these runbooks prints a secret value. If you find one that
  does, that is a bug in the runbook.
