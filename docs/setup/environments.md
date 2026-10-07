# Local development and production

Run Samskara in two places: on your own machine while you work on it, and on a
server for the people who use it. Each place needs its **own** GitHub App and
its **own** Slack app. Do not share one app between them.

## Why one app per environment

A GitHub App and a Slack app each store exactly one public address. GitHub sends
its OAuth callback, install redirect and webhooks there; Slack sends every event
and interaction there. An app shared between your machine and your server points
at only one of them, so:

- connecting GitHub from your machine sends you back to the server, not to the
  Factory you started from;
- the server receives events meant for your machine, and the other way round —
  a test message on your machine can start a run in production;
- rotating a key for one breaks the other.

With one app per environment, each one talks only to its own Factory.

## What differs

| | Local development | Production (VPS) |
|---|---|---|
| Public address | A tunnel hostname, e.g. `https://samskara-dev.example.com` ([tunnel.md](tunnel.md)) | Your domain, e.g. `https://samskara.example.com` |
| `MASTRACODE_PUBLIC_URL` | The tunnel hostname | The domain |
| GitHub App | "Samskara Dev", URLs on the tunnel hostname | "Samskara", URLs on the domain |
| Slack app | "Samskara Dev", request URLs on the tunnel hostname | "Samskara", request URLs on the domain |
| Secrets | Infisical `dev` environment | Infisical `prod` environment, read by the container at start |
| Database | Local libSQL file under `data/` | Turso (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`) |
| Sandbox | `local` is acceptable for your own work | `e2b` — never run client work on the host |
| Started by | `npm run dev:secure` | The Docker image (for example, deployed by Coolify) |

The two environments never share a key. Each app's credentials live only in the
environment that uses it.

## Creating the apps

Create each app twice: once with the local address and the `dev` environment,
once with the production address and the `prod` environment. The runbooks
[github-app.md](github-app.md) and [slack-app.md](slack-app.md) cover each step;
the only differences are the name, the address and where the keys go.

### GitHub App

```bash
# Local development
node scripts/create-github-app.mjs --name "Samskara Dev" \
  --factory-url https://samskara-dev.example.com \
  --infisical-env dev --infisical-path /samskara

# Production
node scripts/create-github-app.mjs --name "Samskara" \
  --factory-url https://samskara.example.com \
  --infisical-env prod --infisical-path /samskara
```

GitHub app names are unique across all of GitHub, so pick names nobody else has
taken. The script writes the credentials straight to the Infisical environment
you name, and prints only their names and lengths.

The script writes to whichever project `.infisical.json` links; it has no
project flag. A server that follows [deploy-coolify.md](deploy-coolify.md) reads
from its own project, so for production either run the script from a checkout
linked to that project, or move the keys into it afterwards by reference. Never
copy values through a terminal.

### Slack app

```bash
# Local development
node scripts/render-slack-manifest.mjs --url https://samskara-dev.example.com

# Production
node scripts/render-slack-manifest.mjs --url https://samskara.example.com
```

Before clicking **Create** on Slack's form, change `name` and `display_name` in
the manifest for the local app (for example, to "Samskara Dev"), so the two bots
are easy to tell apart in Slack. Paste each app's credentials into its own
Infisical environment, as [slack-app.md](slack-app.md) describes.

## Windows: run the scripts from PowerShell, or disable path conversion

Git Bash rewrites any argument that starts with `/` into a Windows path, so
`--infisical-path /samskara` arrives as `C:/Program Files/Git/samskara` and the
keys go to the wrong folder. The GitHub App script prints its destination on the
`Secrets` line before anything is created; check it.

Run the scripts from PowerShell, or prefix the command in Git Bash:

```bash
MSYS_NO_PATHCONV=1 node scripts/create-github-app.mjs ...
```

## Checking which app an environment uses

Compare the app ID and a fingerprint of the key, never the key itself:

```bash
infisical run --env=dev --path=/samskara --silent -- node -e "
  const f = (v) => v ? require('crypto').createHash('sha256').update(v).digest('hex').slice(0, 8) : 'unset';
  console.log(process.env.GITHUB_APP_SLUG, process.env.GITHUB_APP_ID, f(process.env.GITHUB_APP_PRIVATE_KEY));
"
```

Run it once per environment. The slugs and IDs must differ, and so must the
fingerprints.
