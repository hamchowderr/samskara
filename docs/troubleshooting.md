# Troubleshooting

Failures that are hard to diagnose from the symptom, because nothing obvious
points at the cause. Each was hit in practice.

For setup problems, start with the runbook for that piece in
[`docs/setup/`](setup/).

## Slack messages create work items, but they never get triaged

**Expected:** a chat request runs triage.
**Actual:** the card is on the Work board, already at Building.

This is how `@mastra/factory` 0.20.0 behaves. A dispatched Slack thread creates
its card with `stages: ["execute"]` and no board
(`dist/integrations/slack/slack.js:570-585`). A card with no board belongs to
`work` (`dist/boards/semantics.js:8`), which is Samskara's own Work board (see
[boards.md](boards.md)), so the card is on the right board. It skipped Triage
because the Slack integration files it straight into Building.

Assigning the board and phase by hand:

```bash
curl -X PATCH "$FACTORY/web/factory/work-items/<id>" \
  -H 'content-type: application/json' \
  -d '{"board":"work","stages":["triage"]}'
```

That works only while the card's board is still unset — a second attempt returns
`board_already_assigned` (`dist/routes/work-items.js:555-560`). There is no
configuration that files Slack work into Triage; upstream calls per-origin
routing a planned follow-up.

## "No usable anthropic credential is configured"

The full message asks you to connect the provider or add an organization
credential — and you have already connected one.

Connecting a provider through OAuth attaches it to **you**. Anything that runs
in the background — a Slack message, a GitHub event, a scheduled run — resolves
credentials organization-first and cannot see a personal connection.

Add an **API key scoped to the organization** in Settings → Models, rather than
signing in to the provider. Interactive runs work either way; background runs
need the organization credential.

## A value in `.env` is being used instead of the one from your secret manager

Symptom: an integration reports itself unconfigured, or authenticates with a
credential you rotated.

An entry in `.env` shadows an injected value. A key left as `SLACK_APP_BOT_TOKEN=`
with nothing after it is not "unset" — it is defined and empty, which reads as
configured-but-blank.

Keep each key in one place. If it lives in your secret manager, delete the line
from `.env` rather than blanking it.

## Everything in `.mastra/` disappeared after a build

`mastra build` deletes the entire `.mastra/` directory before writing output.
Anything stored there is gone.

Samskara keeps its database in `data/` for this reason, and `npm run db:backup`
writes snapshots to `~/.samskara-backups`, outside the repository. If you added
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
resolve to the same one.

Set `MASTRA_DB_PATH` to a path inside this project. `.env.example` documents it.
Note that the SDK's vector-path helper has no equivalent override, which is why
the vector database path is derived here rather than taken from it.

## Still stuck

Open an issue with the versions, your operating system, sandbox provider and
database — the template asks for each. See
[CONTRIBUTING.md](../CONTRIBUTING.md).
