/**
 * The planning and building `onEnter` handlers for beads plan cards.
 *
 * A plan card is a childless open epic (samskara-l2t.2.4). Both phases run
 * the `factory-beads-epic` skill instead of Work's own decision:
 *
 *   - Planning (`role: 'plan'`), propose mode: the agent reads the epic and
 *     writes the child beads it proposes into the epic's notes with
 *     `beads_update`. It creates nothing, never calls `submit_plan` (the
 *     plan seat has no sandbox, so Factory's Plan panel cannot load a plan
 *     file and its Approve control stays disabled), and asks a person to
 *     approve by moving the card to Building.
 *   - Building (`role: 'work'`), file mode: entered only by a person's move
 *     (the board policy refuses every other actor, board-rules.ts), which is
 *     the approval. The agent files exactly the approved children with
 *     `beads_create` (`parent` = the epic) and `beads_dep_add`, writes no
 *     code, opens no pull request, and moves the card to Intake. The next
 *     sweep sees the children and makes the card an overview card.
 *
 * Beads cards classify as `manual` (integration.ts, header), so these are the
 * phases' `manual` handlers, each wrapping the handler it replaces: every card
 * that is not a plan card gets that handler's answer unchanged. Work's own
 * handlers are `planWorkItem` and `buildWorkItem` (@mastra/factory 0.20.0
 * dist/boards/work.js:101-109 and :110-121, wired at :176 and :190).
 *
 * The decisions have the shape of Work's planning decision
 * (rules/types.d.ts:429-457: `skillName` with `arguments`, no `prompt`) and
 * its idempotency scheme: the transition's ingress id plus the skill name
 * and mode, so each entry into a phase is one run and a replay of the same
 * transition is not a second one. The skill is a project skill: Factory merges
 * `src/mastra/public/factory-skills` over its bundled skills
 * (dist/workspace.js:23-33,119-136).
 */
import type { FactoryRuleHandler, FactoryStageRuleContext } from '@mastra/factory/rules/types';

import { isPlanCard } from './board-rules';
import { BEADS_META } from './integration';

/** The project skill a plan card runs in Planning and in Building. */
export const EPIC_SKILL = 'factory-beads-epic';

export type EpicSkillMode = 'propose' | 'file';

function epicDecision(context: FactoryStageRuleContext, mode: EpicSkillMode, role: 'plan' | 'work') {
  const metadata = context.item.metadata;
  const beadId = metadata?.[BEADS_META.id];
  const repo = metadata?.[BEADS_META.repo];
  const bead = typeof beadId === 'string' ? `epic bead ${beadId}` : `epic card ${context.item.id}`;
  return {
    type: 'invokeSkill' as const,
    idempotencyKey: `${context.ingress.id}:${EPIC_SKILL}:${mode}`,
    role,
    skillName: EPIC_SKILL,
    arguments: `Mode: ${mode}. The ${bead}${typeof repo === 'string' ? ` in repository ${repo}` : ''}`,
  };
}

/**
 * A `manual` onEnter handler for the board's plan phase: the epic skill in
 * propose mode for a plan card, otherwise `fallback`'s answer (pass the
 * research-card handler, which itself falls back to Work's). Wire it as
 * `manual: createBeadsEpicPlanningRule(createBeadsPlanningRule(work.manual))`.
 */
export function createBeadsEpicPlanningRule(
  fallback?: FactoryRuleHandler<FactoryStageRuleContext>,
): FactoryRuleHandler<FactoryStageRuleContext> {
  return context => (isPlanCard(context.item.metadata) ? epicDecision(context, 'propose', 'plan') : fallback?.(context));
}

/**
 * A `manual` onEnter handler for the board's build phase: the epic skill in
 * file mode for a plan card, otherwise `fallback`'s answer (pass Work's own
 * `workBoard.phases.execute.onEnter.manual`).
 */
export function createBeadsEpicBuildRule(
  fallback?: FactoryRuleHandler<FactoryStageRuleContext>,
): FactoryRuleHandler<FactoryStageRuleContext> {
  return context => (isPlanCard(context.item.metadata) ? epicDecision(context, 'file', 'work') : fallback?.(context));
}
