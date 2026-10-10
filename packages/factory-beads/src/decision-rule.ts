/**
 * The planning-phase `onEnter` handler for beads research cards.
 *
 * A research card is an open decision bead (samskara-l2t.2.3). Entering
 * Planning starts the `factory-beads-decision` skill on the plan seat instead
 * of Work's `factory-plan`: the agent researches the options and writes
 * `## Decision`, `## Rationale` and `## Alternatives Considered` into the bead
 * with `beads_update`, then stops for a person. It writes no code and requests
 * no transition. Approval is a person moving the card to Done, which closes
 * the bead through the usual write-back; the board policy refuses every other
 * route there (board-rules.ts).
 *
 * Beads cards classify as `manual` (integration.ts, header), so this is wired
 * as the planning phase's `manual` handler, wrapping Work's own
 * (`planWorkItem`, @mastra/factory 0.20.0 dist/boards/work.js:101-109,176):
 * every card that is not a research card gets Work's decision unchanged.
 *
 * The decision has the shape Work's own planning decision has
 * (rules/types.d.ts:429-457: `skillName` with no `prompt`), and the same
 * idempotency key scheme: the transition's ingress id plus the skill name, so
 * each entry into Planning is one run and a replay of the same transition is
 * not a second one. The skill is a project skill: Factory merges
 * `src/mastra/public/factory-skills` over its bundled skills
 * (dist/workspace.js:23-33,119-136).
 */
import type { FactoryRuleHandler, FactoryStageRuleContext } from '@mastra/factory/rules/types';

import { isResearchCard } from './board-rules';
import { BEADS_META } from './integration';

/** The project skill a research card runs in Planning. */
export const DECISION_SKILL = 'factory-beads-decision';

/**
 * A `manual` onEnter handler for the board's plan phase: the decision skill
 * for a research card, otherwise `fallback`'s answer (pass Work's own
 * `workBoard.phases.planning.onEnter.manual`). Wire it as
 * `onEnter: { ...existing, manual: createBeadsPlanningRule(existing.manual) }`.
 */
export function createBeadsPlanningRule(
  fallback?: FactoryRuleHandler<FactoryStageRuleContext>,
): FactoryRuleHandler<FactoryStageRuleContext> {
  return context => {
    const metadata = context.item.metadata;
    // Same test as the board policy, so a research card never runs factory-plan
    // only to have the policy refuse its move to execute.
    if (!isResearchCard(metadata)) return fallback?.(context);
    const beadId = metadata?.[BEADS_META.id];
    const repo = metadata?.[BEADS_META.repo];
    const bead = typeof beadId === 'string' ? `Decision bead ${beadId}` : `Decision card ${context.item.id}`;
    return {
      type: 'invokeSkill',
      idempotencyKey: `${context.ingress.id}:${DECISION_SKILL}`,
      role: 'plan',
      skillName: DECISION_SKILL,
      arguments: typeof repo === 'string' ? `${bead} in repository ${repo}` : bead,
    };
  };
}
