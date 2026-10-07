# Creating the Slack app

Slack lets people start agent runs by mentioning the bot or sending it a
message. Each thread becomes a Factory session with its own git branch, and
optionally a card on a board.

Slack is optional. Samskara boots without it; the startup line simply omits it.

Complete [tunnel.md](tunnel.md) first. Slack only accepts HTTPS request URLs and
verifies them at save time, so the tunnel has to be running before you create
the app.

Throughout, replace `https://samskara.example.com` with your own public URL.

Create one app per environment — one for local development, one for
production. See [environments.md](environments.md).

## 1. Render the manifest

Slack can create an app from a JSON manifest, which sets every scope, event and
URL in one step.

```bash
node scripts/render-slack-manifest.mjs
```

Reads `scripts/slack-app-manifest.template.json`, substitutes your public URL
from `MASTRACODE_CHANNELS_PUBLIC_URL` (or `MASTRACODE_PUBLIC_URL`), and writes
`scripts/slack-app-manifest.json`. Pass `--url https://...` to override, or
`--stdout` to print instead of writing.

It also prints a `https://api.slack.com/apps?new_app=1&manifest_json=...` link.
Slack reads the manifest out of that query string, so opening it lands you on
the create-app form with every field already filled in.

The rendered file is gitignored — it contains one deployment's hostname.

The script refuses a non-HTTPS or localhost URL, because Slack would accept
neither.

## 2. Create the app — **HUMAN**

Open the link the previous step printed. The form arrives already filled in —
pick the workspace, review, and press **Create**. Nothing to paste.

If your terminal or browser truncates the link, go to
<https://api.slack.com/apps> → **Create New App** → **From a manifest**, pick
the workspace, and paste the contents of `scripts/slack-app-manifest.json`.

Slack validates the manifest on arrival. An error here usually means an
unreplaced `{{PUBLIC_URL}}`.

## 3. Install to the workspace — **HUMAN**

On the app's page, **Install App** → **Install to Workspace** → Allow.

Installing requires permission to add apps to the workspace. In a workspace you
do not administer, this generates a request for an admin to approve.

## 4. Collect the credentials — **HUMAN**

| Where | Value | Variable |
|-------|-------|----------|
| Basic Information → App Credentials | Signing Secret | `SLACK_APP_SIGNING_SECRET` |
| Basic Information → App Credentials | Client ID | `SLACK_APP_CLIENT_ID` |
| Basic Information → App Credentials | Client Secret | `SLACK_APP_CLIENT_SECRET` |
| OAuth & Permissions | Bot User OAuth Token (`xoxb-`) | `SLACK_APP_BOT_TOKEN` |

Use the **Bot** token, the one starting `xoxb-`. The User OAuth Token
(`xoxp-`) on the same page acts as you rather than as the app.

Paste them into the Infisical `samskara` folder — see
[secrets-infisical.md](secrets-infisical.md). The placeholder keys already
exist.

Do not add `SLACK_APP_*` to `.env`. An empty key there shadows the injected
value, which presents as Slack being unconfigured with no error explaining why.

## 5. Verify the request URL — **HUMAN**

Restart Samskara so it picks up the credentials, then on the app page open
**Event Subscriptions**. Slack sends a challenge request and the field should
show **Verified**.

If it does not, press Retry. The server must be running and the tunnel
connected.

## 6. Link your Slack account to the Factory — **HUMAN**

Slack knows who sent a message, but the Factory needs to know which of its users
that is.

Open `https://samskara.example.com/connect/slack` and complete Sign in with
Slack. This writes the link that lets your messages start runs.

Until it exists, the bot replies with a card inviting you to connect instead of
starting a session.

If the browser lands on a page from your tunnel provider rather than Slack, the
tunnel is serving an interstitial — see the ngrok note in
[tunnel.md](tunnel.md). The OAuth callback cannot complete through one.

## 7. Add an organization model credential — **HUMAN**

