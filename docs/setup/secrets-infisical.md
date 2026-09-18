# Secrets with Infisical

Samskara reads about twenty environment variables, most of them secret. This
runbook puts them in [Infisical](https://infisical.com) and injects them at
runtime, so no secret value is ever written to a file in the repo or typed on a
command line.

The split of work:

- **An agent** installs the CLI, links the project, and creates every key with a
  placeholder value.
- **A human** creates the account, authenticates in a browser, and pastes the
  real values into the web UI.

Real secret values only ever move between your password manager and your
browser. They do not pass through a shell, a log, or an agent's context.

## 1. Create an account — **HUMAN**

Sign up at <https://infisical.com> and create a project. Name it whatever you
like; this runbook assumes a folder named `samskara` inside it.

An agent must not create accounts or enter passwords. Stop here and hand back.

## 2. Install the CLI

```bash
# Windows
winget install infisical

# macOS
brew install infisical/get-cli/infisical

# Debian / Ubuntu
curl -1sLf 'https://artifacts-cli.infisical.com/setup.deb.sh' | sudo -E bash
sudo apt-get update && sudo apt-get install -y infisical

# RHEL / CentOS
curl -1sLf 'https://artifacts-cli.infisical.com/setup.rpm.sh' | sudo -E bash
sudo yum install infisical
```

Confirm before continuing:

```bash
infisical --version
```

## 3. Log in — **HUMAN**

```bash
infisical login
```

This opens a browser and asks for credentials. An agent must not run it.

## 4. Link the repo to the project

```bash
infisical init
```

Writes `.infisical.json` in the repo root, recording which Infisical project
this directory belongs to. It is safe to commit — it holds identifiers, not
secrets.

## 5. Create the folder and the placeholder keys

```bash
infisical secrets folders create --name samskara --env dev

infisical secrets set --file scripts/secrets-template.env --path=/samskara --env=dev
```

`scripts/secrets-template.env` lists exactly the variables `src/mastra/index.ts`
reads, each set to `PASTE_ME`. Creating them all up front means the human only
has to fill in values, not work out which names are needed.

Two of them should be generated rather than pasted, and an agent can do that:

```bash
# BETTER_AUTH_SECRET and FACTORY_CREDENTIAL_ENCRYPTION_KEY
openssl rand -base64 32
```

```powershell
# PowerShell equivalent
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Max 256 }))
```

## 6. Paste the real values — **HUMAN**

Open the project in the Infisical web UI, go to the `samskara` folder, and
replace each `PASTE_ME`.

Do this in the browser rather than through the CLI. `infisical secrets set`
takes a value only as a command-line argument or from a file — there is no stdin
input — so using it for a real secret writes that secret into your shell
history.

Leave any variable you are not using at `PASTE_ME` or delete the key. An unused
key with a placeholder value is harmless; the code checks for the specific
values it needs.

## 7. Run with secrets injected

```bash
infisical run --path=/samskara --env=dev --silent -- npm run dev
```

This is what `npm run dev:secure` does.

## Verifying without exposing anything

To confirm which variables arrived, print their **names**:

```bash
infisical run --path=/samskara --env=dev --silent -- \
  node -e "console.log(Object.keys(process.env).filter(k=>/TURSO|SLACK|GITHUB|E2B|BETTER_AUTH|FACTORY_CRED/.test(k)).sort().join('\n'))"
```

To confirm a specific value is present and plausible without revealing it, print
its type, length and first few characters — never the whole thing.

## Rules

These are not style preferences. Each one has caused a real failure.

**Never run `infisical secrets get` or `infisical export`.** Both print secret
values to the terminal, where they land in scrollback, logs, and an agent's
context. Use `infisical run` to inject instead.

**Never pass `--recursive`.** It injects every folder in the project, not just
this one, so a process started for Samskara receives unrelated credentials.

**On Windows, run Infisical from PowerShell, not Git Bash.** Git Bash rewrites a
leading-slash argument into a Windows path, so `--path=/samskara` silently
becomes something else and the command targets the wrong folder without error.

**An empty key in `.env` shadows the injected value.** `SLACK_APP_BOT_TOKEN=`
with nothing after it is a defined-but-empty variable, and the code reads it as
"configured, but blank". If a key lives in Infisical, delete the line from
`.env` — do not leave it blank.

**`secrets set` defaults to `shared`; `secrets delete` defaults to `personal`.**
Deleting a shared secret without `--type shared` returns "Secret not found",
which reads like the secret is already gone when it is not.

## Which variables are secret

From `scripts/secrets-template.env`:

| Variable | Needed when | Source |
|----------|-------------|--------|
| `BETTER_AUTH_SECRET` | always | generate |
| `FACTORY_CREDENTIAL_ENCRYPTION_KEY` | always | generate |
| `FACTORY_CREDENTIAL_ENCRYPTION_KEY_ID` | always | any label, e.g. `v1` |
| `E2B_API_KEY` | sandbox provider is `e2b` | E2B dashboard |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | anything beyond one machine | Turso |
| `GITHUB_APP_*` | GitHub intake | [github-app.md](github-app.md) |
| `SLACK_APP_*` | Slack intake | [slack-app.md](slack-app.md) |

Non-secret settings — `MASTRACODE_PUBLIC_URL`, `MASTRA_DB_PATH`,
`FACTORY_SANDBOX_PROVIDER` — stay in `.env`.

## Rotating a key

`FACTORY_CREDENTIAL_ENCRYPTION_KEY` encrypts stored provider credentials. To
rotate it without invalidating what is already stored, move the old value into
`FACTORY_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS`, set the new value, and bump
`FACTORY_CREDENTIAL_ENCRYPTION_KEY_ID`. See the comments in `.env`.
