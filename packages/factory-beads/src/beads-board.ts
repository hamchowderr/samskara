/**
 * The Beads board (@mastra/factory 0.31).
 *
 * Factory 0.31 ignores a phase's `onEnter` and `onExit`: a phase starts its
 * run from `runner.skill` alone (dist/boards/define-board.d.ts:99-102,
 * dist/boards/phase-runner.js). One skill per phase means a card's kind can no
 * longer pick the skill inside a shared phase, as the 0.22 `manual` handlers
 * did on the Work board. So beads cards live on their own board, and each
 * beads-specific run has its own phase:
 *
 *   - `research` runs `factory-beads-decision` on a research card (an open
 *     decision bead);
 *   - `epic-plan` runs `factory-beads-epic` in propose mode on a plan card
 *     (a childless open epic);
 *   - `epic-file` runs it in file mode, entered only by a person's move.
 *
 * Every other phase is Work's own (dist/boards/work.js), so an ordinary bead
 * is planned, built and reviewed exactly as a Work card is. A custom
 * `transitionPolicy` cannot be attached to Work any more: a stored board keeps
 * code behaviour only for its own key, and `work` can't be passed in
 * `boards`. It is deprecated but still enforced on an app board
 * (dist/rules/transition-service.js:367), which is why this board carries it.
 *
 * A run learns which bead it is working from the card's description, which
 * the integration sets to the kickoff hint (kickoff-rule.ts): card detail
 * reaches the agent through the `factory-work-item` state signal
 * (phase-runner.js:19-21). See docs/operations/beads.md.
 */
import { defineBoard, workBoard } from '@mastra/factory';

import { createBeadsTransitionPolicy } from './board-rules';

/** The board's key. Cards the integration makes go here. */
export const BEADS_BOARD_ID = 'beads';
/** The project skill a research card runs. */
export const DECISION_SKILL = 'factory-beads-decision';
/** The project skill a plan card runs, in propose then file mode. */
export const EPIC_SKILL = 'factory-beads-epic';

/** Phases that exist only for one beads card kind. */
export const BEADS_PHASES = {
  research: 'research',
  epicPlan: 'epic-plan',
  epicFile: 'epic-file',
} as const;

const work = workBoard.phases;

/**
 * Phases a card on the old Work-based Requests board sat in, mapped to this
 * board. Triage is gone from Work in 0.31: a card there waits in Intake.
 */
export const REQUESTS_TO_BEADS_PHASE: Readonly<Record<string, string>> = {
  triage: 'intake',
  intake: 'intake',
  planning: 'planning',
  execute: 'execute',
  'pr-review': 'pr-review',
  review: 'pr-review',
  done: 'done',
  canceled: 'canceled',
};

const workingPhases = ['planning', 'execute', 'pr-review', BEADS_PHASES.research, BEADS_PHASES.epicPlan, BEADS_PHASES.epicFile];

export const beadsBoard = defineBoard({
  id: BEADS_BOARD_ID,
  name: 'Beads',
  description: "Ready beads from each linked repository's bd database. Done closes the bead.",
  initialPhase: 'intake',
  sourceClosed: workBoard.sourceClosed,
  transitionPolicy: createBeadsTransitionPolicy(undefined, {
    workingPhases,
    donePhase: 'done',
    researchPhase: BEADS_PHASES.research,
    proposePhase: BEADS_PHASES.epicPlan,
    filePhase: BEADS_PHASES.epicFile,
    beadsOnlyPhases: Object.values(BEADS_PHASES),
  }),
  phases: {
    intake: {
      name: work.intake.name,
      kind: 'resting',
      nextPhases: ['planning', BEADS_PHASES.research, BEADS_PHASES.epicPlan, 'pr-review', 'done', 'canceled'],
    },
    [BEADS_PHASES.research]: {
      name: 'Researching',
      description: 'A decision bead: the agent researches it and writes the decision into the bead. A person approves by moving it to Done.',
      kind: 'working',
      runner: { skill: DECISION_SKILL, context: 'work' },
      nextPhases: ['intake', 'done', 'canceled'],
    },
    [BEADS_PHASES.epicPlan]: {
      name: 'Proposing',
      description: "A childless epic: the agent proposes its child beads in the epic's notes. A person approves by moving it to Filing.",
      kind: 'working',
      runner: { skill: EPIC_SKILL, context: 'work', instructions: 'Mode: propose' },
      nextPhases: [BEADS_PHASES.epicFile, 'intake', 'done', 'canceled'],
    },
    [BEADS_PHASES.epicFile]: {
      name: 'Filing',
      description: 'The agent files exactly the approved child beads, then hands the card back to Intake.',
      kind: 'working',
      runner: { skill: EPIC_SKILL, context: 'work', instructions: 'Mode: file' },
      nextPhases: ['intake', BEADS_PHASES.epicPlan, 'done', 'canceled'],
    },
    planning: { ...work.planning },
    // Plus Intake: the sync worker moves a card whose bead is held in bd out
    // of its working phase to Intake once its run ends (samskara-l2t.4), and
    // Work's Building has no move there.
    execute: { ...work.execute, nextPhases: [...work.execute.nextPhases, 'intake'] },
    'pr-review': { ...work['pr-review'] },
    // Plus Intake: a bead reopened in bd moves its card back (samskara-l2t.3).
    done: { ...work.done, nextPhases: [...work.done.nextPhases, 'intake'] },
    canceled: { ...work.canceled },
  },
});
