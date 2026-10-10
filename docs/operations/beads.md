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
  `packages/factory-beads/src/setting.ts`), board policy and phase handlers at `src/mastra/boards/requests-board.ts:64-70,92-115`.
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
   (`packages/factory-beads/src/integration.ts:660-678`).
1. **Bootstrap, first time only.** `git clone --depth 1`, then
   `bd --sandbox bootstrap --yes`, in `<BEADS_CACHE_DIR>/<owner>__<name>`. A
   marker file in `.git/` records that the copy is ready. The copy is kept
   between ticks and rebuilt after a restart (about 10 s per repository).
2. **Write-back.** For every beads card in the Done phase that has not been
   published yet: `bd --sandbox --actor factory-beads close <id> --reason
   "Factory card <card id> reached done"`, then `bd sync`
   (`packages/factory-beads/src/integration.ts:684-751`). bd refuses to close
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
     holder, and the card's diagnostic says so. A claim comes back without
     its lease: a live holder restores it on its next `bd heartbeat`, but an
     abandoned claim then has no stale lease for `bd reclaim` to find.
3. **Pull.** If there was nothing to write back, `bd dolt pull`.
4. **Intake.** `bd --readonly ready --json --exclude-type=milestone -n 0`, then one
   card per bead, and the bead's description as one comment on the card's feed.
   See [What the agent sees](#what-the-agent-sees).
   A bead whose parent is an epic, milestone or molecule root is put under
   that container's overview card, which is made first; see
   [Overview cards](#overview-cards). A ready epic with children is that
   overview card; a ready epic with none is a planning card; see
   [Planning cards](#planning-cards). A bead whose parent is any other bead
   is put under the parent's card when it has one; see
   [Subtasks](#subtasks).
5. **Open-children counts.** Each overview card that intake did not reach
   in this tick, and that is not in a terminal phase, gets its open-children
   count read again. A planning card that intake did not reach is checked for
   children too.
6. **Overview moves and re-arms.** Overview cards whose last child closed
   are committed to Done; overview cards stranded in a working phase whose
   phase seat is not bound are committed to Intake; `close-failed` cards in
   Done whose children have all closed are re-armed.

A project connection whose GitHub installation no longer exists (an orphaned
link, samskara-1ra) is skipped with one warning per connection, and the other
links still sweep. `connections.list` returns such a connection, but
`projectRepositories.list` throws `SourceControlConnectionNotFoundError` for it
(`@mastra/factory` 0.20.0 `dist/storage/domains/source-control/base.js:306-309`,
`:510-515`), so the integration first checks it with `connections.get`, which
applies the same test and returns `null`.

Milestones are excluded from `bd ready` because they are containers, not
work, and `bd ready` lists them. Epics are containers too, and `bd ready`
lists an open epic whether or not it has open children (checked on bd
1.3.1), but they are read: intake reads each epic's children and cards it as
an overview card (children) or a planning card (none, samskara-l2t.2.4).
Pinned beads, gates and workflow roots (`molecule`) bd ready already leaves
out (bd v1.3.1 `internal/storage/sqlbuild/ready.go`: types at `:16-38`, the
status filter at `:113`, the pinned flag at `:117`). A milestone or molecule
root is carded only as the parent of a ready child, as an overview card.

### Startup preconditions

Two things cannot change while the server runs. Each is checked once, at the
first tick, and a failure logs **one** line and leaves the integration idle
(`#checkPreconditions`, `integration.ts:351-368`). Nothing is synced until the
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
| `parentWorkItemId` | the overview card of the bead's parent container, or the card of any other parent bead, when it has one |
| `metadata` | `repository` (`<owner/name>`), `beadsId`, `beadsRepo`, `beadsType`, `beadsPriority`, plus write-back state; on an overview card also `beadsCardKind: 'overview'` and `beadsOpenChildren`; on an open decision's card `beadsCardKind: 'research'`; on a childless open epic's card `beadsCardKind: 'plan'` |

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

### Card kinds

Every beads card is one of four kinds, set in `beadsCardKind` from the bead
(samskara-l2t.2). The kind decides what runs on the card, which moves the
board allows, and who approves. The sections below give the detail; this is
the summary.

| Kind | Bead | `beadsCardKind` | What runs on it | How it moves | Who approves |
|------|------|-----------------|-----------------|--------------|--------------|
| Work | any other ready bead (task, bug, feature, chore, spike, story) | absent | Work's own triage, plan and build runs | as any Work card | Work's plan gate; a card reaching Done closes the bead |
| [Overview](#overview-cards) | an epic, milestone or molecule root with children | `overview` | nothing | rests in Intake; the worker commits it to Done when its last child closes; never into a working phase | nobody: the last child's close is the signal |
| [Planning](#planning-cards) | an open epic with no children | `plan` | Planning: `factory-beads-epic` propose mode; Building: file mode | a person moves it to Planning, then to Building; the file run moves it back to Intake; it becomes an overview card | a person, by moving it to Building (never the system or an agent, whatever auto-approve says) |
| [Research](#research-cards) | an open `decision` | `research` | Planning: `factory-beads-decision` | a person moves it to Planning; it never enters Triage, Building or Review | a person, by moving it to Done, which closes the bead |

A bead whose parent is not a container (a task with subtasks) is linked under
its parent's card, which stays a work card (samskara-l2t.2.5): see
[Subtasks](#subtasks).

**What the board can and cannot guard.** Every rule above that refuses a move
is the Requests board's `transitionPolicy` (`board-rules.ts`), which Factory
asks on every transition, for every actor, before any phase rule
(`@mastra/factory` 0.20.0 `dist/rules/transition-service.js:245-262`). The
policy is consulted only when a card moves. Three things in the Factory UI
matter here; all were checked in `mastra` 1.33.0
(`node_modules/mastra/dist/factory/assets/index-BaghZlUk.js`):

- **"Start session".** Every card without a session shows it, overview,
  research and planning cards included: `Tdt` falls back to
  `{label: "Start session", start: () => onCreateSession(Sue(card))}` when no
  other action applies. `onCreateSession` is `openOrCreateSession` (`Lde`),
  which opens the card's existing session if it has one, or else creates a
  session on the card's repository and calls
  `POST /web/factory/projects/:id/runs/start` (`rQe`) with
  `workItem: {id, role: "chat", input: {..., stages: ["intake"]}}` and no
  destination stage. On the server
  (`dist/routes/work-items.js:508-534`), the body schema has no
  `destinationStage` field (`dist/routes/contracts.js:99-108`), and
  `FactoryStartCoordinator.prepare` (`dist/rules/start-coordinator.js:67-220`)
  binds the session to the card in the `chat` seat
  (`prepareRunStart`, `dist/storage/domains/work-items/base.js:2219-2382`:
  for an existing card only its `sessions` change, never its stages) with
  `kickoffMessage: null`, marks the start `sent`, and transitions only when a
  destination stage is given (`:181-206`), which this route never does. So
  no transition runs, no board policy, phase handler or tool rule is asked,
  no skill is invoked, and no agent turn starts: the person gets an empty
  chat thread bound to the card. The agent in it sees the card's phase
  (`dist/rules/processor.js:206`; in Intake it is told the card's work is
  paused) and may request moves with `factory_transition_work_item`, which
  `prepare` allows without a prompt (`start-coordinator.js:153-156`). Those
  requests go through the transition service (`dist/rules/tools.js:53-87`),
  so the board policy refuses them as for any other agent. Factory has no
  board or integration hook for a session start: a board declares phases'
  `onEnter`/`onExit`, tool-result rules and `transitionPolicy` only
  (`dist/boards/define-board.d.ts:43-62`), and an integration's hooks
  (`dist/integrations/base.d.ts:180-286`) include none either. The board
  therefore cannot refuse the session or run the card's own skill in it.
  What an overview card's chat session can do is what any chat session can;
  the `factory-beads` skill tells agents not to build on one. This is
  recorded as a Mastra gap below; Samskara does not override the route.
- **"Resume".** A card in Intake that has had a triage, plan, work or review
  session shows "Resume" (`Rdt`: the latest such seat's phase, via
  `K4 = {triage, plan → planning, work → execute, review}`). It calls the
  card's move (`onMove`), which is `POST .../work-items/:id/transition` as a
  person (`dist/routes/work-items.js:472-507`), so the board policy decides.
  For an overview card that phase is a working phase, and the move is
  refused with `forbidden`. For a planning card, Resume into Building is a
  person's move, so it approves the latest proposal, the same as moving the
  card to Building.
- **Greyed moves while a session is open.** While a card has a session
  status, the card menu disables every move into a working phase; see
  [Planning cards](#planning-cards), step 3. That is the UI, not the board
  policy.

### Overview cards

An epic, milestone or molecule root (the root bead of a `bd mol pour`) that
has children gets an **overview card**: a card that groups its children's
cards and is never moved into a working phase (owner decision, 2026-10-09,
samskara-l2t.2). Its
children's cards are linked under it with Factory's own
`parentWorkItemId`, so they show under its linked items.

**When it is made.** Intake makes a container's card when it first meets a
ready child of it, or, for an epic, the epic itself in `bd ready`. A
milestone or molecule root whose children are all in progress or blocked has
no card until one of them is ready. The ready row's `parent`
field names the container
(bd 1.3.1 sets it from the parent-child edge). The integration reads the
container with `bd --readonly show <id> --json` and its children with
`bd --readonly list --parent=<id> --all --flat --json -n 0`
(`repo.ts`, `BdRepo.children`). Checked on bd 1.3.1: `--parent` lists direct
children only, so a grandchild is counted under its own parent; `--all` adds
closed children; `-n 0` lifts the default limit of 50. A poured molecule's
steps have parent-child edges to the root (bd v1.3.1 `cmd/bd/cook.go:643-649`),
so a molecule root is handled like an epic.

**Parent before child.** Factory checks a `parentWorkItemId` against the
cards already in the project (`@mastra/factory` 0.20.0
`dist/storage/domains/work-items/base.js:318-332`, called on create at
`:2484`). The integration therefore resolves the chain top-down: for a
grandchild under a nested epic, the outer epic's card is made first, then the
nested epic's card under it, then the grandchild's card under that
(`integration.ts`, `#overview` and `#resolveOverview`). Each container is
resolved once per tick. A card made before its container's card (an older
card, or a bead moved under an epic later) is linked on the next tick with
`setParentWorkItemIfMissing` (`base.js:2512-2530`), which leaves a parent that
is already set alone, so a link made by hand stays.

**What it carries.** The same external source, claim key
(`beads:<owner/name>:<bead id>`), title format, repository and description
comment as a work card, plus `beadsCardKind: 'overview'` and
`beadsOpenChildren`, the number of its direct children that are not closed.
Metadata is written only when a value changes, because every metadata write
bumps the card's revision. Overview cards rest in the board's initial phase
(Intake).

**When it is not made.**

| Case | Result |
|------|--------|
| The container has no children | No overview card (owner decision). A childless open epic gets a [planning card](#planning-cards); a childless milestone or molecule root gets no card. |
| The child is already carded in another project of the organization | No overview card in this project, and one warning per process. The child's claim (`getByClaimKey`, `base.js:1220-1226`) says where its family lives. |
| The container itself is carded in another project | The children are carded here without a parent, with one warning. |
| The parent is not an epic, milestone or molecule, or it is closed | No overview card. The child is linked under the parent's own card when the parent has one ([Subtasks](#subtasks)), else carded without a parent. |
| `bd show` or `bd list --parent` fails | The child is carded without a parent; the next tick tries again. |

**The board policy.** An overview card must never run. A phase handler that
returns no decision does not stop a run: a person's move into a working
phase still starts one with a generic stage message
(`dist/rules/transition-service.js:296-311`). So the Requests board's
`transitionPolicy` refuses the move itself
(`packages/factory-beads/src/board-rules.ts`,
`createBeadsTransitionPolicy`, wired in `src/mastra/boards/requests-board.ts`).
The policy runs for every transition and every actor before any phase rule,
and a `reject` ends the transition (`transition-service.js:245-262`).

The policy covers moves, not sessions started without one. The Factory UI's
"Start session" button calls `POST /web/factory/projects/:id/runs/start`
with no destination stage, which binds a chat session to the card and asks
no board hook at all; see [Card kinds](#card-kinds) for what that session
can and cannot do. The admin-only
`POST .../work-items/:workItemId/automation-runs` route
(`dist/routes/contracts.js:386-393`, for a trusted external orchestrator)
also dispatches a skill without a transition. The UI bundle has no call to
it (searched for `automation-runs` in `index-BaghZlUk.js`); nothing in
Samskara calls it.

An existing card for a container becomes an overview card wherever it sits:
a planning card whose epic gets children, or a card made before overview
cards existed. One left in a working phase is stranded, since no phase
handler runs it and the policy refuses its moves into other working phases.
Each tick commits a move of such a card to Intake unless **the phase's own
seat is bound to it**: an active run binding whose role is the seat the
phase seats (`roleForPhase`, so `work` in Building)
(`integration.ts:987-1010`, `#resetStrandedOverviews`; bindings from
`WorkItemsStorage.listRunBindings`, `dist/storage/domains/work-items/base.d.ts:730`).
A binding for another seat does not hold the card: the `chat` seat a
person's "Start session" takes neither runs the phase nor moves the card.
The move is a committed transition, like the Done move below, with the
ingress identity `beads:overview-intake:<card id>@<revision>`, and the
policy allows it because Intake is not a working phase. A card that step
also commits to Done is left to that move.

**A card with its seat bound** (samskara-l2t.2.5). The seat's binding is
how Factory records the run that may still be moving the card: the planning
card's file run, which moves it back to Intake itself, or, on a card made
before overview cards existed, the run that was building it. Factory gives
an integration no way to tell a live run from a finished one:
`IntegrationContext.runtime` holds only `configVersion`, `workItems` and
`boards` (`dist/integrations/base.d.ts:137-143`), and the running-session
set is the HTTP layer's (`liveSessions`, `dist/routes/work-items.js:250`).
Moving the card from under a live run would only turn that run's own move
to Intake into a `stale` rejection, so the worker leaves it. The run is
not stuck either. The policy refuses its moves into a working phase with a
reason that names the way out, "An overview card holds no work and closes
when its last child closes; move it to Intake and work on its children
instead", which the agent receives as the tool result
(`dist/rules/tools.js:53-87`). Its move to Intake is allowed, and so is
its move to Done once no child is open. A person can move it to Intake or
Canceled at any time: the card menu keeps resting and terminal moves
enabled while a run holds the card.

A binding stays active after its run ends: Factory revokes it when the card
reaches a terminal phase or when the session takes another role
(`dist/storage/domains/work-items/base.js:2121-2190`), and the
dispatcher's stale-binding sweep revokes it once it is old: every 10
minutes the sweep revokes each active binding created more than 24 hours
earlier (`dist/rules/dispatcher.js:34-35,373-385`,
`dist/storage/domains/work-items/base.js:2159-2181`; samskara overrides
neither value). So a card whose run ended without moving it keeps its
active binding and is not moved until that sweep revokes it, about 24
hours after the run started; the next tick then moves it to Intake.

| Move of an overview card | Result |
|--------------------------|--------|
| Into Triage, Planning, Building (`execute`) or Review, by a person, an agent or the system | Rejected, `forbidden`: "An overview card holds no work and closes when its last child closes; move it to Intake and work on its children instead". |
| Into Done while `beadsOpenChildren` is above 0 | Rejected, `forbidden`. |
| Into Done with no open children, into Canceled, or out of a working phase into Intake | Allowed (then Work's own policy decides). |

The working phases are the board's phases declared `kind: 'working'`, read
from Work's definition, not a hard-coded list. Every other card, and every
other move, gets Work's own policy unchanged, including the plan gate. The
policy reads only the card snapshot it is given: a policy must not read
storage (`node_modules/@mastra/factory/factory-skills/configure-factory-rules/SKILL.md:61-63`),
which is why the sync worker keeps the open-children count on the card.

#### Closing when the last child closes

An overview card moves to Done by itself once every direct child of its
container is closed (samskara-l2t.2.2). Nobody moves it, and nothing runs on it.

1. **Tick N.** Write-back closes the last child's bead. Later in the same
   tick, the worker reads the container's children again, writes
   `beadsOpenChildren: 0` to the card, and commits a move to Done
   (`integration.ts`, `#closeSettledOverviews`).
2. **Factory's dispatcher** applies the move within about a second (it polls
   every 1 s, `dist/rules/dispatcher.js:17,295`). The move goes through the
   board's transition service as actor system, so the board policy and Done's
   rules run as for any other move (`dispatcher.js:507-534`). The Done rule
   wakes the worker.
3. **Tick N+1** (about a second later, after the kick). Write-back closes the
   container bead as the integration's actor (`factory-beads`) with the reason
   `Factory card <id> reached done`, runs `bd sync`, and marks the card
   `synced`. For a molecule root, bd has already closed the root together with
   its last step ("Auto-closed completed molecule", reason `all steps
   complete`; checked on bd 1.3.1), so write-back finds the bead closed, makes
   no close call, and only syncs and marks the card.

An open epic whose children were all closed before Factory first saw it is
handled the same way (owner decision, samskara-l2t.2.4: keep auto-closing
settled epics). The first sweep cards it as an overview card with
`beadsOpenChildren: 0`, not as a planning card, and commits its move to Done
in that sweep; the next tick closes the epic bead.

The move is not `bd epic close-eligible`. That command closes every eligible
epic in the repository, as actor `system` (owner decision, samskara-l2t.2).

**How the move is made.** The worker commits a rule evaluation that carries
a `transition` decision, through `workItems.commitRuleEvaluation`. Linear's
issue-closed rule moves a card the same way
(`dist/integrations/linear/default-rules.js:35-49`, committed at
`integrations/linear/rules.js:131-158`). The worker does not set the card's
stages itself, which would skip the board policy and Done's rules. The
evaluation's ingress identity is `beads:overview-done:<card id>@<revision>`.
`commitRuleEvaluation` replays an identity it has stored before, and stores
an evaluation whose expected revision is not the card's current revision as
rejected, code `stale` (`dist/storage/domains/work-items/base.js:1424-1473`).
Because the identity includes the revision, a later revision of the card gets
a new evaluation. A tick at the same revision replays the stored evaluation
and changes nothing. The helper (`#commitTransition`) takes any stage and
reason key.

**When no move is committed.**

| Case | Result |
|------|--------|
| A child is still open | No move. The board policy would refuse it. |
| The container's children could not be read this tick | No move. The count on the card may be out of date. The next tick tries again. |
| The open container has no children left (they were moved elsewhere) | No move. A childless epic is not finished work (samskara-l2t.2.4). If the container is closed, the card moves. |
| The card is already in Done or Canceled | Nothing to do. |

**A container closed early.** If someone closes the container bead while a
child is still open, its card stays and its count stays current. The count
used to freeze in this case: intake stops at a closed container before
counting, and the count pass skipped every container that intake had
touched. When the last child closes, the card moves to Done, and write-back
marks it synced without closing the bead again.

**Timing and retries.**

- *A child added after the count was read.* The policy reads the count on
  the card, which the worker writes once per tick, so it does not see a child
  added since that tick. The move goes through, and bd then refuses to close
  the container while that child is open. Write-back counts the failed
  attempts, and after `maxCloseAttempts` (3) it parks the card as
  `close-failed`. The re-arm below recovers it.
- *A refused move.* The card stays where it is. The dispatcher retries a
  failed decision up to 5 times (`dispatcher.js:19,39-41`), but every retry
  uses the same transition ingress (`decision:<key>`, `dispatcher.js:526`),
  and the transition service replays a stored rejection for a seen ingress
  (`transition-service.js:129-130`). So a refused move is replayed, not
  re-evaluated, and after 5 attempts it shows as an "automation-failed"
  attention item until the card reaches a terminal phase. A real move comes
  only from a new evaluation, which the next tick that finds the count at 0
  commits on the card's new revision.
- *A person cancels the card just after the move is committed.* The
  dispatcher applies a transition at the card's current revision
  (`dispatcher.js:507-520`), and Work allows Canceled to Done, so the card
  still lands in Done and the container is closed. Every child is already
  closed by then.
- *Re-arm.* A card in Done that is parked `close-failed` gets its
  write-back re-armed once every child of its bead is closed:
  `beadsCloseAttempts` is set back to 0 and `beadsWriteback` is cleared.
  The card stays in Done, and the next tick tries the close again
  (`integration.ts:1026-1050`, `#rearmParentCloses`). bd refuses to close
  any bead while a child is open ("cannot close <id>: 1 open child
  issue(s)"; checked on bd 1.3.1 for an epic and for a task with a subtask),
  so this covers overview cards, cards made before overview cards existed,
  and a task's card moved to Done before its subtasks closed
  ([Subtasks](#subtasks)). A card whose bead has no children is never
  re-armed. It happens once per card (`beadsCloseRearmedAt`). If the close
  fails again for another reason, the card stays parked for an operator
  (`POST /web/beads/reset`). Each tick reads the children of every such
  card still parked, one `bd list --parent` per card.

### Subtasks

A bead whose parent is not an epic, milestone or molecule root, a task with
subtasks say, is linked under its parent's card, and the parent stays a work
card (owner principle: use all of beads; samskara-l2t.2.5). Nothing about
the parent changes: it gets no `beadsCardKind`, no open-children count and
no automatic move, it runs like any other work card, and the board policy
treats it as Work does.

- **Linking.** For each ready bead with a `parent`, intake first resolves
  the parent as a container (`#overview`); when that gives no overview card,
  it looks up the card the parent bead already has in this project
  (`getByProjectSource`; `integration.ts:1136-1145`, `#parentCard`). No card
  is made for the parent here: it is carded only when it is ready itself.
  bd 1.3.1 lists a task with an open subtask as ready (checked by hand), so
  both are usually carded together. Intake orders the ready list so that a
  ready parent is carded before its ready children (`parentsFirst`), so the
  link is made in the same sweep. A child carded while its parent had no
  card (the parent claimed, say) is linked with `setParentWorkItemIfMissing`
  on the first sweep after the parent gets one; a parent set by hand stays.
- **Closing.** bd refuses to close a bead while one of its children is open,
  a task included. A task's card that reaches Done before its subtasks are
  closed is therefore parked `close-failed` after `maxCloseAttempts`, and
  re-armed once its last subtask closes (see *Re-arm* above). The policy does
  not refuse that move: only overview cards carry the open-children count.
- **What the agent sees.** Factory shows a card's linked items to its agent
  (at most five, `dist/rules/processor.js:11,176-179`), so a subtask's run
  sees its parent task, and the task's run its subtasks.

### Research cards

An open `decision` bead gets a **research card** (owner decision, 2026-10-09,
samskara-l2t.2; built in samskara-l2t.2.3). An agent researches the options
and writes the decision into the bead. A person approves it by moving the card
to Done, which closes the bead through the normal write-back. A research card
never reaches Building, and the agent writes no code and opens no pull
request.
The write-up lives in the bead only, not in a docs file or a pull request.

**Intake.** A ready bead of type `decision` is carded like any other bead, plus
`beadsCardKind: 'research'` (`integration.ts`, `readyCardKind` and the intake
loop). The kind follows the bead's type: a decision card made before research
cards existed gets it on the next tick, and a card whose bead is no longer a
decision has it cleared. It is written only when it changes, because every
metadata write bumps the card's revision. An overview card's kind is never
touched here. A closed decision is a record: bd ready never lists a closed
bead, so it is never carded (checked on bd 1.3.1 in `test/real-bd.test.ts`).
A decision under an epic is linked under the epic's overview card and counts
as one of its open children.

An agent files an open question with `beads_create`, which validates
(`--validate`). bd requires `## Decision`, `## Rationale` and
`## Alternatives Considered` in a decision's description, and accepts them
empty (checked on bd 1.3.1). So an open question is filed as the question
followed by the three empty or `Open.` sections. The `factory-beads` skill
says so.

**Planning runs the decision skill.** The Requests board's planning phase has
a `manual` handler, `createBeadsPlanningRule`
(`packages/factory-beads/src/decision-rule.ts`, wired in
`src/mastra/boards/requests-board.ts`). It wraps Work's own planning handler
(`planWorkItem`, `@mastra/factory` 0.20.0 `dist/boards/work.js:101-109,176`).
Beads cards classify as `manual`, so this is the handler a beads card
triggers. For a research card it returns:

| Field | Value |
|-------|-------|
| `type` | `invokeSkill` |
| `role` | `plan` |
| `skillName` | `factory-beads-decision` |
| `arguments` | `Decision bead <bead id> in repository <owner/name>` |
| `idempotencyKey` | `<ingress id>:factory-beads-decision`, the same scheme as Work's `<ingress id>:factory-plan` |

Every other card gets Work's own decision unchanged. The decision shape is
checked against `dist/rules/types.d.ts:429-457` and against Factory's own
`validateFactoryRuleDecision` in the tests. The skill is a project skill:
Factory merges `src/mastra/public/factory-skills` over its bundled skills
(`dist/workspace.js:23-33`, `:119-136`), as it does for `factory-beads`.

**The skill** (`src/mastra/public/factory-skills/factory-beads-decision/SKILL.md`)
reads the bead with `beads_show`, researches the options in the codebase, the
vendor documentation and the web when a tool for it is available, and writes
the result with one `beads_update`: the original question first, unchanged,
then the three sections in the description; `design` and `append_notes` where
they help. It never writes code, opens a pull request, closes the
bead, calls `submit_plan` or requests a transition. It ends by asking a person
to review the bead and move the card to Done, or to send it back with
feedback. Each entry into Planning runs the skill again, and the kickoff
carries the card's feed (`dist/rules/dispatcher.js:635-639`), so feedback left
on the card reaches the next run.

**The board policy.** `createBeadsTransitionPolicy` refuses these moves of a
research card (`board-rules.ts`):

| Move of a research card | Result |
|-------------------------|--------|
| Into Triage, Building (`execute`) or Review, by anyone | Rejected, `forbidden`. |
| Into Done by an agent, the system, or any other actor that is not a person | Rejected, `approval_required`: "A person approves a decision by moving its card to Done; agents and automation never do, even when plans auto-approve". |
| Into Planning by a person | Allowed; Work's policy accepts the card, as for any card a person starts. |
| Into Done or Canceled by a person | Allowed (then Work's own policy decides). |

Auto-approve plans never approves a decision (owner decision). Work's policy
reads the project's setting only for Planning to Building
(`dist/boards/work-transition-policy.js:15-19`), and the transition service
hands it to the policy as `plansAutoApproved`
(`dist/rules/transition-service.js:241-262`). The research rules never read
it, and Building is refused outright. So an approved `submit_plan` result,
which Work turns into a move to Building (`dist/boards/work-tool-rules.js:8-16`),
is refused as well. A person is `actor.type === 'human'`, the same test Work's
plan gate uses.

Planning is the board's phase with `role: 'plan'`, read from Work's
definition. Moves into Planning or Canceled by an agent are left to Work's
policy.

### Planning cards

An open epic with no children gets a **planning card** (owner decision,
2026-10-09, samskara-l2t.2; built in samskara-l2t.2.4). An agent proposes the
epic's child beads; a person approves the proposal; a second run files exactly
those children; the card then becomes the epic's overview card. The agent
writes no code and opens no pull request.

**Intake.** bd ready lists open epics (`repo.ts`, `ready`, now excludes only
milestones). For each ready epic intake reads its children
(`bd list --parent`, as for any container). With children, the epic is an
overview card. With none, it is carded like any bead plus
`beadsCardKind: 'plan'`. Only a children read that succeeded and found none
makes a planning card: when the epic or its children cannot be read, or the
epic is carded in another project, nothing is carded or changed for it in
that tick. A planning card under a milestone or a parent epic is linked under
that container's overview card and counts as one of its open children. The
kind is written only when it changes; an epic card made before planning cards
existed gets it on the next tick, and a card whose bead stops being an epic
has it cleared. An overview card is never turned back into a planning card,
even when its epic loses every child.

**Planning card to overview card.** Each tick, a planning card whose epic now
has children is changed to `beadsCardKind: 'overview'` with
`beadsOpenChildren`, and the children's cards are linked under it. This runs
from intake when the epic is ready, and from the count pass when it is not
(blocked, say). Metadata is written once.

**The flow.**

1. A person moves the planning card into Planning. The Requests board's
   planning `manual` handler, `createBeadsEpicPlanningRule`
   (`packages/factory-beads/src/epic-rule.ts`), starts the
   `factory-beads-epic` skill in **propose** mode on the plan seat. It wraps the
   research-card handler, which wraps Work's `planWorkItem`
   (`dist/boards/work.js:101-109`), so every other card gets the same decision
   as before.
2. The skill reads the epic, researches the work, and appends a
   `## Proposed children` block to the epic's notes with `beads_update`: per
   child, the title, type, priority, description, design, acceptance and what
   it is blocked by. It creates nothing, calls neither `submit_plan` nor
   `factory_transition_work_item`, and asks the person to review the proposal
   and move the card to Building.
3. A person moves the card to Building. That move is the approval. The
   Building `manual` handler, `createBeadsEpicBuildRule`, starts the skill in
   **file** mode on the work seat; it wraps Work's `buildWorkItem`
   (`dist/boards/work.js:110-121`, wired at `:190`), so every other card still
   gets Work's build prompt.

   Close the card's session view, or wait for the propose run to finish,
   before approving. While the card's session is open, the Factory UI makes
   the session the card's owner and disables every move into a working
   phase, Building included, in the card menu. In `mastra` 1.33.0
   (`node_modules/mastra/dist/factory/assets/index-BaghZlUk.js`), `jL` sets
   the owner to `{kind: 'session'}` whenever the card has a session status,
   and the menu items are enabled by `fM`, which allows a move into a
   working phase (`ldt`: not `resting` and not `terminal`) only when the
   owner is `free` (`_L`). A greyed-out "Move to Building" is that UI
   rule, not the board policy.
4. The skill files exactly the latest proposal: one `beads_create` per child
   with `parent` set to the epic, then `beads_dep_add` for each dependency, and
   a note on the epic listing the ids. It writes no code and opens no pull
   request. It then moves the card to Intake with
   `factory_transition_work_item`.
5. The next tick finds the children and turns the card into the overview
   card. From there it is an overview card like any other: it closes when its
   last child closes.

| Decision | Planning | Building |
|----------|----------|----------|
| `type` | `invokeSkill` | `invokeSkill` |
| `role` | `plan` | `work` |
| `skillName` | `factory-beads-epic` | `factory-beads-epic` |
| `arguments` | `Mode: propose. The epic bead <id> in repository <owner/name>` | `Mode: file. The epic bead <id> in repository <owner/name>` |
| `idempotencyKey` | `<ingress id>:factory-beads-epic:propose` | `<ingress id>:factory-beads-epic:file` |

The decision shapes are checked with Factory's own
`validateFactoryRuleDecision` in the tests.

**The board policy** (`board-rules.ts`):

| Move of a planning card | Result |
|-------------------------|--------|
| Into Triage or Review, by anyone | Rejected, `forbidden`. |
| Into Building (`execute`) by an agent, the system, or any actor that is not a person, from any phase | Rejected, `approval_required`, whatever `plansAutoApproved` and `planApproved` say. |
| Into Done by any actor that is not a person | Rejected, `approval_required`: Done would close the epic with no children. |
| Into Building, Done or Canceled by a person | Allowed (then Work's own policy decides, and accepts the card as for any card a person starts). |
| Into Planning, or from Building back to Intake (the file run's move) | Left to Work's policy, which allows them. |

Auto-approve plans never approves an epic's plan (owner decision). Work's
plan gate lets a non-human actor into Building in two cases
(`dist/boards/work-transition-policy.js:15-19`): the project's auto-approve
setting, and a move stamped `planApproved`. The second comes from an approved
`submit_plan`: Work's tool rule asks for Building
(`dist/boards/work-tool-rules.js:8-16`) and the processor sends that move as
actor system with `planApproved: true` (`dist/rules/processor.js:381-402`).
With auto-approve on, the dispatcher answers a parked `submit_plan` with
"approved" itself (`dist/rules/dispatcher.js:107-112`), so a `planApproved`
move cannot be told apart from a person's approval in the policy. The
planning-card rule therefore refuses every non-human move into Building and
never reads either flag. A person approves only by moving the card, which is
`actor.type === 'human'`, the same test Work's gate uses. The skill does not
call `submit_plan`.

`submit_plan` cannot carry this approval anyway (live finding, 2026-10-09,
dev Factory). The propose run is on the plan seat, which has no sandbox, so
the card's Plan panel cannot load a plan file and its "Approve & build"
control stays disabled. The flow above was checked end to end on the same
day: propose mode appended the proposal and created nothing, a person moved
the card to Building, file mode created exactly the approved child, and the
card turned into the epic's overview card with the child linked under it.

The build phase is Work's `execute`, passed as `buildPhase`: Review shares
its `work` role, so the role alone does not name it.

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
Code: `packages/factory-beads/src/integration.ts:410-439` (`agentTools`),
`src/agent-tools.ts` (the tools), `src/tool-ops.ts` (host-side runs).

`agentTools` never throws (`integration.ts:410-439`). The SDK awaits the
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
    (`integration.ts:752-768`).
  - exit 2 or 4: the repository is **parked**, exactly as for a write-back
    conflict: state `parked`, no pull, no intake and no tool writes until an
    operator resolves it and calls `POST /web/beads/reset` (`tool-ops.ts:200`).
    The park is a marker in the copy's own `.git`, so it lasts exactly as long
    as the conflicted copy; the reset drops the copy and the marker together
    (`integration.ts:619-633`, `:652-658`, `:1343-1364`). Reads still work while parked.
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
it as ready, so it is carded only as the overview card of its steps (see
[Overview cards](#overview-cards)).

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
each (`integration.ts:684-751`, retries in `#syncWithRetry` at `:1265-1274`):

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
  milestone and pinned exclusion; claim conflicts; ordering (B is carded only after A's card
  reaches Done and A is closed and synced); the lease; the description
  comment (one per card across sweeps and restarts, back-fill, no comment for
  an empty description, no feed, a failing feed, truncation); the card's
  `repository` (one repository, two repositories in one project, back-fill),
  checked with `@mastra/factory`'s real `resolveWorkItemRepository`; and, in
  `test/states.test.ts`, the on/off switch, both startup preconditions, the
  `no-beads-data` state across repeated sweeps and its re-check, and the
  status route. Overview cards: an epic, a nested epic, a molecule root and a
  milestone each carded before their children and linked to them; childless
  containers and non-container parents; back-fill of a missing parent and a
  hand-set parent kept; the open-children count, written only on change; a
  child or a container carded in another project; a failed children read.
  Closing overview cards (samskara-l2t.2.2): the epic card committed to Done
  when both children are done, and the next tick closing and syncing the
  epic; an open epic whose children were all closed before its first sweep,
  carded as an overview card and committed to Done in that sweep, then
  closed; a replay at the same revision and a new evaluation at a new one (the
  harness stores a stale evaluation as rejected, as Factory does); no move
  with a child open, with an unread count, or for an open childless
  container; the count of a container closed while a child is ready; a
  molecule root closed by bd and synced with no close call; the re-arm of a
  `close-failed` container card, its once-only limit, and no re-arm for a
  work card or a container with an open child. Research cards
  (samskara-l2t.2.3): an open decision carded as `research`, a task with no
  kind, a closed decision never carded; a decision linked under its epic; the
  kind back-filled once on an older card and cleared when the bead stops being
  a decision, with no write on later sweeps; a person's Done closing the bead.
  Planning cards (samskara-l2t.2.4): a childless open epic carded as `plan`
  under its milestone's overview card, an epic with children as an overview
  card, a closed epic never carded, stable across sweeps; the flip to
  `overview` when children appear (one write, children linked, never flipped
  back), also for an epic that is not ready; no planning card from a failed
  children read; the kind back-filled and cleared; a stranded overview card
  committed to Intake only once its run binding is gone, and no move for a
  resting, terminal, non-overview or Done-bound card. Legacy cards and
  subtasks (samskara-l2t.2.5): ready parents ordered before their children
  (and a parent cycle that cannot loop); a subtask linked under its parent
  task's card in the same sweep, the task left a work card, no write on later
  sweeps; a subtask carded before its parent's card, linked once the parent is
  carded; a task card parked `close-failed` because a subtask was open,
  re-armed and closed once the subtask closes (the fake bd refuses to close a
  bead with an open child, as bd 1.3.1 does); a stranded overview card held
  by its phase's `work` seat but not by a `chat` seat; a refused move
  replayed on every retry, after the card changed, and failed after five
  attempts; the Done handler waking the worker when the dispatcher moves an
  overview card to Done. The harness records each `commitRuleEvaluation`,
  and its `applyDecisions()` stands in for Factory's dispatcher and
  transition service on the Requests board this project installs
  (`src/mastra/boards/requests-board.ts`: Work's own policy wrapped by
  `createBeadsTransitionPolicy`): one call is one dispatcher pass; each
  decision is a transition with ingress `decision:<key>` whose stored result
  is replayed on later attempts; a fresh one checks `allowsTransition`, asks
  the policy with Factory's snapshot fields, runs the phases' `manual`
  `onExit`/`onEnter` handlers (the Done handler included) and moves the
  card; a refusal is retried until the fifth attempt fails it. The harness
  store checks `parentWorkItemId` with Factory's own
  `validateParentRelation`. The harness remote carries `refs/dolt/data` unless a test
  removes it (`setBeadsData`). The fake feed
  (`MemoryFeed` in `test/harness.ts`) copies the store's replay behaviour.
- `test/real-bd.test.ts` runs a **real** bd and git end to end against a bare
  repository in a temp directory, through a `git+file://` Dolt remote, including
  an epic with two children and a nested epic, and a real `bd mol pour` whose
  root card is linked to its first step's card. It also closes an epic and a
  molecule with their last children: the epic is closed by `factory-beads`,
  the molecule root by bd with its last step, and both closes reach the
  remote. It also cards an open decision (filed with empty required sections,
  through `--validate`) as a research card, never cards a closed one, and
  closes the open one when its card reaches Done. It cards a childless epic
  as a planning card, files two children under it through the real
  `beads_create` and `beads_dep_add` tools, and the next sweep turns the card
  into an overview card with the ready child linked under it. It links a
  subtask's card under its parent task's card without making the task an
  overview card, shows bd refusing the task's close while the subtask is
  open, and closes it after the re-arm once the subtask is done. It is
  **local-only**: it is skipped when `bd` is not on PATH, and the CI workflow
  does not install bd. Set `FACTORY_BEADS_REAL_BD=0` to skip it on a machine
  that has bd.
- The plan gate for cards that are not created by a person, the overview
  card policy (every working phase refused for a person, an agent and the
  system; Done refused with open children; Done and Canceled allowed
  otherwise; other cards unchanged), and the research card policy and
  planning rule (Triage, Building and Review refused for every actor; Done
  refused with `approval_required` for a plan agent, a work agent and the
  system, with and without auto-approved plans; Done, Canceled and Planning
  allowed for a person; the decision skill started for a research card and
  Work's `factory-plan` decision for every other card; the skill file's
  location and frontmatter), and the planning card policy and rules (Triage
  and Review refused for every actor; Building refused for a plan agent, a
  work agent and the system with every combination of `plansAutoApproved` and
  `planApproved`, including the approved `submit_plan` path through Work's own
  tool rule; Done refused for the same actors; Building, Done and Canceled
  allowed for a person; the file run's move back to Intake allowed; a work
  agent and the system moving an overview card out of Building to Intake
  allowed, and into Review refused with the reason that names Intake; the epic
  skill started in propose and file mode, the decision skill and Work's
  decisions unchanged for every other card) are covered by
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
- No board or integration hook runs when a session is started on a card.
  The UI's "Start session" calls `runs/start` with no destination stage,
  which binds a `chat` seat without a transition
  (`rules/start-coordinator.js:158-207`), so a board cannot refuse a session
  on a card that must never run, or start the card's own skill in it. See
  [Card kinds](#card-kinds).