Connecting a model provider through OAuth on your own account is **not enough
for Slack-triggered runs**. A message arriving from Slack starts a background
run, and background runs resolve credentials organization-first. A personal
OAuth connection is not visible to them, so the run fails at the model layer
with:

```
No usable anthropic credential is configured for this signed-in Factory
account. Connect the provider or add an organization credential, then try
again.
```

Everything up to that point works — the thread is created, the session starts,
the branch is cut — so it reads like a Slack problem when it is not.

In the Factory UI, open **Settings → Models** and add an **API key** scoped to
the organization, rather than signing in to the provider. This is also the right
shape for serving other people: the runs bill to your account, and nobody needs
their own provider subscription.

### The memory model needs that key too

Every run also calls the observational-memory model, which also writes session
titles. If its provider has no organization key, memory and titles fail with
the same "No usable … credential" error while chat keeps working, so the failure
is easy to miss.

The memory model is stored in two places, in the `memory_settings` table:

- **Your own row.** **Settings → Memory** edits this one, and only this one.
- **The factory-wide row** (`user_id` = `factory-project:<factoryId>`). Board
  runs and Slack sessions read this one. The Settings page cannot edit it.

Set the factory-wide row through the API, once per role, while signed in:

```
PUT /web/config/om/observer/model    {"modelId": "<provider/model>", "factoryId": "<factoryId>"}
PUT /web/config/om/reflector/model   {"modelId": "<provider/model>", "factoryId": "<factoryId>"}
```

Use a model from the provider the organization key covers. The route is in
`@mastra/factory` `dist/routes/config.js` (`/web/config/om/:role/model`).

## 8. Use it

Invite the bot to a channel and mention it:

```
/invite @Samskara
@Samskara what does this repo do?
```

Or send it a direct message, where no mention is needed.

Each new thread starts a session on a branch named `slack/<timestamp>`.

## The URLs, and one trap

| Purpose | Path |
|---------|------|
| Events and interactivity | `/api/agent-controllers/mastra-code/channels/slack/webhook` |
| Account linking (OIDC callback) | `/connect/slack/oidc/callback` |
| Connect page | `/connect/slack` |

The `mastra-code` segment is a literal string, not a value you substitute. It is
the agent controller's id as the Slack adapter registers it, and it differs from
the controller id used elsewhere in the SDK. Changing it produces a webhook URL
that verifies as a 404.

## What the app can do

16 bot scopes and 5 bot events, mirroring `DEFAULT_BOT_SCOPES` and
`DEFAULT_BOT_EVENTS` in `@mastra/slack`. Read and post in channels, groups,
DMs and multi-person DMs; read mentions; read user profiles; add reactions;
read files; use the assistant view.

The two user scopes (`openid`, `profile`) are what the connect route requests
for Sign in with Slack. They identify who is linking; they grant no access to
your messages.

Narrowing the scope list means editing the template and re-creating the app.
Slack does not allow removing scopes from an installed app.

## Where Slack work lands

A dispatched thread creates a card at the **Building** stage on the built-in
Work board. This is fixed in `@mastra/factory` 0.15.0:
`upsertThreadWorkItem` passes `stages: ["execute"]` and no board, so chat work
does not pass through triage and cannot be routed to a custom board.

Enable the cards per project with `slack_work_items_enabled`.

## Troubleshooting

**`slack` missing from the startup line.** `SLACK_APP_SIGNING_SECRET` is unset
or empty. It alone gates whether the integration is constructed.

**"Your URL didn't respond with the value of the challenge parameter".** The
server is down, the tunnel is not connected, or the public URL changed since the
app was created. Re-render the manifest and update both request URLs.

**The bot replies with a connect card every time.** The account link was not
written. Complete step 6, and check the tunnel is not serving an interstitial.

**The bot does nothing at all.** Confirm it is in the channel (`/invite`), and
that Event Subscriptions shows Verified.

**"No usable anthropic credential is configured".** See step 7 — the run needs
an organization-scoped API key, not a personal OAuth connection.
