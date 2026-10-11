# Starting a new project

This runbook takes a running Samskara deployment to a factory that accepts work:
a factory with its repositories linked, models connected, the default model and
memory models set, Slack routed to it, beads data readable, and the sandbox
checked. It ends with a checklist that proves a card moves from Intake to Done.

Run it once per project. The deployment itself comes first: the earlier
runbooks in [README.md](README.md) for local development, and
[deploy-coolify.md](deploy-coolify.md) for production.

Each step has a **Local** and a **Production** track where they differ. Steps
only a person can do are marked **HUMAN**. Each step ends with a **Verify**
line; do not move on until it holds.

Settings pages named below are in the Factory UI, under the factory's
**Settings** (`/factories/<factoryId>/settings/<page>`). The page names are the
ones `mastra` CLI 1.33.0 ships: **My account**, **Preferences**, **Manage
Factory**, **Connections**, **Repositories**, **Work Intake**, **Factory
models**, **Your models**, **Your memory**, **Factory memory**, **Skills** and
**Behavior**.

A `/web/...` route is called from a signed-in session, never with a bare
`curl`; see
[troubleshooting.md](../troubleshooting.md#calling-the-factory-api-by-hand).

## 0. Decide where the project lives

**Pick one environment per repository: local or production, never both.** This
is the owner's rule, and the beads integration is the reason: it is on by
default, every instance that links a repository writes that repository's beads
data, and two deployments never share a lease. Two instances linking one
repository are two automated writers. See
[environments.md](environments.md#one-environment-per-repository).

- **Local** — your own repositories and your own work. Runs on your machine
  while the dev server is up.
- **Production** — client work and anything other people depend on. Always on.

If a second instance must see a repository that another instance owns, set
`BEADS_INTEGRATION=0` on that instance.

Then decide how the factory maps to repositories. A factory can link more than
one repository; Mastra intends this (mastra-ai/mastra#25116, and the
[workshop at 55:00](https://www.youtube.com/watch?v=PS15AyJfFNg&t=3300)). In
`@mastra/factory` 0.20.0 a card in a multi-repository factory must name its
repository, or it stops with `source_repository_ambiguous` or "Choose a
repository for this work item" until a person picks one
(`dist/routes/surface.js:189`, `dist/rules/start-coordinator.js:88`):

- GitHub issue cards name it (`githubRepositoryId`,
  `dist/integrations/github/default-rules.js:56`), and so do beads cards
  (`metadata.repository`; see
  [operations/beads.md](../operations/beads.md#multi-repository-factories-the-card-names-its-repository));
- a card that names none, such as one created by hand without a repository,
  needs the pick.

One factory per repository avoids the pick entirely. Several repositories in
one factory give one board for all of them.

**Verify:** you can name the environment, the factory and the repositories, and
none of those repositories is linked in the other environment.

## 1. Prerequisites

| | Local | Production |
|---|---|---|
| Public address | A tunnel ([tunnel.md](tunnel.md)) | The server's domain |
| GitHub App | The local app ([github-app.md](github-app.md)) | The production app |
| Slack app (optional) | The local app ([slack-app.md](slack-app.md)) | The production app |
| Database | `MASTRA_DB_PATH` in `.env`, an absolute path under `data/`, directory created | Two Turso databases ([deploy-coolify.md](deploy-coolify.md#2-put-the-keys-in-it--human), [operations/turso.md](../operations/turso.md)) |
| Sandbox | `local` is acceptable for your own work | `FACTORY_SANDBOX_PROVIDER=e2b` with `E2B_API_KEY` |
| Mail | Optional | `RESEND_API_KEY` and `MAIL_FROM` ([operations/mail.md](../operations/mail.md)) |
| `bd` on the host | Install it, or set `BEADS_BD_PATH` | In the image (bd 1.3.1) |

Each environment has its own GitHub App and Slack app
([environments.md](environments.md)).

**Local, before the first `npm run dev`:** create `.env` from the example, set
`MASTRA_DB_PATH` in it to an absolute path under `data/`, and create that
folder (libSQL does not create it):

```bash
cp .env.example .env
mkdir data
# then edit .env:  MASTRA_DB_PATH=/absolute/path/to/samskara/data/samskara.db
```

**Verify:** the server's startup lines include `[integrations] github` (plus
`slack` if you use it, and `beads`), and the `[storage]` line names the
database you expect: `local file` locally, `turso remote (…)` in production.

## 2. Give the GitHub App access to the repositories — **HUMAN**

The app must be installed on every repository the factory will link.

1. **Check the app can reach the owning account.** The app is private
   (`public: false`, `scripts/create-github-app.mjs:123`), and GitHub lets a
   private app be installed only on the account that owns it. A repository in a
   client's organization, or in any organization other than the app's owner,
   cannot be installed on. Either create the app under that organization
   (`node scripts/create-github-app.mjs --org <login> ...`), or make the app
   public. See [github-app.md](github-app.md#installation-scope).
2. **Install it, or add the repository.** On the app's page, **Install App** and
   choose the account and repositories. For an existing installation, add the
   repository in the installation's settings on GitHub; the Factory's
   repository picker links there as **Add installations or grant access to more
   repositories**.
3. **Check the permissions** on the installation: Contents read and write
   (clone, push, and the beads write-back), Issues read and write, Pull requests
   read and write, Commit statuses read-only, Actions read-only (beads
   `gh:run` gates). If the app's permissions were
   changed after installing, accept the pending request on the installation.

**Sign in to the Factory first, in the same browser.** An installation becomes
visible to an organization only when GitHub redirects back to the Factory's
Setup URL / OAuth callback (`/auth/github/callback`) while you are signed in:
that route binds each of your installations to your signed-in organization
(`@mastra/factory` 0.20.0 `dist/integrations/github/routes.js:308-345`). An app
installed from a browser with no Factory session is not bound to any
organization. To bind it afterwards, start the connect flow again from the
Factory's repository picker while signed in.

**Verify:** `/web/github/status`, opened in a signed-in browser tab, shows the
installation. It lists only installations bound to your organization.

## 3. Create the factory and link repositories

1. **Create the factory — HUMAN.** The two paths have different steps (Mastra's
   UI bundle, `mastra/dist/factory/assets/index-BaghZlUk.js`):
   - **First factory: onboarding.** An organization with no factory is sent to
     `/onboarding`. Its steps are `initial`, `vcs`, `project-management`,
     `model-provider` and `personal-provider`. There is no name step: the
     `vcs` step says "select the repository that will become your first
     Factory", and the factory is created from that repository. Rename it
     afterwards under **Settings → Manage Factory**.
   - **Later factories: New Factory.** Its steps are `name`, `vcs`,
     `project-management` and `model-provider` ("Name your new Factory",
     "Choose your codebase", "Connect the work behind the code", "Choose your
     Factory model"). There is no personal-provider step.

   Only the project-management step has **Skip for now**. The model step has no
   skip control: it advances only once a model is saved. Read
   [step 4](#4-connect-models) before reaching it.
2. **Link the repositories — HUMAN.** In the wizard's source-control step, or
   later under **Settings → Repositories → Link repository**. Link only
   repositories decided in [step 0](#0-decide-where-the-project-lives). A
   repository can be added later the same way.

The Work board renders only once the factory has a linked repository: the UI
gates every board on one ([boards.md](../boards.md)).

**Verify:** the factory's Work board renders, with its phases from Intake to
Done, and **Settings → Repositories** lists exactly the repositories you
decided on.

## 4. Connect models

Two facts decide how:

- **Background runs need an organization-scoped credential.** Board runs,
  GitHub events and Slack messages run on factory sessions, which resolve
  credentials organization-first (`@mastra/code-sdk` 1.11.0
  `dist/agents/credential-resolver.js`, `isFactorySessionContext`). A
  connection scoped to one user is not what they can rely on.
- **Keys in the server's environment never reach tenant runs.**
  `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in `.env` or Infisical does nothing
  for them: the tenant credential store has `allowEnvironmentFallback = false`
  (`@mastra/factory` 0.20.0 `dist/routes/tenant-credentials.js:11`).

The organization credential is added under **Settings → Factory models →
Provider access**. That section's scope is fixed to the organization. It has
two tabs, **Sign in with a provider** and **Connect with API key**.
(**Settings → Your models** has the same section at user scope, for your own
interactive chats.)

**Local, single user — HUMAN.** Either tab is acceptable. A subscription
sign-in is acceptable here because the only work is your own; make it under
**Factory models**, so it is organization-scoped and background runs see it.

**Production and client organizations — HUMAN.** **Connect with API key** only.
A subscription sign-in connects one person's consumer account, and provider
terms may not permit using it for other people's work (owner policy,
`samskara-nn2`). Use the organization's own API key, billed to the
organization.

- **The onboarding model step cannot do this for Anthropic, OpenAI or xAI.**
  It shows those three only as **Continue with …** subscription sign-in
  buttons, and lists API keys only for providers without sign-in
  (`samskara-nn2`; Mastra's UI bundle, reported upstream). It also has no skip
  control. The path that works: the factory already exists once the
  repository step is done, so open `/factories/<factoryId>/settings/models` in
  another tab, add the key under **Factory models → Provider access → Connect
  with API key** (which lists the whole catalog), then return to the wizard
  tab, where the provider is now connected, and pick its model.
- **New Factory, for a second production project.** The organization's API key
  from the first project is already connected, so the model step just offers
  its models. Pick one and complete the step.
- Factory 0.20.0 has no setting that turns subscription sign-in off
  (`samskara-nn2`). The rule is kept by people, not enforced.

**Verify:** **Factory models → Provider access** shows the provider connected,
and the model pickers on the next two steps list its models.

## 5. Set the default model

Two separate defaults:

- **Factory default model** — **Settings → Factory models → Factory defaults →
  Factory default model**. Factory runs (triage, board work items) and channel
  sessions start on it; your personal default does not apply to them. It is
  stored on the factory (`defaultModelId`, `PATCH /web/factory/projects/:id`,
  `@mastra/factory` `dist/routes/contracts.js:31-38`). Changing it does not
  move sessions already running: the page then offers **Switch running
  sessions** or **Keep them as-is**, which calls
  `POST /web/factory/projects/:id/apply-default-model` (`contracts.js:270`).
- **Your default model** — **Settings → Your models → Your defaults → Default
  model**: the model your new chats start on. Stored per user
  (`PUT /web/config/default-model`, `dist/routes/config.js:581`).

Pick a model from the provider connected in step 4.

**Verify:** both pickers show the model you chose.

## 6. Set both memory model rows

Every run also calls the observational-memory models (observer and reflector),
which also write session titles. If their provider has no credential, memory and
titles fail with "No usable … credential" while chat keeps working.

The settings live in two rows of the `memory_settings` table:

- **Factory memory** — **Settings → Factory memory**. The factory-wide row,
  stored under `user_id` = `factory-project:<factoryId>`
  (`dist/storage/domains/memory-settings/base.js:10-12`). Board runs and Slack
  sessions read this one.
- **Your memory** — **Settings → Your memory**. Your own row, for your
  interactive chats.

Set the observer and reflector models on **both** pages, to models from the
provider connected in step 4. The API equivalent of the factory row, from a
signed-in session, is `PUT /web/config/om/observer/model` and
`PUT /web/config/om/reflector/model` with
`{"modelId": "<provider/model>", "factoryId": "<factoryId>"}`
(`dist/routes/config.js:783-825`).

**Verify:** after the first board run in step 11, the session has a generated
title rather than a placeholder.

## 7. Slack (optional)

1. **Link your account — HUMAN.** Open `<public URL>/connect/slack` and
   complete Sign in with Slack. Every person who will message the bot does this
   once ([slack-app.md](slack-app.md#6-link-your-slack-account-to-the-factory--human)).
2. **Set the default factory — HUMAN.** Channels do not map to factories; each
   linked account's runs go to its default factory
   (`dist/integrations/slack/slack.js:103-145`). Set it under **Settings →
   Connections → Slack → Session behavior → Default factory**.
   - A link with no default, in an organization with exactly one factory, gets
     that factory stamped as its default on its first message
     (`slack.js:128-141`; a stored default is used first, `:117-127`).
   - **Adding a factory does not move existing links.** A link already stamped
     with the first factory keeps sending its runs there, silently; no **Pick a
     default factory** card appears. Every linked person who should work in the
     new factory must change their **Default factory** explicitly.
   - A link with no default, in an organization with more than one factory,
     gets the **Pick a default factory** card, and the run does not start.
3. **Turn on cards, if wanted — HUMAN.** **Settings → Connections → Slack →
   Work items → Create work items for new Slack threads**, for this factory.
   It is off by default. With it off, threads still run, but no card appears.
4. **Invite the bot** to the channel (`/invite @Samskara`).

A Slack card is created at **Building** and skips Triage (`samskara-ylt`); see
[slack-app.md](slack-app.md#where-slack-work-lands).

**Verify:** a message mentioning the bot starts a session (and, with cards on,
a card appears at Building on this factory's Work board).

## 8. Beads readiness (per repository)

For each linked repository that uses beads:

1. **Its beads data is on `origin`.** In a clone: `bd init` if it has no beads
   database yet, then publish it with `bd dolt push --yes`. With no Dolt remote
   configured, `--yes` consents to adopting the repository's `origin` as the
   Dolt remote, and pushes (`bd dolt push --help`, bd 1.3.0). Do not run
   `bd dolt remote add origin <url>`: bd 1.3.0 refuses a Dolt remote whose URL
   matches the repository's origin unless `--allow-git-origin` is given. Push
   with `DOLT_REMOTE_INFO_BRANCH` set to empty, so Dolt does not create a
   `__dolt_remote_info__` branch on `origin` (on hosts that build every pushed
   branch, it can trigger a deploy). Dolt reads the variable with
   `os.LookupEnv` and trims it, so a value that is empty after trimming turns
   the branch off (Dolt `store/blobstore/git_refs.go:36-41`):

   ```bash
   DOLT_REMOTE_INFO_BRANCH= bd dolt push --yes                # POSIX shell
   ```

   ```powershell
   $env:DOLT_REMOTE_INFO_BRANCH=' '; bd dolt push --yes      # PowerShell
   ```

   PowerShell deletes a variable set to `''`, so it uses one space, which Dolt
   trims away. A persistent User-level variable holding one space works the
   same way. `refs/dolt/data` must then exist on `origin`.
2. **The host has `bd`.** Production: the image installs bd 1.3.1. Local:
   install bd, or set `BEADS_BD_PATH`.
3. **The integration is on.** The `[beads]` startup line says `on`, and
   `[integrations]` includes `beads`. It is on unless `BEADS_INTEGRATION` is
   `0`, `false`, `off` or `no`.
4. **Check the state.** `GET /web/beads/status`, from a signed-in session.
   - `ok` — synced.
   - `no-beads-data` — `origin` has no `refs/dolt/data`; do item 1. Re-checked
     every 15 minutes, or at once after a restart.
   - `error` — `reason` says why; the next tick retries.
   - `parked` — a write-back conflict; an organization admin resets it with
     `POST /web/beads/reset` and the body `{"repo": "owner/name"}` (without it
     the route answers 400 `repo_required`,
     `packages/factory-beads/src/integration.ts:1834`).

   Meanings and fixes: [operations/beads.md](../operations/beads.md#repository-states).

A ready bead becomes a card in **Intake** and waits there: a person moves it to
Triage to start it. A repository that does not use beads stays at
`no-beads-data`, which is not an error.

**Verify:** each beads repository shows `state: "ok"`, and its ready beads
appear as cards in Intake.

## 9. Sandbox check

- **Local.** `local` runs agent commands on your machine with the server's
  privileges. The startup lines say `[sandbox] provider=local` and the
  isolation backend; on Windows it is `isolation=none`, with no confinement at
  all ([README.md](../../README.md#-picking-a-sandbox)). Acceptable for your own
  repositories only.
- **Production.** `[sandbox] provider=e2b`. Start a session and run `hostname`:
  it prints `e2b.local`.

**Verify:** the provider line matches the environment, and in production
`hostname` prints `e2b.local`.

## 10. Team (production) — **HUMAN**

1. Rename the organization on the team page, `/web/samskara/team`: sign-up names
   it `<email>'s org`, and invitation emails show the name.
2. Confirm mail works: the startup line says `[mail] Resend configured`.
3. Invite members from the same page. See
   [operations/team-invites.md](../operations/team-invites.md).

**Verify:** an invited member receives the email, accepts it, and lands in this
organization.

## 11. Done checklist

Startup lines, in order (`src/mastra/index.ts`):

```
[auth] provider=MastraAuthBetterAuth
[mail] Resend configured — …                  (production; optional locally)
[storage] app=… vectors=…
[beads] on by default; set BEADS_INTEGRATION=0 to turn it off.
[integrations] github, slack, beads           (slack only if configured)
[sandbox] provider=e2b                        (production)
[sandbox] provider=local … / isolation=…      (local)
```

End to end, on this factory:

- [ ] A test issue (or a ready bead) appears in **Intake**.
- [ ] Moved to **Triage**, the triage skill runs and classifies it, and the card
      moves to **Planning**.
- [ ] Planning submits a plan, and a person approves it.
- [ ] Building opens a pull request on the right repository.
- [ ] The card reaches **Done** when the pull request merges.
- [ ] For a bead: the card's `beadsWriteback` is `synced`, and `bd show <id>` in
      a fresh pull of the repository shows the bead closed.
- [ ] The session has a generated title (step 6).
- [ ] The repository is linked in this environment only (step 0).
