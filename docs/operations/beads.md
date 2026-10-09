# Beads integration

Ready beads (`bd`) in each linked GitHub repository become cards on the Work
board. When a card reaches Done, the integration closes its bead and publishes
the change to the repository's `refs/dolt/data`. Tracked in beads
`samskara-iz6`.

beads owns the graph and Factory owns the lane. Order comes from `bd ready`: a
bead that another open bead blocks is not ready, so its card appears only after
the blocker is closed. Factory has no dependency model of its own, and the
integration does not add one.

It is **on by default**. `BEADS_INTEGRATION=0` (or `false`, `off` or `no`, any
case) turns it off; any other value, or no value, leaves it on (samskara-iz6.8,
`packages/factory-beads/src/setting.ts:6`). Startup prints one line that says
which, and how to turn it off (`setting.ts:25-32`):

```
[beads] on by default; set BEADS_INTEGRATION=0 to turn it off.
[beads] on (BEADS_INTEGRATION is set); set BEADS_INTEGRATION=0 to turn it off.
[beads] off (BEADS_INTEGRATION is set to turn it off).
[beads] on by default, but the GitHub App is not configured, so the integration is idle. Set BEADS_INTEGRATION=0 to turn it off.
```

**One environment per repository.** Every instance with this integration on is
an automated writer for each repository it links. Never link a repository to
both a local and a production Factory; see
[setup/environments.md](../setup/environments.md#one-environment-per-repository)
and [Single writer](#single-writer).

Code:

- Package: `packages/factory-beads` (`@samskara/factory-beads`), a workspace
  package. It is not published to npm.
- Wiring: `src/mastra/index.ts:469-501` (the switch, construction and the
  `integrations` list; the switch is `beadsSetting` in
  `packages/factory-beads/src/setting.ts`), Done rule at `src/mastra/boards/requests-board.ts:63-69`.
- Image: the `bd-cli` stage of the `Dockerfile`.

## What it does

Each tick, for every repository linked to a Factory project through the GitHub
App:

0. **Does origin have beads data?** `git ls-remote --exit-code <clone url>
   refs/dolt/data`, with the App token. Exit 2 means no such ref: the
   repository does not publish beads data, so it gets the state
   `no-beads-data` and nothing else runs for it (see
   [Repository states](#repository-states)). This runs every tick for a
   repository that has the ref, so a ref deleted on origin, or a copy
   bootstrapped before this check existed, is caught too
   (`packages/factory-beads/src/integration.ts:535-553`).
1. **Bootstrap, first time only.** `git clone --depth 1`, then
   `bd --sandbox bootstrap --yes`, in `<BEADS_CACHE_DIR>/<owner>__<name>`. A
   marker file in `.git/` records that the copy is ready. The copy is kept
   between ticks and rebuilt after a restart (about 10 s per repository).
2. **Write-back.** For every beads card in the Done phase that has not been
   published yet: `bd --sandbox --actor factory-beads close <id> --reason
   "Factory card <card id> reached done"`, then `bd sync`
   (`packages/factory-beads/src/integration.ts:559-625`). bd refuses to close
   a bead assigned to anyone but the closing actor, so a bead someone holds is
   first handed over with `bd update <id> --assignee=factory-beads
   --if-assignee=<holder>` (`repo.ts`, `BdRepo.close`). That swap fails with
   exit 13 if the holder changed in between.
   - **A live claim does not stop it.** The swap also takes over a bead
     someone claimed (`in_progress`), which a plain reassign refuses without
     `--force`. This is the owner's decision (2026-10-09): a card reaching
     Done closes its bead even while someone holds a claim.
   - **Every other refusal does.** The integration never passes `--force`, so
     bd still refuses to close a pinned bead, an open gate, a bead with open
     children or open blockers. When it does, the bead is swapped back to its
     holder, and the card's diagnostic says so.
3. **Pull.** If there was nothing to write back, `bd dolt pull`.
4. **Intake.** `bd --readonly ready --json --exclude-type=epic -n 0`, then one
   card per bead, and the bead's description as one comment on the card's feed
   (`integration.ts:651-696`). See [What the agent sees](#what-the-agent-sees).

A project connection whose GitHub installation no longer exists (an orphaned
link, samskara-1ra) is skipped with one warning per connection, and the other
links still sweep. `connections.list` returns such a connection, but
`projectRepositories.list` throws `SourceControlConnectionNotFoundError` for it
(`@mastra/factory` 0.20.0 `dist/storage/domains/source-control/base.js:306-309`,
`:510-515`), so the integration first checks it with `connections.get`, which
applies the same test and returns `null`.

Epics are excluded because `bd ready` lists an unblocked epic beside its first
child. Epics are containers, not work.

### Startup preconditions

Two things cannot change while the server runs. Each is checked once, at the
first tick, and a failure logs **one** line and leaves the integration idle
(`#checkPreconditions`, `integration.ts:238-255`). Nothing is synced until the
server restarts; `GET /web/beads/status` shows `state: 'idle'` and the reason.

| Precondition | Log line |
|--------------|----------|
| The GitHub App is configured | Samskara does not construct the integration at all; the startup line says `[beads] on by default, but the GitHub App is not configured, so the integration is idle. Set BEADS_INTEGRATION=0 to turn it off.` The package logs `integration idle: source control "github" has no versionControl capability` if it is constructed without one. |
| `bd` can be started | `[factory-beads] integration idle: bd binary not found ("bd"; set BEADS_BD_PATH or put bd on PATH): spawn bd ENOENT. Nothing is synced; restart after fixing it.` The check runs `bd --version`; only "could not start" (the runner's exit 127) idles. |

### Repository states

`GET /web/beads/status` lists each linked repository with one of these states
and `checkedAt`, when it was last checked:

| State | Meaning | Logged |
|-------|---------|--------|
| `ok` | Synced this tick. | No |
| `no-beads-data` | origin has no `refs/dolt/data`, so the repository does not use beads, or has not pushed its beads data yet. Not an error. Nothing is cloned or bootstrapped, and a copy left from before is deleted, because a copy bootstrapped without beads data has no remote and every `bd dolt pull` fails with `no remote`. origin is checked again every 15 minutes (`remoteCheckIntervalMs`); in between, the tick does not contact GitHub for that repository. `nextCheckAt` says when. | One info line when a repository enters the state, and one when `refs/dolt/data` appears. Never a warning. |
| `error` | This tick failed for the repository: `git ls-remote` failed (auth, network), or clone, bootstrap, pull, close or sync failed. `reason` says why; the token is removed from it. The next tick tries again. | `sweep finished with problems` |
| `parked` | A write-back conflict (`bd sync` exit 2 or 4). Nothing runs for the repository until an operator resets it; see [Write-back failures](#write-back-failures). | `sweep finished with problems` |

To make a `no-beads-data` repository a beads repository, push its beads data
with `bd dolt push --yes` (see the [per-repository checklist](#setup)). The
next re-check, at most 15 minutes later, bootstraps it.
Restarting the server re-checks at once.

### Cards

| Field | Value |
|-------|-------|
| `board` | the board passed in (Samskara: `requestsBoard.id`, which is `work`) |
| `stages` | the board's initial phase |
| `externalSource` | `{ integrationId: 'beads', type: 'issue', externalId: <bead id> }` |
| `claimKey` | `beads:<owner/name>:<bead id>` |
| `title` | `<bead id>: <bead title>` |
| `metadata` | `repository` (`<owner/name>`), `beadsId`, `beadsRepo`, `beadsType`, `beadsPriority`, plus write-back state |

Intake is idempotent. Before creating a card the integration looks it up by
external source (`WorkItemsStorage.getByProjectSource`,
`@mastra/factory` 0.20.0 `dist/storage/domains/work-items/base.d.ts:562`). The
claim key is unique per organization (`base.d.ts:395-400`), so when two projects
link the same repository, only the first project gets the card. A canceled card
is not created again, because its external source still matches.

Cards are created with `workItems.upsert` and not with a rule decision.
`upsertLinkedWorkItem.source` accepts a fixed list of sources
(`dist/rules/types.d.ts:2`), so a decision cannot set `integrationId: 'beads'`.
`upsert` is the call that `POST /web/factory/projects/:id/work-items` makes, and
it accepts any external source. A card with an unknown source classifies as
`manual` (`rules/types.d.ts:12`), so the board's `manual` rules apply to it.

### Multi-repository factories: the card names its repository

One factory can link several repositories. Mastra intends this: in a Mastra
workshop, Abhi Aiyer (CTO) describes one factory holding all of a team's
repositories as a supported option beside one factory per repository
([workshop, 55:00](https://www.youtube.com/watch?v=PS15AyJfFNg&t=3300)), and
mastra-ai/mastra#25116 added the repository picker and the stop for a card
whose repository is ambiguous.

`@mastra/factory` 0.20.0 picks a card's repository with
`resolveWorkItemRepository` (`dist/session/work-item-repository.js:3-87`),
called by dispatch (`dist/routes/surface.js:159`) and by the session start
(`dist/rules/start-coordinator.js:80`). It reads, in order:

1. `metadata.repository`, a string compared with `===` against the `slug`
   (`owner/name`, case-sensitive) of every repository linked to the card's
   project (`:31`, `:36-46`). No match is `unlinked`; it does not fall back.
2. `metadata.githubRepositoryId` or `metadata.gitlabProjectId`, compared with
   the repository's `externalId` (`:32-33`, `:47-58`).
3. A Linear project mapping (`:34-35`, `:59-69`).
4. Otherwise the single linked repository, or `ambiguous` with two or more
   (`:70-86`). Ambiguous stops the card with "Choose a repository for this
   work item" (`start-coordinator.js:88`) or "Choose one of the linked
   repositories" (`surface.js:189`).

Every beads card therefore sets `metadata.repository` to its repository's
slug, taken from the same source-control `repositories` row the resolver
reads, so it always matches. `beadsRepo` stays: the integration's own lookups
use it. Cards made before this field are back-filled on the next sweep:
each sweep updates any beads card of a repository whose `metadata.repository`
is not that repository's slug. `workItems.update` merges metadata
(`dist/storage/domains/work-items/base.js:379-382`), so only that key changes.
The integration owns the key on its cards: a value set by hand is
overwritten, because a bead belongs to its repository and is closed there.

`githubRepositoryId` is not used: the GitHub integration's rules key on it
(`dist/integrations/github/rules.js:100`, `acceptance-labels.js:12`) and would
treat a beads card as a GitHub issue.

### What the agent sees

A Factory work item has no description field. The plan skill gets the card's
URL or, when it has none, its title (`@mastra/factory` 0.20.0
`dist/boards/work.js:102-108`), and beads cards have no URL. So the card title
alone, `<bead id>: <bead title>`, is all the kickoff carries.

The bead's **description** reaches the agent through the card's feed. Every
`invokeSkill` kickoff (triage, plan, build) has the card's recent comments
appended as a `<work-item-feed>` block (`dist/rules/dispatcher.js:635-639`,
reader wired at `dist/factory.js:686`). The integration posts the description
as one comment through `IntegrationContext.feed.createComment`
(`dist/integrations/base.d.ts:94-95`, given to workers at
`dist/factory.js:847`), the same call Slack uses to ingest thread asides
(`dist/integrations/slack/slack.js:712-718`). Code:
`packages/factory-beads/src/integration.ts`, `#postDescription`.

| Field | Value |
|-------|-------|
| `author` | `{ kind: 'integration', id: 'integration:beads', displayName: 'beads' }` |
| `externalSource` | `{ integrationId: 'beads', type: 'description', externalId: <bead id> }` |
| `body` | the description as it is in beads |
| `occurredAt` | the card's `createdAt`, so the description reads first, like an issue body, and a back-filled comment does not bump the card's feed activity |

Only the description is posted. Design, acceptance criteria and notes are not.
To get the description, intake runs `bd ready` without `--brief`: in bd 1.3.0
`--brief` omits description, design, acceptance criteria and notes
(`bd ready --help`). bd leaves an empty description out of the JSON row, and a
bead with an empty or whitespace-only description gets no comment.

**Idempotent.** The comment store returns the existing row when a comment with
the same `externalSource` already exists in the project
(`dist/storage/domains/comments/base.js:180-191`). So the integration checks
every ready bead's card on every sweep, and this is safe across sweeps,
restarts and replicas. Cards created before this change get their comment on
the next sweep. Within one process, a card whose comment is confirmed is not
checked again. After a restart, each card is checked once more, and the store
returns the existing comment.

**Edits are not mirrored. The first description posted stays.** Integrations
get only `feed.createComment`, not `editComment` (`integrations/base.d.ts:95`
is `Pick<CommentsDomain, 'createComment'>`), so the integration cannot update
the comment. Keying `externalId` by a description hash would post a new
comment for each edit. The agent would then see every version, and the older
ones would use up the feed's 20-comment window. If a bead's description changes
after its card exists, add a comment on the card by hand. This matches the
existing rule that cards do not follow later bead edits.

**Limits.** These come from `@mastra/factory` 0.20.0.

- The comment body can be at most 16,000 characters
  (`dist/storage/domains/comments/base.js:33`, `:37-40`). A longer
  description is cut to fit and ends with
  `[Truncated: the bead's description is N characters; the full text is in beads.]`
  (`descriptionBody`). The cut never splits a UTF-16 surrogate pair.
- The agent sees less than the comment holds. The feed block has the newest
  **20** comments, each cut to **2,000** characters (Factory adds `…`), and at
  most **12,000** characters in total. Older comments are dropped first
  (`dist/storage/domains/comments/feed-context.js:4-6`, `:36-72`). So the agent
  sees the first 2,000 characters of the description. On a card with more than
  20 newer comments, the agent does not see the description at all.
- The feed preamble tells the agent that comments are data written by
  collaborators, not instructions (`feed-context.js:9`).

If the Factory gives the integration no feed (`ctx.feed` is undefined), cards
are still created, and the integration logs one warning per process. A failed
`createComment` is logged and does not fail the sweep.

### The Done rule

`createBeadsDoneRule()` is the `manual` `onEnter` handler on Done, next to Work's
own `issue` handler. Its only action is to wake the sync worker. Board rules
run before the transition commits, inside a 5 s timeout
(`dist/rules/transition-service.js:9`, `:93-96`). `bd sync` takes 12–13 s, and a
side effect inside the rule could run for a move that then fails to commit. The
worker reads the committed card state and does the write. When the integration
is off, the rule does nothing.

## Setup

1. **GitHub App.** The App must be installed on the repository, and the
   repository must be linked to a Factory project. Use the normal GitHub
   connect flow; nothing here registers installations. The App needs
   **Contents: Read and write**, which Samskara already requests
   ([setup/github-app.md](../setup/github-app.md)). `bd sync` pushes
   `refs/dolt/data` with that permission. A branch ruleset that targets all refs
   can block that push.
2. **The repository must already use beads with a git remote.**
   `refs/dolt/data` must exist on `origin`; `bd bootstrap` clones from it. A
   repository without it is reported as `no-beads-data` and is not
   bootstrapped (see [Repository states](#repository-states)).

   **Per-repository checklist, for a repository new to the integration:**

   1. In a clone of the repository, if it has no beads database yet: `bd init`.
   2. Publish its data with `bd dolt push --yes`. With no Dolt remote
      configured, `--yes` consents to adopting the repository's `origin` as the
      Dolt remote, then pushes (`bd dolt push --help`, bd 1.3.0). This creates
      `refs/dolt/data` on `origin`. Do not use
      `bd dolt remote add origin <url>`: bd 1.3.0 refuses a Dolt remote whose
      URL matches the repository's origin unless `--allow-git-origin` is given.
      Push with `DOLT_REMOTE_INFO_BRANCH` empty, so Dolt does not create a
      `__dolt_remote_info__` branch on `origin` (see [Credentials](#credentials)
      for why). Dolt reads the variable with `os.LookupEnv` and trims it, so a
      value that is empty after trimming turns the branch off (Dolt
      `store/blobstore/git_refs.go:36-41`).
      - POSIX shell: `DOLT_REMOTE_INFO_BRANCH= bd dolt push --yes`
      - PowerShell: `$env:DOLT_REMOTE_INFO_BRANCH=' '; bd dolt push --yes`
        (one space: PowerShell deletes a variable set to `''`).

      A persistent User-level variable holding one space works the same way.
   3. The GitHub App is installed on the repository with Contents: Read and
      write.
   4. The repository is linked to exactly **one** factory, in exactly **one**
      deployment ([one environment per repository](../setup/environments.md#one-environment-per-repository)).
      A factory may link other repositories too: each beads card names its
      own repository, so none needs a manual pick; see
      [Multi-repository factories](#multi-repository-factories-the-card-names-its-repository).
   5. `GET /web/beads/status`, from a signed-in session, shows the repository
      with `state: "ok"` after the next tick (at most 15 minutes for a
      repository that was `no-beads-data`; restarting re-checks at once).
3. **`bd` on the host.** The Docker image installs bd 1.3.1 from the
   official `gastownhall/beads` release and checks its sha256 against the
   release's `checksums.txt` (Dockerfile, `bd-cli` stage). This adds about
   150 MB to the image. The binary needs glibc 2.34 or later; bookworm has 2.36.
   To upgrade, change `BD_VERSION` and both `BD_SHA256_*` arguments together:
   ```bash
   gh release download v<version> -R gastownhall/beads -p checksums.txt -O - | grep linux
   ```
   For local development, install bd yourself; `BEADS_BD_PATH` overrides the
   path.
4. **It is on by default.** To turn it off, set `BEADS_INTEGRATION=0`.
   Optional settings: `BEADS_POLL_INTERVAL_MS` (default 60000),
   `BEADS_CACHE_DIR` (default `<tmpdir>/factory-beads`) and `BEADS_BD_PATH`.
   Startup prints the `[beads]` line and, when the integration is constructed,
   `beads` in the `[integrations]` line. If the GitHub App is not configured,
   the `[beads]` line is a warning and the integration does nothing.

Agent sandboxes do not need bd, and must not get it. Agents read and write
beads through the `beads_*` tools, which run bd on the host (see
[Agent tools and skill](#agent-tools-and-skill)), so the host stays the only
automated writer. Do not install bd in a repository's setup command: the owner
decided against bd in the sandbox, even read-only (samskara-e64), and bd 1.3.0
has no setting that makes a sandbox copy read-only.

## Credentials

The GitHub App installation token comes from
`VersionControl.getRepositoryAccess` (`dist/capabilities/version-control.d.ts:231`;
GitHub returns a plain `https` clone URL and the token separately,
`dist/integrations/github/integration.js:199-213`). The token goes to child
processes **only through their environment**
(`packages/factory-beads/src/runner.ts`):

- `BEADS_GIT_TOKEN` holds the token.
- A git credential helper, set through `GIT_CONFIG_*`, prints the token when git
  asks for it (`runner.ts:25`). Dolt uses the git CLI for `git+https` remotes,
  so Dolt gets the token through the same helper. Before the helper is added,
  the helper list is reset with an empty `credential.helper` value. This stops
  a credential manager on the host from authenticating instead of the App.
- The runner throws if a token appears in argv (`runner.ts:189`). Any output
  the runner returns has the token removed, in plain, basic-auth and
  URL-encoded forms.
- The child gets an allowlisted environment (`runner.ts:28`). The server's
  other secrets do not reach bd.
- Only the network commands (`git clone`, `git ls-remote`, `bootstrap`,
  `dolt pull`, `sync`, and `dolt push` for `beads_init`) receive the token.
  Reads, including every agent-tool read, run with `--readonly` and without
  the token. An agent never sees the token: tools run on the host.

Three more settings go to every child process:

- `DOLT_REMOTE_INFO_BRANCH=''` (`runner.ts:142`). Without it, Dolt can create
  `__dolt_remote_info__` branches on `origin` (the name in the bd 1.3.0 binary). On a host that builds every
  pushed branch (Vercel), each branch can start a deploy and use up the quota.
  This matters most for client repositories.
- `core.longpaths=true` (`runner.ts:116`). Dolt's git cache is deeply nested under `.beads/dolt`.
  On Windows, git rejects the lock paths ("Filename too long") without it.
  Keep `BEADS_CACHE_DIR` short on Windows, because git also rejects a very
  long `$GIT_DIR`.
- `BD_DISABLE_METRICS=1` and `BD_DISABLE_EVENT_FLUSH=1` (`runner.ts:137-138`).
  See [Usage metrics](#usage-metrics).

### Usage metrics

bd collects anonymous usage metrics, and they are **on by default** (opt-out).
What it sends, from the bd 1.3.0 source (`internal/metrics/metrics.go`,
`cmd/bd/metrics.go`, `AGENT_INSTRUCTIONS.md` "Telemetry"):

- One `cli_command` event per command, carrying only the command name. Each
  batch also carries the bd version and OS platform, keyed by a
  machine-derived, HMAC-protected ID (cached at `~/.beads/machine-id`). bd
  states that it never collects issues, paths, remotes, identity or typed text.
- Events are queued under `~/.beads/eventsData` and POSTed to
  `https://gastownhall-eventsapi.com/mp/collect` by a detached
  `bd send-metrics` child, spawned at most every 5 minutes
  (`internal/metrics/spawn.go`). `BEADS_METRICS_ENDPOINT` or the user config
  `metrics.endpoint` changes the address.
- The switch: `BD_DISABLE_METRICS` wins over everything; then a truthy
  `DO_NOT_TRACK` (disable-only); then `metrics.disabled` in the server user's
  OWN config (`~/.config/bd/config.yaml`, written by `bd metrics off`). A
  repository's `.beads/config.yaml` is ignored for this on purpose
  (`cmd/bd/main.go` `resolveMetricsEnabled`). On first use bd prints a one-time
  notice to stderr, except under `--json`, `--quiet` and similar.
- Even with metrics off, bd still spawns the detached child to prune an old
  queue (GH#5712), unless `BD_DISABLE_EVENT_FLUSH` is set.
- Separately, OpenTelemetry export is opt-in (`BD_OTEL_ENABLED=true`,
  `internal/telemetry/telemetry.go`) and stays off here.

The runner sets `BD_DISABLE_METRICS=1` and `BD_DISABLE_EVENT_FLUSH=1` for
every bd call, after the extra variables, so nothing can turn them back on. The
server user's own `bd metrics` setting therefore does not matter, and no
detached process outlives a command. The Docker image sets the same two
variables (`Dockerfile`, after the bd `COPY`) for a bd run by hand with
`docker exec`. `test/runner.test.ts` checks both on every call of a sweep,
and `test/real-bd-tools.test.ts` checks that a real bd run through the tools
creates neither `~/.beads/eventsData` nor `~/.beads/machine-id` in its home
(without the variables, one `bd formula list` creates both).

On a developer machine this changes only what the integration's own bd calls
do. To turn metrics off for your own bd use too, run `bd metrics off` once
(it writes `metrics.disabled: true` to `~/.config/bd/config.yaml`); `bd metrics`
shows the current state.

## Single writer

All bead writes happen in one worker tick, and the tick runs only while it holds
the lease `beads:writer` (`packages/factory-beads/src/worker.ts`). The worker is
modelled on Factory's `IssueReconcileWorker`
(`dist/integrations/issue-reconcile-worker.js:6-88`): an interval tick, the
lease renewed at a third of its TTL, and the lease released after the tick. The
Done rule's wake-up and `POST /web/beads/sync` use the same lease. Agent-tool
calls take it too, through `BeadsSyncWorker.withLease`, which waits while
another process holds it; an in-process mutex also keeps a tool call and a tick
apart, because the no-op lease grants every acquire.

The lease comes from the server's pubsub, resolved the same way as
`issue-reconcile-worker.js:92-96`:

- **With `REDIS_URL`:** `RedisStreamsPubSub` implements `LeaseProvider`
  (`@mastra/redis-streams` `dist/index.d.ts:88`). One process across all
  replicas writes at a time.
- **Without it:** core's `NoopLeaseProvider` always grants the lease
  (`@mastra/core` `dist/events/pubsub.d.ts:237-243`). This is correct for one
  server process **only**. At startup the worker logs a warning when no lease
  provider is available.

**Rule: never run more than one server process with this integration on unless
`REDIS_URL` is set.** Samskara runs one container today.

**Rule: one writer per repository across all deployments.** The lease covers
the processes of one deployment only. A local development server and the
production server are separate deployments, each with its own lease (and its
own Redis, if any), so both would write to a repository that both link. Never
link a repository to both a local and a production Factory. Turn beads off with
`BEADS_INTEGRATION=0` on any instance that must link a repository another
instance owns. See
[setup/environments.md](../setup/environments.md#one-environment-per-repository).

A database-row lease is not used as a fallback. On libSQL,
`FactoryStorageOps.updateAtomic` runs inside a promise chain in one process
(`@mastra/libsql` `dist/index.js:1395-1399`, `:14455`). It would not stop a
second process.

## Agent tools and skill

Factory agents, the supervisor included, plan with beads and file them through
tools the integration contributes (samskara-e64). There is no bd in the
sandbox: each tool runs bd on the host's cached copy, under the `beads:writer`
lease (option (b) of the 2026-10-08 design research, picked by the owner on
2026-10-09).

| Tool | bd | Writes | Who |
|---|---|---|---|
| `beads_ready` | `bd --readonly ready --json` | no | every session |
| `beads_list` | `bd --readonly list --flat --brief --json` with filters | no | every session |
| `beads_show` | `bd --readonly show <id> --json` | no | every session |
| `beads_update` | `bd --sandbox update <id>` (title, description, design, acceptance, priority, status, `--append-notes`) | yes | every session |
| `beads_create` | `bd --sandbox create ... --validate` | yes | every session |
| `beads_dep_add` | `bd --sandbox dep add <issue> <depends-on> --type=<t>` | yes | every session |
| `beads_formula_list` | `bd --readonly formula list --json`, repository formulas only | no | every session |
| `beads_pour` | `bd --sandbox mol pour <formula> --var=k=v ...`; `dry_run` adds `--dry-run` and never syncs | yes | every session |
| `beads_init` | `git clone`, `bd init --prefix=<repo name> --skip-agents --skip-hooks`, `bd dolt push --yes` | yes | **supervisor only** |

**How Factory sees them.** `FactoryIntegration.agentTools()`
(`@mastra/factory` 0.20.0 `dist/integrations/base.d.ts:208-215`) is merged
into the one async `extraTools` provider that serves every session
(`dist/factory.js:519-596`; the integration loop is `:588-595`). The supervisor
gets them too: the same provider serves it, and its tools sit beside the
`factory_*` ones (`:550-586`). The project is resolved as Linear's tools do it
(`dist/integrations/linear/agent-tools.js:69-83`): the controller's
`factoryProjectId`, else its resource id, which for a supervisor is
`factory-supervisor:<projectId>` (`dist/supervisor/session.js:4-16`). A caller
from another org gets no tools. A project with no linked repository gets none.
Code: `packages/factory-beads/src/integration.ts:297` (`agentTools`),
`src/agent-tools.ts` (the tools), `src/tool-ops.ts` (host-side runs).

`agentTools` never throws (`integration.ts:297-326`). The SDK awaits the
merged provider without a catch (`@mastra/code-sdk`
`dist/agents/tools.js:120-122`), so a storage error in one integration would
otherwise remove every tool from every session. A failure is logged once and
the request simply gets no beads tools.

**`beads_init` is for the supervisor only** (owner decision, 2026-10-09). The
tool is in the tool set only when the session's resource id is
`factory-supervisor:<projectId>` for the resolved project
(`agent-tools.ts:76`, `:670`). Worker sessions (triage, plan, build, review)
and channel sessions such as Slack never get it; they are not refused at call
time, the tool is absent.

**Rules the tools enforce.**

- Every call, reads included, runs under the writer lease
  (`worker.ts:182`, `withLease`). The whole wait, behind a sweep in this
  process and for another process's lease, is capped at 120 s by default
  (`toolLeaseWait`); past it the call returns an error and its bd command never
  runs. Reads take the lease because bd's embedded database has one writer,
  and a read that overlaps a sweep's write in the same directory can fail on
  the lock.
- Every write runs `bd dolt pull` first, then the command with `--sandbox`
  (no auto-push), then `bd sync` (`tool-ops.ts:177`). When the sync fails:
  - exit 1, or 3 after retries: the write stays on the host copy, the agent is
    told, and the next sweep publishes it with `bd sync` instead of a pull
    (`integration.ts:626-642`).
  - exit 2 or 4: the repository is **parked**, exactly as for a write-back
    conflict: state `parked`, no pull, no intake and no tool writes until an
    operator resolves it and calls `POST /web/beads/reset` (`tool-ops.ts:200`).
    The park is a marker in the copy's own `.git`, so it lasts exactly as long
    as the conflicted copy; the reset drops the copy and the marker together
    (`integration.ts:504`, `:528`, `:784`). Reads still work while parked.
- Writes are signed `--actor factory-beads/agent`, so the bead history shows
  which writes came from an agent.
- No tool closes or deletes. `beads_update` refuses `closed` before bd runs
  (`agent-tools.ts:484`); the only settable statuses are `open`,
  `in_progress`, `blocked` and `deferred` (`:87`). bd itself would close
  through `update --status=closed`, so the check has to be ours.
- `beads_update` never touches a closed bead (`agent-tools.ts:502`). bd would
  reopen one on `--status=open`, and its card would stay in Done with the
  close recorded, so card and bead would disagree for good.
- `beads_create` always passes `--validate` (`agent-tools.ts:545`) and
  requires a description and a design. The type is checked first against
  `bd types --json` (core types plus the repository's `types.custom`, and bd's
  aliases `feat`, `enhancement`, `dec`, `adr`); an unknown type is refused with
  the list (`:107-132`). Observed on bd 1.3.0: `--validate` refuses a type's
  missing sections (`bd types --sections`); the `--acceptance` field satisfies
  "Acceptance Criteria" and an epic's "Success Criteria", but a bug's "Steps
  to Reproduce" must be a section of the description.
- `beads_pour`'s dry run runs with `--sandbox`, not `--readonly`: bd 1.3.0
  refuses `pour` in read-only mode even with `--dry-run` ("operation 'pour' is
  not allowed in read-only mode"). It still holds the lease and never syncs.
- With more than one linked repository, `repository` (`owner/name`) is
  required, and the error lists the choices.
- Every value goes to bd as `--flag=value` and ids are checked against a
  pattern, so no value can be read as a flag.
- `beads_init` needs `confirm: true`, is refused when origin already has
  `refs/dolt/data`, and runs `bd dolt push --yes` with
  `DOLT_REMOTE_INFO_BRANCH` blank (the runner's setting). It then drops the
  copy and the `no-beads-data` memory, so the next sweep bootstraps the
  repository at once.
- New beads become cards on the board's first phase like any other ready bead
  and wait there for a person (the owner's 2026-10-09 decision); nothing
  starts work on them automatically.

**Formulas: the repository's own, all the way down, and no gates.** bd
searches the repository's `.beads/formulas/`, then `~/.beads/formulas/` of the
user the server runs as, then `$GT_ROOT/.beads/formulas/` (`bd formula list
--help`). Under `npm run dev` the home path is the owner's personal formula
library, which must never be listed or poured into another repository, client
repositories included. So:

- The tools list only formulas whose source file is inside the repository's
  copy (`agent-tools.ts:235`), and `beads_pour` refuses any other name. bd
  1.3.0 has no built-in formulas to allow. "Inside" compares REAL paths
  (`isInside`, `agent-tools.ts:217`, `fs.realpathSync.native` on both the
  file and the copy): bd reports `source` as the path it found, so a formula
  committed as a symlink to an absolute path on the server, or a symlinked
  `.beads` or `formulas` directory, would otherwise read as inside. Checked on
  bd 1.3.0: a symlinked `o.formula.toml` pointing outside the repository is
  listed with a `source` inside `.beads/formulas`. On Linux (production) git
  checks a committed symlink out as a real symlink, which bd follows. Git for
  Windows has `core.symlinks` off by default and writes a plain file holding
  the target path, which bd 1.3.0 skips silently. A path that cannot be
  resolved counts as outside.
- A repository formula can still pull another formula in by name, and bd
  resolves that name through the same search path: a repository formula with
  `extends = ["outside"]` pours the steps of an `outside` formula from the home
  library. So `beads_pour` follows every composition reference, recursively,
  and refuses the formula if any of them is not one of the repository's own
  (`agent-tools.ts:269`, `:345-387`). The references are every field bd's
  formula schema composes with (`bd formula schema Formula`, `ComposeRules`,
  `ExpandRule`, `MapRule`, `Hook`, `Step`, `OnCompleteSpec`): `extends`,
  `compose.aspects`, `compose.expand[].with`, `compose.map[].with`,
  `compose.hooks[].attach`, and a step's `expand` and `on_complete.bond`, at
  any depth. Each formula is read as written with `bd formula show --json`.
- A formula with a gate, its own or inherited, is refused. The gate check runs
  on `bd cook <name> --json`, the resolved formula (bd cook --help: "outputs
  the resolved formula as JSON"), not on `formula show`: checked on bd 1.3.0,
  a repository formula `mol-child` with `extends = ["mol-demo"]`, where
  `mol-demo` has a gated step, shows no gate in `formula show` but carries it
  in `cook`. bd turns a gate into a gate bead that blocks its step until the
  gate is closed (`bd formula schema gate`); no tool closes beads and the
  integration never cards a gate, so a poured gated step would never become
  ready. A person pours those formulas.
- A formula that attaches a gated formula through `compose.hooks[].attach` or
  a step's `on_complete.bond` is refused too (`deferredAttachments`,
  `agent-tools.ts:295`, checked at `:379`), though bd 1.3.0 never applies
  either: `bd cook` returns `compose.hooks` unexpanded, and a dry-run pour of a
  formula with a hook attaching a gated formula creates only the root and its
  own step. In the bd source (v1.3.0, and `main` at f21e3a8 on 2026-10-09)
  `Hook` is declared as "automatic attachments triggered by labels or
  conditions" (`internal/formula/types.go`), validated, and merged through
  `extends` (`internal/formula/parser.go`), and nothing reads it at cook, pour
  or bond time; `on_complete` is a runtime no-op with an open p1 bug to wire
  it (gastownhall/beads#3782). Because a later bd may apply them to molecules
  these tools poured, each attached formula is cooked on its own and refused
  if gated; one that cannot be cooked alone is refused as well.

The formulas are read from the copy's checkout, taken when the copy was
bootstrapped: a formula committed later is offered after the copy is next
rebuilt. A pour's root bead is of type `molecule`, not `epic`; bd does not list
it as ready, so it is never carded.

**The skill.** `src/mastra/public/factory-skills/factory-beads/SKILL.md` is a
Factory skill: Factory loads a project's own skills from
`src/mastra/public/factory-skills`, `public/factory-skills` or
`factory-skills` under the working directory, beside the bundled ones
(`dist/workspace.js:23-35`, merged in `FactorySkillSource.readdir`, `:119-136`).
It is named `factory-beads`, not `beads`, so it cannot collide with the
`beads` skill a repository may carry in `.agents/skills`. It carries the
owner's beads, commit and pull-request conventions. `mastra build` copies
`src/mastra/public` into `.mastra/output` (`@mastra/deployer`
`dist/bundler/index.js:250-258`, called at `:463`), the image copies
`.mastra/output` to `/app` and runs from there, so the skill resolves at
`/app/factory-skills`. Checked on the build output and on both dev working
directories (the repository root and `src/mastra/public`): the merged list is
the four bundled non-review skills plus `factory-beads`.

**The supervisor loads no skills.** Its workspace factory returns before
building a workspace (`dist/workspace.js:245-253`), and its playbook lives in
code because "the supervisor session has no checkout to load skills from"
(`dist/supervisor/instructions.js:1-4`). So the essential rules are also in the
tool descriptions (`BEADS_AUTHORING_RULES`, `agent-tools.ts`).

**Tests.** `test/agent-tools.test.ts` (fake bd, which like bd 1.3.0 refuses
write commands under `--readonly`): the worker tool set without `beads_init`,
the supervisor's with it, the empty set, a storage failure giving no tools
instead of an error, `--readonly` reads without the token, create with
`--validate` then sync with the token, validation and type rejection, aliases
and custom types, no close, no edit of a closed bead, notes appended,
dependencies, a failed publish picked up by the next sweep, a parked
repository, a sync conflict after a tool write parking the repository until
reset, the repository argument, the init flow, formula list and pour, the dry
run's mode, server-user formulas hidden and refused, gated formulas refused
(own and inherited, checked on `cook`), a hook attaching a gated formula
refused (directly and through `extends`) while one attaching an ungated formula
pours, composition with an outside formula refused at any depth, every
composition field and every deferred attachment found, `isInside` on real paths
(a file symlink and a directory junction out of the repository; the file
symlink part needs Developer Mode on Windows and always runs on Linux), and the lease: waiting, the timeout, the in-process queue timeout, and no
overlap with a sweep. `test/real-bd-tools.test.ts` runs a real bd (local-only,
like `real-bd.test.ts`): init by the supervisor on a repository with no beads,
a refused and an accepted create, a refused close, a note, only the repository's
formulas listed (the formula in its temp home excluded), a gate inherited through
`extends` refused, `extends` to the home formula refused, a committed symlink
to a formula outside the repository refused, a hook attaching a gated formula
refused, a real pour dry run, the sweep carding the new bead, and no usage
metrics written.

## Write-back failures

`bd sync` exit codes (from `bd sync --help`), and what the integration does with
each (`integration.ts:593-624`, retries at `:698-707`):

| Exit | Meaning | Action |
|------|---------|--------|
| 0 | synced | card gets `beadsWriteback: 'synced'` and `beadsSyncedAt` |
| 2 | merge conflict, nothing pushed | card gets `beadsWriteback: 'conflict'` and `beadsDiagnostic` (token removed); the **repository is parked** (state `parked`) |
| 4 | working set is stuck | same as 2 |
| 3 | push race, bd's own retries used up | up to 2 more attempts in the same tick (2 s, then 4 s); if those fail, the card stays pending and the next tick tries again |
| 1 | transport or auth error | card stays pending; the next tick tries again |

The integration never retries exit 2 or 4 automatically. An operator must fix
them, so a parked repository runs no bd command until it is reset. If
`bd close` fails 3 times for one card, the card is marked `close-failed` and
the integration stops trying it. The card's `beadsDiagnostic` holds bd's own
reason, for example `cannot modify pinned issue <id>` or `handing <id> over
from "<holder>" failed`.

To see problems, call `GET /web/beads/status`. Any member of the organization
can call it, from a signed-in session: the Factory gate answers a request with
no session with 401 (see
[Calling the Factory API by hand](../troubleshooting.md#calling-the-factory-api-by-hand)).
The same applies to the `POST` routes below. It returns the last sweep for that organization's repositories:

```json
{
  "diagnostics": { "board": "work", "donePhase": "done", "sourceControl": "github",
                   "lease": "noop", "state": "running", "remoteCheckIntervalMs": 900000 },
  "repos": [
    { "repo": "owner/app", "projectId": "…", "state": "ok", "checkedAt": "…" },
    { "repo": "owner/docs", "projectId": "…", "state": "no-beads-data",
      "reason": "origin has no refs/dolt/data: this repository does not publish beads data",
      "checkedAt": "…", "nextCheckAt": "…" }
  ],
  "lastSweep": { "at": "…", "durationMs": 1234, "repos": [ … ] }
}
```

`diagnostics.state` is `idle` with an `idleReason` when a
[startup precondition](#startup-preconditions) failed. `repos` is empty before
the first tick. To recover a parked repository, an organization admin calls:

```
POST /web/beads/reset   {"repo": "owner/name"}
```

The route only flags the parked cards. On its next tick, the worker that holds
the lease deletes the local copy and bootstraps again from `origin`, which has
only the published state. It then publishes the close again. If the conflict
came from a bead that was edited elsewhere, fix it in a normal beads clone
first. `POST /web/beads/sync` (admins only) runs a tick immediately.

## Tests

- `packages/factory-beads/test/*.test.ts`, run by `npm test`. A scripted fake bd
  (`test/fixtures/fake-bd.mjs`) and an in-memory work-item store test the
  following: the token never appears in argv; the server environment does not
  reach bd; exit codes 2 and 3; idempotent intake across sweeps and restarts;
  epic exclusion; claim conflicts; ordering (B is carded only after A's card
  reaches Done and A is closed and synced); the lease; the description
  comment (one per card across sweeps and restarts, back-fill, no comment for
  an empty description, no feed, a failing feed, truncation); the card's
  `repository` (one repository, two repositories in one project, back-fill),
  checked with `@mastra/factory`'s real `resolveWorkItemRepository`; and, in
  `test/states.test.ts`, the on/off switch, both startup preconditions, the
  `no-beads-data` state across repeated sweeps and its re-check, and the
  status route. The harness remote carries `refs/dolt/data` unless a test
  removes it (`setBeadsData`). The fake feed
  (`MemoryFeed` in `test/harness.ts`) copies the store's replay behaviour.
- `test/real-bd.test.ts` runs a **real** bd and git end to end against a bare
  repository in a temp directory, through a `git+file://` Dolt remote. It is
  **local-only**: it is skipped when `bd` is not on PATH, and the CI workflow
  does not install bd. Set `FACTORY_BEADS_REAL_BD=0` to skip it on a machine
  that has bd.
- The plan gate for cards that are not created by a person is covered by
  `tests/boards/requests-board.test.ts`.

## Build note

`mastra build` handles workspace packages only when the Mastra app is itself a
workspace member (`@mastra/deployer` `getWorkspaceInformation`). Samskara's app
is the workspace root, so Mastra left the package as an external import, linked
to a directory that does not exist in the output. The `paths` entry in
`tsconfig.json` makes the bundler resolve `@samskara/factory-beads` to its
TypeScript source and bundle it. Check after a Mastra upgrade:
`.mastra/output/package.json` must not list `@samskara/factory-beads`. The
build never runs bd.

## Limitations

- **Slack work through planning.** The owner decided that Slack-originated work
  goes through planning, with the plan filed as beads and approved by a person
  before building. That waits on Mastra routing Slack threads into
  triage/planning (`samskara-ylt`). Today the Slack flow upserts a card straight
  into Building and skips the board rules.
- **More than one instance has not been tested.** The Redis lease is the
  intended guarantee, but no run with two replicas has been done. Separately,
  beads claims are atomic only inside one database
  (`issueops/claim.go:116-126`; beads #3575). Two writable copies can claim the
  same bead twice, and the merge does not report it. Keep this host as the only
  automated writer.
- **No live plan-gate run yet.** The gate is proven by unit tests only. The
  transition API always acts as a person, and a live agent run costs credits.
- **Cards do not follow later bead edits.** If a bead's title or description
  changes, or the bead is closed outside Factory, its card and its description
  comment stay as they are.
- **The description reaches the agent live only in unit tests so far.** The
  feed path is native Mastra, but no planning run on a beads card has been
  checked end to end since this change.
- **Multi-repository start is proven by unit tests only (`samskara-srl`).**
  The tests run Mastra's own `resolveWorkItemRepository` on the cards the
  integration makes; no beads card has yet been started live in a factory
  with two linked repositories.
- **Client repositories have not been exercised.** Each needs the App
  installed, `refs/dolt/data` on `origin`, and the
  `DOLT_REMOTE_INFO_BRANCH` setting described above.

### Known Mastra gaps (feedback items)

Found while building this on `@mastra/factory` 0.20.0. Each one must be checked
again on the current release before it is reported through the `mastra`
skill's feedback process.

- There is no API to register a GitHub App installation for an organization.
  Only the browser connect flow can do it.
- Board `onEnter` rules have a fixed 5 s timeout and run before the commit. A
  slow side effect cannot run in a rule.
- `upsertLinkedWorkItem.source` accepts a fixed list of sources, so a
  third-party integration cannot create cards through a rule decision.
- `POST /web/factory/projects/:id/work-items` drops `externalSource.workspaceId`
  and cannot set `claimKey`.
- Factory never calls `Intake.updateIssue` except for incident.io, so tracker
  write-back must be built by each integration.
- The supervisor has no tool to create or split cards
  (`supervisor/instructions.js:18-19`).
