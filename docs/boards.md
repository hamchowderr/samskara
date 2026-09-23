# Boards

A board defines the phases a work item moves through and what runs when it
enters each one. Mastra documents the general shape in
[configure/boards-and-rules](https://factory.mastra.ai/configure/boards-and-rules).
This page covers what that page does not.

## What ships

`includeDefaultBoards` stays on, so the built-in **Work** and **Review** boards
are installed. Samskara adds one more: **Requests**
(`src/mastra/boards/requests-board.ts`).

All three share the same six phases:

```
intake → triage → planning → execute (Building) → review → done
```

## Why Requests exists

Each phase declares `onEnter` handlers keyed by where the item came from (see
[Source keys](#source-keys)). Work created in the UI or by chat is `manual`.

The Work board runs triage for every tracker source but not for `manual`
(`@mastra/factory` 0.16.0, `dist/boards/work.js`):

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
already declare `manual`, so only that one phase is affected — and it is the
phase that decides what the work is.

Requests is a custom board, built with `defineBoard()` as Mastra's README
describes. It was modelled on the 0.15.0 Work board and handles the sources this
deployment uses: `issue`, `linearIssue` and `manual`. It is not derived
from `workBoard` at runtime, and should not be: the README says *"Built-in
customization is deferred; there is no built-in override or replacement API."*

## Source keys

Mastra's README and its types disagree about which keys exist.

| Source | README (0.16.0, line 88) | `rules/types.d.ts` `FACTORY_RULE_SOURCES` | Requests handles it |
|---|---|---|---|
| `issue` | yes | yes | yes |
| `pullRequest` | yes | yes | no (Review board) |
| `linearIssue` | yes | yes | yes |
| `manual` | yes | yes | yes |
| `gitlabIssue` | no | yes | no |
| `gitlabPullRequest` | no | yes | no |
| `jiraIssue` | no | yes | no |
| `incidentioFollowUp` | no | yes | no |

Treat `FACTORY_RULE_SOURCES` as the list the runtime uses. None of the last
four integrations is connected here, so Requests does not declare them. A card
from one of them would get a generic stage message on this board. If GitLab,
Jira or incident.io intake is ever connected, add its key to Requests first,
modelled on the Work board's handler for it.

## Four things that will catch you

### `defineBoard()` does not validate handler keys

A misspelled source — `pull-request` for `pullRequest` — type-checks, is stored,
and never fires. No error, no warning — 0.16.0 validates phases, roles and
tools, but copies `onEnter` as given (`dist/boards/define-board.js:68`). Check
keys against [Source keys](#source-keys).

### The SDK's plan-advance rule only works on the Work board

`advanceApprovedPlan` moves a card from Planning to Building when the plan agent
reports success. Its return type pins the destination:

```ts
readonly board: "work";        // boards/work-tool-rules.d.ts
```

The transition service rejects any transition whose board does not match the
item's. On a board with any other id the rule fires, asks for a transition on
`work`, and is refused — the plan sits in Planning with no error.

No parameterised variant is exported. `requests-board.ts` wraps the SDK rule and
overrides the board, keeping upstream's approval detection:

```ts
function advanceApprovedPlanOnThisBoard(context: FactoryToolResultRuleContext) {
  const transition = advanceApprovedPlan(context);
  if (!transition) return;
  return { ...transition, board: BOARD_ID } as const;
}
```

If upstream adds a board-aware variant, delete the wrapper.

### A custom board inherits nothing from Work

Not its transition policy, not its tool rules. Both are passed explicitly.
`workTransitionPolicy` and the tool rules are not re-exported from the package
root — they come through the `./*` wildcard export, which is why those imports
carry deeper paths.

### Installing a board is not routing work to it

Nothing sends chat-sourced work to a custom board. A dispatched Slack thread is
created at Building with no board assigned, and no mechanism moves it: intake
bindings are an issue-tracker contract Slack does not implement, label routes
skip non-issue sources, the rules dispatcher has no Slack source, and
cross-board transitions are rejected.

Moving one card by hand works while its board is still unset:

```bash
curl -X PATCH "$FACTORY/web/factory/work-items/<id>" \
  -H 'content-type: application/json' \
  -d '{"board":"requests","stages":["triage"]}'
```

A second attempt returns `board_already_assigned`.

So Requests currently serves manual items created in the UI. Routing
chat-sourced work needs support upstream does not yet provide.

## Adding a board

1. Copy `requests-board.ts` as a starting point — it already handles the
   transition policy, the tool rule and the source keys this deployment uses.
2. Give it a new id, and use a constant for it so the definition and any rule
   cannot drift apart.
3. Pass it in the `boards` array in `src/mastra/index.ts`.
4. Check every `onEnter` key against the four valid values.
5. Start the server and move a card through every phase. Type-checking proves
   nothing here — a wrong key compiles.

The board UI is gated on the project having a linked repository. That gate wraps
the generic board renderer, so a custom board does not escape it.
