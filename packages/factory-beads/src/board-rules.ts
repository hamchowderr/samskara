/**
 * The board transition policy for beads overview, research and plan cards.
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
 *
 * A plan card stands for a childless open epic (samskara-l2t.2.4). Planning
 * proposes its child beads; Building files them. It never enters Triage or
 * Review. Approval is a person moving it into Building (owner decision,
 * samskara-l2t.2), so every other actor's move into Building is refused with
 * `approval_required`. That covers both routes Work's plan gate opens for a
 * non-human actor: the project's auto-approve-plans setting
 * (`plansAutoApproved`), and an approved `submit_plan` result, which Work's
 * tool rule turns into a system move to Building stamped `planApproved`
 * (boards/work-tool-rules.js:8-16, rules/processor.js:381-402). With
 * auto-approve on, the dispatcher approves a parked `submit_plan` itself
 * (rules/dispatcher.js:107-112), so a `planApproved` move cannot be told
 * apart from a person's approval, and is refused too. Only a person moves a
 * plan card to Done, which would close the epic without children.
 */
import type { BoardTransitionPolicy } from '@mastra/factory/boards';

import { BEADS_META, OVERVIEW_CARD_KIND, PLAN_CARD_KIND, RESEARCH_CARD_KIND } from './integration';

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
  /**
   * The phase a plan card's approved proposal is filed in: the board's build
   * phase. Default `execute` (Work's Building, boards/work.js:179-191).
   */
  buildPhase?: string;
}

/**
 * Also what a run seated on an overview card reads when its move is refused
 * (rules/tools.js:53-87 returns the transition result to the agent): a card
 * made before overview cards existed may carry a live run, and the reason
 * names the moves still open to it.
 */
export const OVERVIEW_WORKING_REASON =
  'An overview card holds no work and closes when its last child closes; move it to Intake and work on its children instead';
export const OVERVIEW_OPEN_CHILDREN_REASON = 'This overview card still has open children; it closes when its last child closes';
export const RESEARCH_WORKING_REASON =
  'A decision card is researched in Planning and approved by a person moving it to Done; it is never triaged, built or reviewed';
export const RESEARCH_APPROVAL_REASON =
  'A person approves a decision by moving its card to Done; agents and automation never do, even when plans auto-approve';
export const PLAN_WORKING_REASON =
  "An epic's planning card is planned in Planning and its children are filed in Building; it is never triaged or reviewed";
export const PLAN_APPROVAL_REASON =
  "A person approves an epic's proposed children by moving its card to Building; agents and automation never do, even when plans auto-approve";
export const PLAN_DONE_REASON =
  "Only a person moves an epic's planning card to Done, which closes the epic with no children";

/** Whether a card's metadata marks it as a beads overview card. */
export function isOverviewCard(metadata: Readonly<Record<string, unknown>> | null | undefined): boolean {
  return metadata?.[BEADS_META.cardKind] === OVERVIEW_CARD_KIND;
}

/** Whether a card's metadata marks it as a beads research card (an open decision). */
export function isResearchCard(metadata: Readonly<Record<string, unknown>> | null | undefined): boolean {
  return metadata?.[BEADS_META.cardKind] === RESEARCH_CARD_KIND;
}

/** Whether a card's metadata marks it as a beads plan card (a childless open epic). */
export function isPlanCard(metadata: Readonly<Record<string, unknown>> | null | undefined): boolean {
  return metadata?.[BEADS_META.cardKind] === PLAN_CARD_KIND;
}

/**
 * Wrap a board's own policy: overview cards never enter a working phase and
 * never reach Done with open children, whoever moves them. Research cards
 * enter no working phase but Planning, whoever moves them, and only a person
 * moves one to Done. Plan cards enter no working phase but Planning and
 * Building, and only a person moves one into Building or Done. Every other
 * card, and every other move of these cards, gets `workPolicy`'s answer
 * unchanged.
 */
export function createBeadsTransitionPolicy(
  workPolicy: BoardTransitionPolicy | undefined,
  options: BeadsTransitionPolicyOptions = {},
): BoardTransitionPolicy {
  const working = new Set(options.workingPhases ?? ['triage', 'planning', 'execute', 'review']);
  const donePhase = options.donePhase ?? 'done';
  const planningPhase = options.planningPhase ?? 'planning';
  const buildPhase = options.buildPhase ?? 'execute';
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
    if (isPlanCard(metadata)) {
      if (working.has(context.toStage) && context.toStage !== planningPhase && context.toStage !== buildPhase) {
        return { type: 'reject', code: 'forbidden', reason: PLAN_WORKING_REASON };
      }
      // From any phase, not only Planning: Work's gate covers Planning ->
      // Building alone. plansAutoApproved and planApproved are deliberately unread.
      if (context.toStage === buildPhase && context.actor.type !== 'human') {
        return { type: 'reject', code: 'approval_required', reason: PLAN_APPROVAL_REASON };
      }
      if (context.toStage === donePhase && context.actor.type !== 'human') {
        return { type: 'reject', code: 'approval_required', reason: PLAN_DONE_REASON };
      }
    }
    return workPolicy?.(context);
  };
}
