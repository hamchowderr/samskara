/**
 * The Requests board — the built-in Work board, with chat-submitted work treated
 * as first class. It REPLACES Work: same id (`work`), installed with
 * `includeDefaultBoards: false` beside the stock Review board.
 *
 * WHY THIS EXISTS
 * The built-in Work board declares its triage handler for tracker items only
 * (`@mastra/factory` 0.20.0 boards/work.js:157-163):
 *
 *   triage:   onEnter: { issue, gitlabIssue, linearIssue, jiraIssue, incidentioFollowUp }  <- no `manual`
 *   planning: onEnter: { …, manual }                                                     <- `manual` present
 *
 * Work a client submits through chat or Slack classifies as `manual`. On the
 * stock board such a card reaches Triage and gets a generic stage message
 * instead of the triage skill. This board adds `manual` to Triage and is
 * otherwise Work's own definition.
 *
 * WHY THE SAME ID
 * This is the documented way to customize Work (README.md:88-100,
 * factory-skills/configure-factory-rules/SKILL.md:23; mastra-ai/mastra#25595):
 * disable the defaults, install a same-id board built from the exported
 * `workBoard` phases, keep its phase names and roles. Runtime behaviour keyed to
 * the literal id `work` then applies to this board: the default GitHub rules
 * (PR opened/merged, review feedback, PR comments, issue closed),
 * `submit_plan`'s `board: "work"` transition, the triage classification tool
 * (rules/tools.js:44,69), cards with no stored board such as Slack threads
 * (boards/semantics.js:8), and the Factory UI's Work page.
 *
 * NO ARRIVAL AUTOMATION
 * Arrivals rest in Intake without starting a run (README.md:102,
 * SKILL.md:25: "Do not restore default arrival automation on the built-in
 * boards"). Guarded arrival triage (README.md:104-116) is sanctioned for
 * CUSTOM boards only, and this board is the built-in Work by id, so it declares
 * none. A person moves a card into Triage to start it.
 */

import { defineBoard, workBoard } from '@mastra/factory';
import type { FactoryRuleHandler, FactoryStageRuleContext } from '@mastra/factory/rules/types';
import {
  createBeadsDoneRule,
  createBeadsEpicBuildRule,
  createBeadsEpicPlanningRule,
  createBeadsPlanningRule,
  createBeadsTransitionPolicy,
  withBeadsKickoffHint,
} from '@samskara/factory-beads';

const workTriage = workBoard.phases.triage.onEnter ?? {};
const workPlanning = workBoard.phases.planning.onEnter ?? {};
const workExecute = workBoard.phases.execute.onEnter ?? {};

/**
 * Work's own policy, wrapped so a beads overview card (an epic's, milestone's
 * or molecule root's card) never enters a working phase and never reaches
 * Done while a child is open; a research card (an open decision's) enters
 * no working phase but Planning and reaches Done only by a person's move; and
 * a plan card (a childless epic's) enters no working phase but Planning and
 * Building, and reaches Building or Done only by a person's move, whatever
 * the auto-approve-plans setting. The one exception: the sync worker's move
 * of a card whose bead was already closed in bd (samskara-l2t.3,
 * `isClosedOutsideMove`). Every other card gets Work's answer
 * unchanged. The working phases are read from the phases' declared `kind`,
 * and the plan phase from its `role` (configure-factory-rules/SKILL.md:65).
 * The build phase is Work's `execute`: Review shares its `work` role, so the
 * role alone does not name it. See docs/operations/beads.md.
 */
const transitionPolicy = createBeadsTransitionPolicy(workBoard.transitionPolicy, {
  workingPhases: Object.entries(workBoard.phases)
    .filter(([, phase]) => phase.kind === 'working')
    .map(([id]) => id),
  planningPhase: Object.entries(workBoard.phases).find(([, phase]) => phase.role === 'plan')?.[0],
  buildPhase: 'execute',
});

/**
 * Work's own GitHub-issue triage entry. It already handles a `manual` item: its
 * source reference degrades to the URL or title, and a needs-approval card gets
 * an approval summary instead of an investigation (boards/work.js:11-60).
 */
const triageEntry = workTriage.issue as FactoryRuleHandler<FactoryStageRuleContext>;

export const requestsBoard = defineBoard({
  id: workBoard.id,
  title: 'Requests',
  initialPhase: workBoard.initialPhase,
  transitionPolicy,
  tools: { ...workBoard.tools },
  // Where a card goes when its source closes (a GitHub, GitLab, Linear, Jira
  // or incident.io issue): Work's own mapping, Done or Canceled.
  // @mastra/factory 0.21.0 moves the card only when the board declares this
  // (boards/semantics.js resolveBoardClosure; integrations/*/default-rules.js),
  // so a board that copies Work's fields must copy this one too.
  sourceClosed: workBoard.sourceClosed,
  phases: {
    ...workBoard.phases,
    triage: {
      ...workBoard.phases.triage,
      // The line this board exists for: `manual` gets the triage skill. A beads
      // card's run is told to read its bead with beads_show (kickoff-rule.ts).
      onEnter: { ...workTriage, manual: withBeadsKickoffHint(triageEntry) },
    },
    planning: {
      ...workBoard.phases.planning,
      // A beads plan card (a childless epic) runs the factory-beads-epic
      // skill in propose mode, a research card (an open decision) the
      // factory-beads-decision skill; every other `manual` card gets Work's
      // own planning decision. See docs/operations/beads.md.
      onEnter: { ...workPlanning, manual: withBeadsKickoffHint(createBeadsEpicPlanningRule(createBeadsPlanningRule(workPlanning.manual))) },
    },
    execute: {
      ...workBoard.phases.execute,
      // A beads plan card, moved here by a person, runs the factory-beads-epic
      // skill in file mode: it files the approved children; the agent writes
      // no code and opens no pull request. Every other `manual` card gets Work's own
      // build decision. See docs/operations/beads.md.
      onEnter: { ...workExecute, manual: withBeadsKickoffHint(createBeadsEpicBuildRule(workExecute.manual)) },
    },
    done: {
      ...workBoard.phases.done,
      // Beads cards (`manual`) wake the beads worker, which closes and syncs
      // the bead. It only signals: board rules have a 5 s limit, and it does
      // nothing while BEADS_INTEGRATION is off. See docs/operations/beads.md.
      onEnter: { ...workBoard.phases.done.onEnter, manual: createBeadsDoneRule() },
    },
  },
});
