# Creating the GitHub App

Samskara connects to repositories through a GitHub App you own. The app gives
signed-in users a way to install it, pick repositories, and turn each repository
into a Factory project.

Locally, complete [tunnel.md](tunnel.md) first. In production, use the
server's domain; no tunnel is needed. The app's URLs are built from
`MASTRACODE_PUBLIC_URL`, and changing that address later means editing the app.

Decide who owns the app before creating it. The script creates a **private**
app (`public: false`, `scripts/create-github-app.mjs:123`), and GitHub lets a
private app be installed only on the account that owns it. To link
repositories that belong to an organization, such as a client's, create the
app under that organization with `--org <login>` (you need permission to
create apps there), or make the app public. See
[Installation scope](#installation-scope).

Throughout, replace `https://samskara.example.com` with your own
`MASTRACODE_PUBLIC_URL`.

Create one app per environment — one for local development, one for
production. See [environments.md](environments.md).

## Use the script

`scripts/create-github-app.mjs` drives GitHub's app-manifest flow. It declares
the permissions, the webhook and all seven event subscriptions up front, so the
app is complete the moment it is created. One approval screen is the only manual
step.

```bash
# Confirm the public origin is set first — this is what the manifest is built from
node -e "console.log(process.env.MASTRACODE_PUBLIC_URL ?? '(unset — will use localhost)')"

node scripts/create-github-app.mjs
```

It prints what it is about to create, then serves a page on `localhost:4321`.
Open it, approve on GitHub, and the credentials are written to Infisical.

```
--org <login>            create under an organization instead of your account
--name <name>            app name (default: "Samskara Factory")
--factory-url <url>      public origin of the running Factory
--env-file               write credentials to .env instead of Infisical
--infisical-path <path>  Infisical folder (default: /samskara)
--infisical-env <env>    Infisical environment (default: dev)
```

**Run it with the tunnel address set.** GitHub rejects a manifest whose webhook
is not reachable from the public internet, so with a `localhost` origin the
script omits the webhook and the events — and then every one of them has to be
added by hand afterwards. It warns you when this is about to happen.

The private key is returned by GitHub exactly once. If the Infisical write
fails, the script falls back to `.env` and says so, rather than losing it. Move
it into your secret store and delete it from `.env`: an entry there shadows the
injected value.

The rest of this document is the manual equivalent — for fixing an existing app,
or when you would rather click.

## 1. Prepare the values

An agent can do this part.

Generate the webhook secret:

```bash
openssl rand -hex 32
```

This becomes `GITHUB_APP_WEBHOOK_SECRET`. It signs GitHub OAuth and install
state as well as verifying webhooks, so a configured GitHub integration needs it
even when webhooks are disabled.

The URLs to enter:

| Field | Value |
|-------|-------|
| Homepage URL | `https://samskara.example.com` |
| Callback URL | `https://samskara.example.com/auth/github/callback` |
| Setup URL | `https://samskara.example.com/auth/github/callback` |
| Webhook URL | `https://samskara.example.com/web/github/webhook` |

The callback URL is derived from `MASTRACODE_PUBLIC_URL` in code — there is no
separate environment variable for it. Enter the same URL in **both** the
Callback URL and Setup URL fields.

## 2. Create the app — **HUMAN**

Go to **Settings → Developer settings → GitHub Apps → New GitHub App**
(<https://github.com/settings/apps/new>), or the equivalent page under an
organization.

Fill in the URLs from the table above, then:

- Check **Request user authorization (OAuth) during installation**
- Check **Redirect on update**
- Under Webhook, check **Active** and paste the secret generated in step 1

### Permissions

**Repository permissions**

| Permission | Access | Why |
|------------|--------|-----|
| Contents | Read and write | clone repositories, push agent branches |
| Issues | Read and write | issue intake, posting comments |
| Pull requests | Read and write | open pull requests, read reviews |
| Commit statuses | Read-only | report check state on a work item |
| Actions | Read-only | beads `gh:run` gates: `bd gate check` reads the workflow run (docs/operations/beads.md) |
| Metadata | Read-only | mandatory, granted automatically |

**Account permissions:** none required.

This set is derived from the API calls the integration makes, not from a
published manifest. If an operation fails with a 403, widen the matching
permission and reinstall the app — GitHub requires existing installations to
approve new permissions.

### Subscribe to events

The webhook handler dispatches on these, verified in
`@mastra/factory/dist/integrations/github/webhook.js`:

- Issues
- Issue comment
- Pull request
- Pull request review
- Pull request review comment
- Push
- Status

Other events are accepted and ignored.

**GitHub only offers an event when the permission behind it is granted.**
`Status` does not appear in the list at all without `Commit statuses:
Read-only`, which is easy to read as the event being missing. If an event you
expect is absent, the permission above it is the reason. Grant it, save, and the
event becomes selectable.

Changing permissions on an app that is already installed puts the change in a
pending state until the installation accepts it. Accept the prompt, or events
still will not arrive.

### Installation scope

**Only on this account** makes the app private: it can be installed only on the
account that owns it (the script's default). An app owned by your personal
account cannot then reach repositories in an organization, and an app owned by
one organization cannot reach another's.

- Repositories in one organization: create the app under that organization
  (`--org <login>` with the script, or the organization's **Developer
  settings**), and keep it private.
- Repositories across several accounts, such as several clients: either one
  app per owning account, or choose **Any account** to make it public, so each
  owner can install it.

## 3. Collect the credentials — **HUMAN**

After creating the app, on its settings page:

- **App ID** — shown at the top → `GITHUB_APP_ID`
- **Client ID** — shown at the top → `GITHUB_APP_CLIENT_ID`
- **Client secret** — press "Generate a new client secret" →
  `GITHUB_APP_CLIENT_SECRET`
- **Private key** — press "Generate a private key". A `.pem` file downloads.
  → `GITHUB_APP_PRIVATE_KEY`
- **Slug** — the last path segment of the app's public page URL
  (`https://github.com/apps/<slug>`) → `GITHUB_APP_SLUG`

The private key is shown once. If you lose it, generate another.

## 4. Store the credentials

Paste each value into the Infisical `samskara` folder — see
[secrets-infisical.md](secrets-infisical.md). The placeholder keys already exist.

`GITHUB_APP_PRIVATE_KEY` is the **contents** of the PEM file, not a path, with
newlines escaped as `\n`:

```
-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----
```

To convert the downloaded file without printing it:

```bash
node -e "const k=require('fs').readFileSync(process.argv[1],'utf8').trim().replace(/\n/g,'\\\\n'); require('fs').writeFileSync('key.oneline.txt', k); console.log('wrote key.oneline.txt,', k.length, 'chars')" your-app.private-key.pem
```

Copy from `key.oneline.txt` into the Infisical UI, then delete both that file
and the `.pem`.

## 5. Install the app — **HUMAN**

On the app's page, press **Install App**, choose the account, and select which
repositories to grant. You can change this later: the installation's settings
on GitHub add or remove repositories, and the Factory's repository picker links
**Add installations or grant access to more repositories** there.

Installing the app grants access; it does not put a repository on a board. A
repository is linked to a factory in the Factory UI, which
[new-project.md](new-project.md#3-create-the-factory-and-link-repositories)
covers, together with the caveats for a factory with more than one repository.

## 6. Verify

Restart Samskara. The startup lines list active integrations and the beads
state (`src/mastra/index.ts:480-514`):

```
[beads] on by default; set BEADS_INTEGRATION=0 to turn it off.
[integrations] github, slack, beads
```

`slack` appears only when Slack is configured, and `beads` only while the
integration is on.

Then sign in and check that repositories appear when linking one to a factory.
The status endpoint reports what the server sees. It needs a signed-in session
(the Factory gate answers a bare request with 401, `@mastra/factory`
`dist/auth.js:540-560`), so open it in a signed-in browser tab:

```
https://samskara.example.com/web/github/status
```

## Troubleshooting

**`github` missing from the startup line.** One of the five required
`GITHUB_APP_*` variables (`ID`, `PRIVATE_KEY`, `CLIENT_ID`, `CLIENT_SECRET`,
`SLUG`; `src/mastra/index.ts:188-189`) is unset or empty.
`GITHUB_APP_WEBHOOK_SECRET` is not required to construct the integration
(`:196`), but without it every webhook delivery is rejected with 401
(`@mastra/factory` `dist/integrations/github/webhook.js:27-34`). An empty value in `.env` shadows the
one injected from Infisical — delete the line rather than leaving it blank.

**The account you want is not offered when installing.** The app is private
and owned by a different account. See [Installation scope](#installation-scope).

**Webhook deliveries failing.** The app's Advanced tab shows every delivery with
its response. A 401 means `GITHUB_APP_WEBHOOK_SECRET` does not match the secret
entered in the app. A timeout means the tunnel is not reaching the server.

**The install completes but no repositories appear.** The callback URL or Setup
URL is wrong, or `MASTRACODE_PUBLIC_URL` does not match what the app has. Both
fields must hold the same URL.

**Private key errors on startup.** The PEM was stored with literal newlines
rather than `\n`, or with surrounding quotes that became part of the value.
