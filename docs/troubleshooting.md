# Troubleshooting

Failures that are hard to diagnose from the symptom, because nothing obvious
points at the cause. Each was hit in practice.

For setup problems, start with the runbook for that piece in
[`docs/setup/`](setup/). For a new factory that will not take work, walk
[setup/new-project.md](setup/new-project.md) again.

## Calling the Factory API by hand

Several fixes below call a `/web/...` route directly. The Factory gate answers
an API call that carries no session with `401` (`@mastra/factory` 0.20.0
`dist/auth.js:540-560`). Only `/auth/*`, the GitHub and GitLab webhook `POST`s,
signed channel webhooks, `GET /connect/slack` and the sign-in assets are exempt
(`:543-548`). A plain `curl` without a session therefore fails, even on a route
declared `requiresAuth: false`.

The simplest way to send a request as yourself is the browser console of a tab
signed in to the Factory. A same-origin `fetch` sends the session cookie:

```js
await fetch('/web/github/status').then(r => r.json());

await fetch('/web/factory/work-items/<id>', {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ board: 'work', stages: ['triage'] }),
}).then(r => r.json());
```

Never paste a session cookie into a terminal or a chat: it is a credential.

## Slack messages create work items, but they never get triaged

**Expected:** a chat request runs triage.
**Actual:** the card is on the Work board, already at Building.

This is how `@mastra/factory` 0.20.0 behaves. A dispatched Slack thread creates
its card with `stages: ["execute"]` and no board
(`dist/integrations/slack/slack.js:570-585`), and only when the factory's
**Create work items for new Slack threads** setting is on (`slack.js:658`). A
card with no board belongs to `work` (`dist/boards/semantics.js:8`), which is
Samskara's own Work board (see [boards.md](boards.md)), so the card is on the
right board. It skipped Triage because the Slack integration files it straight
into Building (`samskara-ylt`).

