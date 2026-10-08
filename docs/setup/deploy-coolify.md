# Deploying to a server with Coolify

This runbook takes Samskara from the repository to a public HTTPS address on a
server you control, using [Coolify](https://coolify.io) to build and run the
`Dockerfile`. Any Docker host works the same way; only the Coolify settings in
step 5 are specific to it.

Steps only a human can do are marked **HUMAN**, as in the other runbooks.

## How the container gets its configuration

The image boots under `infisical run`. At start-up `scripts/docker-entrypoint.sh`
logs in to Infisical with a machine identity, checks that enough keys came back,
and starts the server with them injected. So:

- **Infisical holds every setting**, secret or not. The image ships no `.env`
  (`.dockerignore` excludes it), so a value that is in your local `.env` but not
  in Infisical does not exist in production.
- **Coolify holds two values only**: the machine identity's client id and
  client secret.

The entrypoint refuses to start when Infisical returns fewer keys than
`INFISICAL_MIN_SECRETS`. A wrongly scoped identity does not fail on its own: it
returns zero keys, and the server would then boot on whatever the platform
happens to provide.

## What you need first

- A server running Coolify, and a domain you can add DNS records to.
- The production [GitHub App](github-app.md) and, if you use Slack, the
  production [Slack app](slack-app.md). Read [environments.md](environments.md):
  production gets its own apps, separate from your local ones.
- Two [Turso](https://turso.tech) databases: one for the app, one for vectors.
  The container's disk does not survive a redeploy, so a local libSQL file is
  not an option in production. Choose the region by measuring it for stalls
  from the server, not by distance alone: `aws-us-west-2` stalled about 1s
  every 6s on every connection, and production uses `aws-us-east-1`. See
  [operations/turso.md](../operations/turso.md).
- An [E2B](https://e2b.dev) API key. Agent commands run in the sandbox, and the
  host sandbox must never serve clients.
- A [Resend](https://resend.com) API key and a verified sending address, for
  invitations and password reset. See [operations/mail.md](../operations/mail.md).

## 1. Create an Infisical project for the server — **HUMAN**

Use a project that holds only what the server needs, not the project your
laptop uses. On Infisical's free plan an identity's access covers a whole
project; there are no folder-scoped roles. A separate project is the only way to
stop a leaked server credential from reaching your other keys.

Create the project with a `prod` environment and a `/samskara` folder.

## 2. Put the keys in it — **HUMAN**

The secrets are the ones in [secrets-infisical.md](secrets-infisical.md#which-variables-are-secret).
Generate fresh values for `BETTER_AUTH_SECRET` and
`FACTORY_CREDENTIAL_ENCRYPTION_KEY`. Do not reuse your development values.

The four Turso keys are `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`,
`TURSO_VECTOR_DATABASE_URL` and `TURSO_VECTOR_AUTH_TOKEN`. Create both databases
in a group whose region passed the stall check in
[operations/turso.md](../operations/turso.md#measuring-a-region-before-using-it),
and mint tokens with no expiry.

Production also needs these settings in the same folder, because there is no
`.env` to hold them:

| Variable | Value |
|---|---|
| `MASTRACODE_PUBLIC_URL` | `https://samskara.example.com`. Sign-in, invitation links and OAuth callbacks are built from it. |
| `FACTORY_SANDBOX_PROVIDER` | `e2b`. An explicit provider with missing credentials stops the server, and never falls back to the host. |
| `MAIL_FROM` | The verified sender, for example `Samskara <noreply@example.com>`. |

Count the keys. The image's floor is 12 (`INFISICAL_MIN_SECRETS` in the
`Dockerfile`), which a complete set clears with room to spare.

## 3. Create a machine identity — **HUMAN**

In Infisical, create an identity with **Universal Auth** and give it the
**viewer** role on the server project only. Record the client id and create a
client secret. These two values are the only secret Coolify will hold.

To check the scope without printing anything, put a throwaway secret in another
project and confirm the identity cannot read it.

## 4. Point the image at your project

The `Dockerfile` bakes in which Infisical project the container reads:

```dockerfile
ENV INFISICAL_PROJECT_ID=56fe6a1e-69bf-487d-b885-3ac9851e2f1f
ENV INFISICAL_ENVIRONMENT=prod
ENV INFISICAL_SECRET_PATH=/samskara
ENV INFISICAL_MIN_SECRETS=12
```

These are identifiers, not secrets. The project id is Otaku Solutions'. Deploying
your own instance, override `INFISICAL_PROJECT_ID` in Coolify's environment
variables (a runtime variable overrides an image `ENV`), or change the line in
your fork. Override the other three only if your folder or environment differs.

## 5. Create the Coolify application — **HUMAN**

| Setting | Value |
|---|---|
| Source | Your GitHub repository, branch `main` |
| Build pack | Dockerfile, base directory `/` |
| Domain | `https://samskara.example.com` |
| Exposed port | `4111` |
| Health check | Off in Coolify. The image has its own `HEALTHCHECK` on `/auth/me`, with a 120-second start period. |
| Environment variables | `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` and `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET` |
| Stop grace period | 15 seconds or more |

**The two identity values must be runtime-only.** Clear Coolify's build-time
option on both. A build variable is passed as a build argument, and build
arguments can end up in the image history.

**The stop grace period must be at least 15 seconds.** On SIGTERM, Mastra drains
in-flight requests for up to 5 seconds, then gives running workflows another
5 seconds before it exits (`drainTimeout`, default 5000, in
`@mastra/core` `dist/server/types.d.ts`). That is exactly Docker's default
10-second grace, so any delay is cut short with SIGKILL. Coolify's own default
is 30 seconds. On a plain Docker host, pass `docker run --stop-timeout 15`.

## 6. Point DNS at the server

Add an `A` record for the domain to the server's IP address. If the zone is on
Cloudflare, leave it **DNS only** (unproxied), so Coolify's proxy gets the Let's
Encrypt certificate itself.

If the first deploy ran before DNS pointed at the server, the proxy serves its
own default certificate. Restart the application after DNS resolves and it
requests a real one.

## 7. Deploy and check the log

A healthy boot logs, in order:

```
[entrypoint] authenticated (token length …)
[entrypoint] Infisical returned 22 secrets from prod:/samskara
INF Injecting 22 Infisical secrets into your application process
```

followed by the server's own lines, including one listing the integrations it
started (`github`, `slack`). Then:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://samskara.example.com/auth/me
```

returns `200`.

If the entrypoint stops with `FATAL: Infisical returned 0 secrets`, the identity
cannot read the folder. Fix its role in Infisical and restart. No redeploy is
needed.

## 8. First sign-in

1. Sign up at the domain. The first account creates its organization.
2. Add a model provider under **Settings > Models** with an **API key scoped to
   the organization**, not OAuth. See
   [README.md](README.md#connect-model-providers-with-an-api-key-not-oauth).
3. Set the memory model to a provider that key covers. See
   [slack-app.md](slack-app.md#the-memory-model-needs-that-key-too).
4. Connect GitHub from the Factory. This installs your production GitHub App on
   your account.
5. Invite teammates from `/web/samskara/team`. See
   [operations/team-invites.md](../operations/team-invites.md).

To confirm agent runs use E2B, start a session and run `hostname`. It prints
`e2b.local`.

## Rolling back

- **Configuration.** Remove the two identity variables in Coolify and restart.
  The entrypoint then boots on Coolify's environment alone, with no Infisical.
  Use this only to recover, with the settings temporarily in Coolify.
- **Code.** Redeploy an earlier commit from Coolify's deployment list.
- **DNS.** Put the previous record back.

## Backups and upgrades

The data lives in Turso, not in the container. Back it up with Turso's tooling.
See [operations/backup-and-restore.md](../operations/backup-and-restore.md).

With automatic deploys on, every merge to `main` rebuilds and redeploys. Read
[operations/upgrading.md](../operations/upgrading.md) before merging a Mastra
version bump.
