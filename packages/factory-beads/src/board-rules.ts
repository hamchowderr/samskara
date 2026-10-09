/**
 * The board transition policy for beads overview cards.
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
 */
import type { BoardTransitionPolicy } from '@mastra/factory/boards';

import { BEADS_META, OVERVIEW_CARD_KIND } from './integration';

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
}

export const OVERVIEW_WORKING_REASON = 'An overview card closes when its last child closes';
export const OVERVIEW_OPEN_CHILDREN_REASON = 'This overview card still has open children; it closes when its last child closes';

/** Whether a card's metadata marks it as a beads overview card. */
export function isOverviewCard(metadata: Readonly<Record<string, unknown>> | null | undefined): boolean {
  return metadata?.[BEADS_META.cardKind] === OVERVIEW_CARD_KIND;
}

/**
 * Wrap a board's own policy: overview cards never enter a working phase and
 * never reach Done with open children, whoever moves them. Every other card,
 * and every other move of an overview card, gets `workPolicy`'s answer
 * unchanged.
 */
export function createBeadsTransitionPolicy(
  workPolicy: BoardTransitionPolicy | undefined,
  options: BeadsTransitionPolicyOptions = {},
): BoardTransitionPolicy {
  const working = new Set(options.workingPhases ?? ['triage', 'planning', 'execute', 'review']);
  const donePhase = options.donePhase ?? 'done';
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
    return workPolicy?.(context);
  };
}
