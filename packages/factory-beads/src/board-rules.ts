/**
 * The board transition policy for beads overview cards and research cards.
 *
 * An overview card stands for an epic, milestone or molecule root: it groups
 * its children's cards and holds no work itself (samskara-l2t.2). Returning no
 * decision from the phase handlers is not enough to keep it from running: a
 * person's move into a working phase with no skill decision still starts a run
 * with a generic stage message (@mastra/factory 0.20.0
 * dist/rules/transition-service.js:296-311). The board's `transitionPolicy` is
 * the hook that can refuse the move itself: it is evaluated for every
 * transition, every actor included, before any phase rule
 * (transition-service.js:245-262), and a `reject` result ends the transition
 * with the code and reason given (:258-262).
 *
 * The policy reads only the snapshot it is handed, as the contract requires
 * (factory-skills/configure-factory-rules/SKILL.md:61-63: side-effect-free, no
 * storage). The sync worker keeps the open-children count on the card's
 * metadata for that reason.
 *
 * A research card stands for an open decision bead (samskara-l2t.2.3). Its
 * only working phase is Planning, where the decision skill researches and
 * writes the decision into the bead; it never enters Triage, Building or
 * Review. Approval is a person moving it to Done (owner decision,
 * samskara-l2t.2), so an agent or the system moving it there is refused with
 * `approval_required` whatever the project's auto-approve-plans setting:
 * Work's policy reads that setting only for Planning -> Building
 * (@mastra/factory 0.20.0 dist/boards/work-transition-policy.js:15-19), and
 * this policy never consults it.
 */
import type { BoardTransitionPolicy } from '@mastra/factory/boards';

import { BEADS_META, OVERVIEW_CARD_KIND, RESEARCH_CARD_KIND } from './integration';

export interface BeadsTransitionPolicyOptions {
  /**
   * Phases an overview card may never enter. Pass the board's working phases
   * (phases declared `kind: 'working'`): phase meaning belongs on the phase,
   * not in the policy (configure-factory-rules/SKILL.md:65). Default: Work's
   * working phases (boards/work.js:152-198).
   */
  workingPhases?: readonly string[];
  /** The done phase, which an overview card enters only with no open children. Default `done`. */
  donePhase?: string;
  /**
   * The one working phase a research card may enter: the board's plan phase.
   * Default `planning` (Work's `role: 'plan'` phase, boards/work.js:165-178).
   */
  planningPhase?: string;
}

export const OVERVIEW_WORKING_REASON = 'An overview card closes when its last child closes';
export const OVERVIEW_OPEN_CHILDREN_REASON = 'This overview card still has open children; it closes when its last child closes';
export const RESEARCH_WORKING_REASON =
  'A decision card is researched in Planning and approved by a person moving it to Done; it is never triaged, built or reviewed';
export const RESEARCH_APPROVAL_REASON =
  'A person approves a decision by moving its card to Done; agents and automation never do, even when plans auto-approve';

/** Whether a card's metadata marks it as a beads overview card. */
export function isOverviewCard(metadata: Readonly<Record<string, unknown>> | null | undefined): boolean {
  return metadata?.[BEADS_META.cardKind] === OVERVIEW_CARD_KIND;
}

/** Whether a card's metadata marks it as a beads research card (an open decision). */
export function isResearchCard(metadata: Readonly<Record<string, unknown>> | null | undefined): boolean {
  return metadata?.[BEADS_META.cardKind] === RESEARCH_CARD_KIND;
}

/**
 * Wrap a board's own policy: overview cards never enter a working phase and
 * never reach Done with open children, whoever moves them. Research cards
 * enter no working phase but Planning, whoever moves them, and only a person
 * moves one to Done. Every other card, and every other move of these cards,
 * gets `workPolicy`'s answer unchanged.
 */
export function createBeadsTransitionPolicy(
  workPolicy: BoardTransitionPolicy | undefined,
  options: BeadsTransitionPolicyOptions = {},
): BoardTransitionPolicy {
  const working = new Set(options.workingPhases ?? ['triage', 'planning', 'execute', 'review']);
  const donePhase = options.donePhase ?? 'done';
  const planningPhase = options.planningPhase ?? 'planning';
  return context => {
    const metadata = context.item.metadata as Readonly<Record<string, unknown>> | null;
    if (isOverviewCard(metadata)) {
      if (working.has(context.toStage)) {
        return { type: 'reject', code: 'forbidden', reason: OVERVIEW_WORKING_REASON };
      }
      if (context.toStage === donePhase && Number(metadata?.[BEADS_META.openChildren] ?? 0) > 0) {
        return { type: 'reject', code: 'forbidden', reason: OVERVIEW_OPEN_CHILDREN_REASON };
      }
    }
    if (isResearchCard(metadata)) {
      if (working.has(context.toStage) && context.toStage !== planningPhase) {
        return { type: 'reject', code: 'forbidden', reason: RESEARCH_WORKING_REASON };
      }
      // Not `isHumanTransition`: Work's plan gate keys on the actor alone too
      // (work-transition-policy.js:15). plansAutoApproved is deliberately unread.
      if (context.toStage === donePhase && context.actor.type !== 'human') {
        return { type: 'reject', code: 'approval_required', reason: RESEARCH_APPROVAL_REASON };
      }
    }
    return workPolicy?.(context);
  };
}
