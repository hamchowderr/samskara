# Boards

A board defines the phases a work item moves through and what runs when it
enters each one. Mastra documents the general shape in
[configure/boards-and-rules](https://factory.mastra.ai/configure/boards-and-rules).
This page covers what that page does not.

## What ships

Two boards are installed, both under the built-in ids:

- **Work** (id `work`) — Samskara's own definition, titled **Requests**
  (`src/mastra/boards/requests-board.ts`). It replaces the built-in Work board.
- **Review** (id `review`) — the stock `reviewBoard`, unchanged.

`src/mastra/index.ts` sets `includeDefaultBoards: false` and passes
`boards: [requestsBoard, reviewBoard]`. Disabling the defaults removes BOTH
built-ins (`@mastra/factory` 0.20.0 `dist/boards/registry.js:5-7`), which is why
Review is installed again explicitly.

The Work board keeps Work's phases:

```
intake → triage → planning → execute (Building) → review → done
```

The Review board has its own (`dist/boards/review.js:58-92`):

```
intake → review (Reviewing) → done, or canceled
```

## Why our Work board exists

Each phase declares `onEnter` handlers keyed by where the item came from (see
[Source keys](#source-keys)). Work created in the UI, by chat or from Slack is
`manual`.

The built-in Work board runs triage for every tracker source but not for
`manual` (`@mastra/factory` 0.20.0, `dist/boards/work.js:157-163`):

```js
triage: {
  onEnter: {
    issue: triageIssueEntry,
    gitlabIssue: investigateTriagedGitLabIssue,
    linearIssue: investigateTriagedLinearIssue,
    jiraIssue: investigateTriagedJiraIssue,
    incidentioFollowUp: investigateTriagedIncidentioFollowUp,
  },
},
```

A `manual` card entering Triage there matches no handler and receives a generic
stage message instead of running the triage skill. Planning and Building
already declare `manual`, so only that one phase is affected, and it is the
phase that decides what the work is.

Our board is the exported `workBoard` with two changes
(`src/mastra/boards/requests-board.ts:56-70`):

- Triage also declares `manual`, using Work's own `issue` handler (it already
  formats a `manual` item's reference and handles the needs-approval case).
- Done also declares `manual: createBeadsDoneRule()`, which wakes the beads
  write-back when a beads card reaches Done and does nothing while the
  integration is off. See
  [operations/beads.md](operations/beads.md#the-done-rule).

Everything else (phases, roles, transition policy, the `submit_plan` tool rule,
other sources' handlers) is read from `workBoard` at runtime, so upstream
changes flow through.

## Replacing Work by id

This is the pattern Mastra documents for customizing Work:

- `README.md:88-100`: "To replace Work or Review, disable both default boards
  and install a board with the same ID. You can reinstall the exported
  `workBoard` and `reviewBoard` definitions unchanged, or use their phases as
  the starting point for a customized definition." It also says to keep the
  built-in phase names and roles.
- `factory-skills/configure-factory-rules/SKILL.md:23`: "To customize Work or
  Review, set `includeDefaultBoards: false` and install a same-ID board,
  preferably using the exported `workBoard` or `reviewBoard` phases as the
  starting point."
- Added upstream in mastra-ai/mastra#25595 (Factory 0.19.0). A same-id board
  still throws `duplicate board id` while the defaults are enabled.

`README.md:118` still says "there is no built-in override or replacement API".
That sentence predates #25595 and contradicts `:88`. Follow `:88` and SKILL.md.

Keeping the id `work` matters because a lot of runtime and UI behaviour is
keyed to that literal string, and none of it reaches a board with another id:

| Keyed to `work` | Where (0.20.0 `dist/`) |
|---|---|
| Default GitHub rules: PR opened → Review, merged → Done, changes-requested review and PR comments sent to the builder, issue closed → Done/Canceled | `integrations/github/default-rules.js:69, :113, :148, :155, :207` |
| `submit_plan` advances an approved plan with `board: "work"` | `boards/work-tool-rules.js:13` |
| The triage agent gets the classification schema | `rules/tools.js:44, :69` |
| Cards with no stored board (Slack threads, legacy rows) belong to `work` | `boards/semantics.js:8` |
| UI: the `/factories/:id/work` page, the GitHub issue triage feed, card actions | Factory UI bundle |

The triage row matters: `workTransitionPolicy` rejects any triage-agent
transition that carries no classification (`boards/work-transition-policy.js:4-8`),
and only a board with the id `work` is offered the field. Under the old `requests`
id, a triage agent could never move a card.

### No arrival automation

Arrivals rest in Intake without starting a run. That is Mastra's preferred
behaviour (`README.md:102`), and SKILL.md:25 says: "Do not restore default
arrival automation on the built-in boards." Guarded arrival triage
(`README.md:104-116`, SKILL.md:27) is sanctioned for custom boards only. This
board is the built-in Work by id, so it declares none. A person moves a card
into Triage to start it.

The earlier `requests` board did restore guarded arrival triage on Intake for
`issue`, `linearIssue` and `manual`. That was removed with the switch.

## Source keys

Mastra's README and its types disagree about which keys exist.

| Source | README (0.20.0, line 88) | `rules/types.d.ts` `FACTORY_RULE_SOURCES` | Our Work board's Triage handles it |
|---|---|---|---|
| `issue` | yes | yes | yes |
| `pullRequest` | yes | yes | no (Review board) |
| `linearIssue` | yes | yes | yes |
| `manual` | yes | yes | yes (our addition) |
| `gitlabIssue` | no | yes | yes (from `workBoard`) |
| `gitlabPullRequest` | no | yes | no |
| `jiraIssue` | no | yes | yes (from `workBoard`) |
| `incidentioFollowUp` | no | yes | yes (from `workBoard`) |

Treat `FACTORY_RULE_SOURCES` as the list the runtime uses.

## Things that will catch you

### `defineBoard()` does not validate handler keys

A misspelled source — `pull-request` for `pullRequest` — type-checks, is stored,
and never fires. No error, no warning: `defineBoard()` validates phases, roles
and tools, but copies `onEnter` as given (`dist/boards/define-board.js`). Check
keys against [Source keys](#source-keys); `tests/boards/requests-board.test.ts`
does this for our board.

### A board with any other id loses the Work behaviour above

`advanceApprovedPlan` returns `board: "work"`, the default GitHub rules guard on
`context.board === "work"`, and the transition service refuses a transition
whose board differs from the card's (`rules/validation.js:76`). A custom board
with its own id therefore needs wrappers for each of those. Samskara had two
(`requests-github-rules.ts` for PR opened/merged, and a `submit_plan` override)
until the board took the id `work`; both are gone.

`tests/boards/work-board-github-rules.test.ts` drives the stock
`GithubIntegration` rules through the SDK's own validators against the
installed registry, for `manual` cards, GitHub-issue cards and Review cards.

### Installing a board is not routing work to it

A dispatched Slack thread is created at Building with no board assigned
(`integrations/slack/slack.js:570-585`). A card with no board belongs to `work`
(`boards/semantics.js:8`), which is now our board, so Slack cards land on it
without routing.

A card can be assigned a board by hand while its board is still unset. The
Factory gate answers an unauthenticated API call with 401
(`dist/auth.js:540-560`), so send it from a signed-in session; see
[Calling the Factory API by hand](troubleshooting.md#calling-the-factory-api-by-hand).
From the browser console of a signed-in tab:

```js
await fetch('/web/factory/work-items/<id>', {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ board: 'work', stages: ['triage'] }),
}).then(r => r.json());
```

A second attempt returns `board_already_assigned` (`dist/routes/work-items.js:558`).

## Adding another board

1. Start from `workBoard`'s phases, as `requests-board.ts` does.
2. Give it a new id, and remember that everything in
   [Replacing Work by id](#replacing-work-by-id) keyed to `work` will not reach
   it: you need your own tool rule, GitHub rule overrides and transition policy.
3. Pass it in the `boards` array in `src/mastra/index.ts`.
4. Check every `onEnter` key against `FACTORY_RULE_SOURCES`.
5. Start the server and move a card through every phase. Type-checking proves
   nothing here — a wrong key compiles.

The board UI is gated on the project having a linked repository. That gate wraps
the generic board renderer, so a custom board does not escape it.

A factory with two or more linked repositories needs a repository chosen for
each run: `routes/surface.js:189` throws `source_repository_ambiguous` rather
than picking one, and a board run stops with "Choose a repository for this
work item" (`rules/start-coordinator.js:87-88`).
See [operations/upgrading.md](operations/upgrading.md#behaviour-changes-in-0200).
Beads cards cannot choose one yet (`samskara-srl`); see
[operations/beads.md](operations/beads.md#limitations).