Assign the board and phase by hand, from a signed-in session (see
[Calling the Factory API by hand](#calling-the-factory-api-by-hand)):
`PATCH /web/factory/work-items/<id>` with
`{"board":"work","stages":["triage"]}`.

That works only while the card's board is still unset — a second attempt returns
`board_already_assigned` (`dist/routes/work-items.js:558`). There is no
configuration that files Slack work into Triage; upstream calls per-origin
routing a planned follow-up.

## Slack replies "Pick a default factory" and nothing runs

The Slack account link has no default factory, and the organization has zero
factories or more than one. With exactly one, the link is set to it
automatically. Otherwise the bot posts this card and blocks the run
(`dist/integrations/slack/slack.js:103-145`).

Channels do not map to factories. Each linked Slack user's runs go to that
user's default factory. Set it in the Factory under **Settings → Connections →
Slack → Session behavior → Default factory**, then send the message again. See
[setup/slack-app.md](setup/slack-app.md#6-link-your-slack-account-to-the-factory--human).

## "No usable anthropic credential is configured"

The full message asks you to connect the provider or add an organization
credential — and you have already connected one.

A provider connection has a scope: **user** (yours) or **organization**. Runs on
a factory session resolve credentials organization-first
(`@mastra/code-sdk` 1.11.0 `dist/agents/credential-resolver.js`,
`isFactorySessionContext`), and a background run — a GitHub event, a board run,
a Slack message — is not you working interactively. A **user-scoped**
connection is what such runs cannot rely on.

Add an **organization-scoped** credential in the factory's settings under
**Factory models → Provider access**. Its scope is fixed to the organization.
For production and client organizations, use **Connect with API key** only, not
**Sign in with a provider**: a subscription sign-in is one person's consumer
account, and provider terms may not permit using it for other people's work
(`samskara-nn2`). The full rules are in
[setup/new-project.md](setup/new-project.md#4-connect-models).

A key in the server's environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) does
not help: tenant runs never fall back to environment keys
(`dist/routes/tenant-credentials.js:11`, `allowEnvironmentFallback = false`).

## Onboarding offers no API key for Anthropic, OpenAI or xAI

The model step of the Create Factory wizard lists these three only as **Continue
with …** buttons, which sign in with a personal subscription. It shows an
API-key search only for providers without OAuth (`samskara-nn2`; Mastra's UI
bundle, reported upstream).

Skip that step. After the factory exists, add the key under **Factory models →
Provider access → Connect with API key**, which lists the whole catalog. See
[setup/new-project.md](setup/new-project.md#4-connect-models).

## A board run stops with "Choose a repository for this work item"

The factory has more than one linked repository and the card does not say which
one it is for. `@mastra/factory` 0.20.0 stops rather than picking one
(`dist/routes/surface.js:189`, `dist/rules/start-coordinator.js:87-88`). Choose
the repository on the card and start it again.

Beads cards hit this on every run in a multi-repository factory, because the
integration does not yet set the repository field the Factory reads
(`samskara-srl`). Link one repository per factory where beads matters. See
[operations/beads.md](operations/beads.md#limitations).

## No beads cards appear

Read the `[beads]` startup line first.

- `[beads] on by default, but the GitHub App is not configured, so the
  integration is idle.` — the GitHub App group is incomplete. See
  [setup/github-app.md](setup/github-app.md).
- `[beads] off (BEADS_INTEGRATION is set to turn it off).` — intended on an
  instance that must not write beads; see
  [setup/environments.md](setup/environments.md#one-environment-per-repository).

Then call `GET /web/beads/status` from a signed-in session. Each linked
repository has a state:

- `no-beads-data` — origin has no `refs/dolt/data`. Push the beads data from the
  repository (`bd dolt remote add origin <git url>`, `bd dolt push`).
- `error` — `reason` says why; the next tick retries.
- `parked` — a write-back conflict. An organization admin resets it with
  `POST /web/beads/reset`.

The meaning of each state and the fixes are in
[operations/beads.md](operations/beads.md#repository-states). A ready bead lands
in Intake and waits there: move the card to Triage to start it.

## A value in `.env` is being used instead of the one from your secret manager

Symptom: an integration reports itself unconfigured, or authenticates with a
credential you rotated.

An entry in `.env` shadows an injected value. A key left as `SLACK_APP_BOT_TOKEN=`
with nothing after it is not "unset" — it is defined and empty, which reads as
configured-but-blank.

Keep each key in one place. If it lives in your secret manager, delete the line
from `.env` rather than blanking it.

## An integration you never configured is starting, or boot fails on a URL

A placeholder is a value. The code treats any non-empty value as configured, so
`TURSO_DATABASE_URL=PASTE_ME` becomes the database URL and `E2B_API_KEY=PASTE_ME`
selects the E2B sandbox. Delete every key you are not using from Infisical and
`.env`. See [setup/secrets-infisical.md](setup/secrets-infisical.md#6-paste-the-real-values--human).

## Everything in `.mastra/` disappeared after a build

`mastra build` deletes the entire `.mastra/` directory before writing output.
Anything stored there is gone.

Samskara keeps its database in `data/` for this reason, provided `.env` sets
`MASTRA_DB_PATH` to an absolute path there, and `npm run db:backup` writes
snapshots to `~/.samskara-backups`, outside the repository. If you added
something of your own under `.mastra/`, move it.

## Agent commands are running unconfined

At startup, look for:

```
[sandbox] isolation=none — Native sandboxing is not supported on win32.
```

`local` confines commands only where a backend exists: `seatbelt` on macOS,
`bwrap` on Linux when bubblewrap is installed (`apt install bubblewrap`).
**Windows has no backend at all** — see
[mastra-ai/mastra#20304](https://github.com/mastra-ai/mastra/issues/20304).

For anything you would not run a stranger's script against, set
`FACTORY_SANDBOX_PROVIDER=e2b` — or use Docker, which is the way to get
isolation on Windows without a cloud provider.

## Slack sign-in never completes, and nothing is logged

You click through the connect flow, no error appears, and the account link is
never written.

If you are tunnelling with ngrok on the free tier, its browser interstitial sits
in front of the OAuth callback. Server-to-server webhooks pass through it fine,
so event delivery looks healthy while sign-in silently fails.

Use a Cloudflare tunnel, or a paid ngrok plan where the interstitial is
disabled. See [docs/setup/tunnel.md](setup/tunnel.md).

## `SQLITE_BUSY: database is locked`

The Mastra Code CLI and this server both open a libSQL file, and by default they
resolve to the same one: `<appdata>/mastracode/mastra.db`
(`@mastra/code-sdk` `dist/utils/project.js:150-153`).

Set `MASTRA_DB_PATH` to an absolute path inside this project. `.env.example`
documents it. The SDK's vector-path helper has no equivalent override, which is
why the vector database path is derived from `MASTRA_DB_PATH` here
(`src/mastra/index.ts:419`). With `MASTRA_DB_PATH` unset, that derived path is
the CLI's own `mastra-vectors.db`, so the vector file is shared with the CLI as
well.

## Still stuck

Open an issue with the versions, your operating system, sandbox provider and
database — the template asks for each. See
[CONTRIBUTING.md](../CONTRIBUTING.md).
