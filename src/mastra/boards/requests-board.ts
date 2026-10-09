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
import { createBeadsDoneRule, createBeadsTransitionPolicy } from '@samskara/factory-beads';

const workTriage = workBoard.phases.triage.onEnter ?? {};

/**
 * Work's own policy, wrapped so a beads overview card (an epic's, milestone's
 * or molecule root's card) never enters a working phase and never reaches
 * Done while a child is open; every other card gets Work's answer unchanged.
 * The working phases are read from the phases' declared `kind`
 * (configure-factory-rules/SKILL.md:65). See docs/operations/beads.md.
 */
const transitionPolicy = createBeadsTransitionPolicy(workBoard.transitionPolicy, {
  workingPhases: Object.entries(workBoard.phases)
    .filter(([, phase]) => phase.kind === 'working')
    .map(([id]) => id),
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
  phases: {
    ...workBoard.phases,
    triage: {
      ...workBoard.phases.triage,
      // The line this board exists for: `manual` gets the triage skill.
      onEnter: { ...workTriage, manual: triageEntry },
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
