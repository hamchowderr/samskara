/**
 * The Requests board — the built-in Work board, with chat-submitted work treated
 * as first class. It REPLACES Work: same id (`work`), installed with
 * `includeDefaultBoards: false` beside the stock Review board.
 *
 * WHY THIS EXISTS
 * The built-in Work board declares its triage handler for tracker items only
 * (`@mastra/factory` 0.20.0 boards/work.js:155-161):
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

const workTriage = workBoard.phases.triage.onEnter ?? {};

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
  ...(workBoard.transitionPolicy ? { transitionPolicy: workBoard.transitionPolicy } : {}),
  tools: { ...workBoard.tools },
  phases: {
    ...workBoard.phases,
    triage: {
      ...workBoard.phases.triage,
      // The line this board exists for: `manual` gets the triage skill.
      onEnter: { ...workTriage, manual: triageEntry },
    },
  },
});
