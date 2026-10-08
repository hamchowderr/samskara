# Beads integration

Ready beads (`bd`) in each linked GitHub repository become cards on the Work
board. When a card reaches Done, the integration closes its bead and publishes
the change to the repository's `refs/dolt/data`. Tracked in beads
`samskara-iz6`.

beads owns the graph and Factory owns the lane. Order comes from `bd ready`: a
bead that another open bead blocks is not ready, so its card appears only after
the blocker is closed. Factory has no dependency model of its own, and the
integration does not add one.

It is **on by default**. `BEADS_INTEGRATION=0` (or `false` or `off`, any case)
turns it off; any other value, or no value, leaves it on (samskara-iz6.8).
Startup prints one line that says which, and how to turn it off:

```
[beads] on by default; set BEADS_INTEGRATION=0 to turn it off.
[beads] off (BEADS_INTEGRATION is set to turn it off).
```

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
   (`packages/factory-beads/src/integration.ts:433-451`).
1. **Bootstrap, first time only.** `git clone --depth 1`, then
   `bd --sandbox bootstrap --yes`, in `<BEADS_CACHE_DIR>/<owner>__<name>`. A
   marker file in `.git/` records that the copy is ready. The copy is kept
   between ticks and rebuilt after a restart (about 10 s per repository).
2. **Write-back.** For every beads card in the Done phase that has not been
   published yet: `bd --sandbox --actor factory-beads close <id> --reason
   "Factory card <card id> reached done"`, then `bd sync`
   (`packages/factory-beads/src/integration.ts:457-521`).
3. **Pull.** If there was nothing to write back, `bd dolt pull`.
4. **Intake.** `bd --readonly ready --json --exclude-type=epic -n 0`, then one
   card per bead, and the bead's description as one comment on the card's feed
   (`integration.ts:530-575`). See [What the agent sees](#what-the-agent-sees).

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
(`#checkPreconditions`, `integration.ts:221-238`). Nothing is synced until the
server restarts; `GET /web/beads/status` shows `state: 'idle'` and the reason.

| Precondition | Log line |
|--------------|----------|
| The GitHub App is configured | Samskara does not construct the integration at all; the startup line says `[beads] on by default, but the GitHub App is not configured, so the integration is idle.` The package logs `integration idle: source control "github" has no versionControl capability` if it is constructed without one. |
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

To make a `no-beads-data` repository a beads repository, give it a git remote
and push its beads data (`bd dolt remote add origin <git url>`, then
`bd dolt push`). The next re-check, at most 15 minutes later, bootstraps it.
Restarting the server re-checks at once.

### Cards

| Field | Value |
|-------|-------|
| `board` | the board passed in (Samskara: `requestsBoard.id`, which is `work`) |
| `stages` | the board's initial phase |
| `externalSource` | `{ integrationId: 'beads', type: 'issue', externalId: <bead id> }` |
| `claimKey` | `beads:<owner/name>:<bead id>` |
| `title` | `<bead id>: <bead title>` |
| `metadata` | `beadsId`, `beadsRepo`, `beadsType`, `beadsPriority`, plus write-back state |

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
3. **`bd` on the host.** The Docker image installs bd 1.3.0 from the
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

Agent sandboxes do not need bd. They never write beads data: the host is the
only automated writer. A repository that wants agents to read beads can
install bd in its per-repository setup command.

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
- The runner throws if a token appears in argv (`runner.ts:178`). Any output
  the runner returns has the token removed, in plain, basic-auth and
  URL-encoded forms.
- The child gets an allowlisted environment (`runner.ts:28`). The server's
  other secrets do not reach bd.
- Only the network commands (`bootstrap`, `dolt pull`, `sync`) receive the
  token. Reads run with `--readonly` and without the token.

Two more settings go to every child process:

- `DOLT_REMOTE_INFO_BRANCH=''` (`runner.ts:116`). Without it, Dolt can create
  `refs/dolt/remote-info` branches on `origin`. On a host that builds every
  pushed branch (Vercel), each branch can start a deploy and use up the quota.
  This matters most for client repositories.
- `core.longpaths=true`. Dolt's git cache is deeply nested under `.beads/dolt`.
  On Windows, git rejects the lock paths ("Filename too long") without it.
  Keep `BEADS_CACHE_DIR` short on Windows, because git also rejects a very
  long `$GIT_DIR`.

## Single writer

All bead writes happen in one worker tick, and the tick runs only while it holds
the lease `beads:writer` (`packages/factory-beads/src/worker.ts`). The worker is
modelled on Factory's `IssueReconcileWorker`
(`dist/integrations/issue-reconcile-worker.js:6-88`): an interval tick, the
lease renewed at a third of its TTL, and the lease released after the tick. The
Done rule's wake-up and `POST /web/beads/sync` use the same lease.

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

A database-row lease is not used as a fallback. On libSQL,
`FactoryStorageOps.updateAtomic` runs inside a promise chain in one process
(`@mastra/libsql` `dist/index.js:1395-1399`, `:14455`). It would not stop a
second process.

## Write-back failures

`bd sync` exit codes (from `bd sync --help`), and what the integration does with
each (`integration.ts:490-521`, retries at `:577-586`):

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
the integration stops trying it.

To see problems, call `GET /web/beads/status`. Any member of the organization
can call it. It returns the last sweep for that organization's repositories:

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
  an empty description, no feed, a failing feed, truncation); and, in
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
