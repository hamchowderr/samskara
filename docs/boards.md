# Boards

A board defines the phases a card moves through and what runs when it enters
each one. Mastra documents the general shape in
[configure/boards-and-rules](https://factory.mastra.ai/configure/boards-and-rules).
This page covers what that page does not, as of `@mastra/factory` 0.31.

## What changed in 0.31

Before 0.31 Samskara replaced Work with its own **Requests** board under the
id `work` (`includeDefaultBoards: false`), so that `manual` cards got the
triage skill and Done woke the beads worker. 0.31 removed every hook that
board used:

- A phase's `onEnter` and `onExit` are **ignored**. A working phase starts its
  run from `runner.skill`, the same for every card whatever its source
  (`dist/boards/define-board.d.ts:99-102`, `dist/boards/phase-runner.js`).
- Work has no Triage phase, and `includeDefaultBoards` is deprecated and
  ignored (`dist/factory.js` `warnIncludeDefaultBoards`).
- `work` can't be passed in `boards`, and a stored board keeps code behaviour
  (a transition policy, tool or event rules) only for its own key. A custom
  Work is stored with `factory.upsertBoard(board, { projects: 'all' })` and gets
  Work's code behaviour, not ours (`dist/factory.js` `upsertBoard`).
- The `reviewBoard` export is gone. The retired Review board is served only to
  projects that still have cards on it (`dist/boards/review.js`).
- Boards are per project. `runtime.boards` is a `ProjectBoardSource`, read with
  `load({ orgId, factoryProjectId })`.

So the Requests board had nothing left to do, and the beads policy could no
longer sit on Work. Samskara now runs Factory's Work unchanged and puts beads
cards on a board of their own.

## What ships

- **Work** (id `work`) — Factory's own:
  `intake → planning → execute (Building) → pr-review (Review) → done | canceled`.
  A project created before 0.31 keeps the Work it stored, Triage included.
- **Beads** (id `beads`) — `packages/factory-beads/src/beads-board.ts`, passed
  as `boards: [beadsBoard]` in `src/mastra/index.ts`.

`boards` is deprecated in favour of stored boards (mastra-ai/mastra#28920), but
boards passed there "still work: each project stores them once and is served
from its rows, with the code behaviour they declare"
(`dist/factory.d.ts`, `boards`). It is the one route that attaches a
`transitionPolicy` to an app key; a policy is deprecated but still enforced
(`dist/rules/transition-service.js:367`). When `boards` is removed upstream,
this needs a new home.

## The Beads board

| Phase | Kind | Runs | Who it is for |
|---|---|---|---|
| `intake` Intake | resting | nothing | every card arrives here |
| `research` Researching | working | `factory-beads-decision` | research cards (open decision beads) |
| `epic-plan` Proposing | working | `factory-beads-epic`, `Mode: propose` | planning cards (childless open epics) |
| `epic-file` Filing | working | `factory-beads-epic`, `Mode: file` | planning cards, on a person's move |
| `planning`, `execute`, `pr-review` | working | Work's own runners | ordinary beads |
| `done`, `canceled` | terminal | nothing | Done closes the bead |

Work's phases are copied as Work declares them, with two added moves the sync
worker makes: Building → Intake (a bead held in bd, samskara-l2t.4) and Done →
Intake (a bead reopened in bd, samskara-l2t.3). Work's own `execute` and `done`
have no move to Intake.

A run learns which bead it works from the card's **description**, which the
integration sets to the kickoff hint (`kickoff-rule.ts`): card detail reaches
the agent through the `factory-work-item` state signal
(`dist/boards/phase-runner.js`). Before 0.31 the hint was appended to each
`onEnter` decision instead.

The skills are app skills: `src/mastra/public/factory-skills/*/SKILL.md`,
which Factory finds on its own (`dist/skills/app-skills.js`
`findBoardSkillProblems`).

### The transition policy

`createBeadsTransitionPolicy` (`packages/factory-beads/src/board-rules.ts`)
reads only the snapshot it is handed; the sync worker keeps the facts it needs
on the card's metadata.

- **Overview card** (an epic, milestone or molecule root with children): no
  working phase; Done only with no open children.
- **Research card**: no working phase but Researching; Done only by a person.
- **Planning card**: no working phase but Proposing and Filing; Filing and Done
  only by a person.
- **Gate card** (an open human gate): no working phase; Done only by a person.
- **Ordinary bead**: anything Work allows, but never the three beads phases.
- **Held bead**: no move from a resting or terminal phase into a working one.
- A **system** move to the phase a `beadsClosedOutside` marker names always
  passes: the bead was already closed in bd.

`packages/factory-beads/test/beads-board.test.ts` covers each rule.

### Cards from before 0.31

Beads cards used to sit on `work`. Each sweep moves this repository's beads
cards from another board onto Beads, keeping the phase (Triage becomes Intake,
`REQUESTS_TO_BEADS_PHASE`), and writes the kickoff hint into a card with no
description. A finished card, and one with a session seated on its phase, stays
where it is, as Factory's own `moveCardToBoard` does
(`dist/boards/relocate.js`); a later sweep moves it once the session lets go.

### What was dropped

- **Done wakes the worker.** The old Done `onEnter` kicked the sync worker. No
  hook replaces it: `workItems.onBoardChanged` is one listener slot that the
  Factory's own board stream uses (`dist/factory.js:537`), and a transition
  policy must stay side-effect free. Write-back now waits for the next poll,
  60 s by default (`BEADS_POLL_INTERVAL_MS`).
- **Triage for `manual` cards.** Work has no Triage.

## Changing a board

1. Start from `workBoard`'s phases, as `beads-board.ts` does, and keep their
   ids: the GitHub rules move cards by the board's flow (`build`,
   `pullRequestReview`, `completed`, `canceled`), which Factory derives from
   the board; `GET /web/factory/projects/:id/boards` shows it as `flow`.
2. A new phase needs a `runner.skill` to start anything. `onEnter` does nothing.
3. Run `npm test`: `beads-board.test.ts` checks Work's phases and the skills.
4. Phases a stored board removes refuse to write while cards sit in them
   (`BoardWriteError` `phase_in_use`), so move those cards first.
