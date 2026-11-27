/**
 * The Beads board's transition policy for overview, research, plan, gate and
 * held cards (beads-board.ts).
 *
 * The policy is evaluated for every transition, every actor included, before
 * the move commits, and a `reject` result ends the transition with the code
 * and reason given (@mastra/factory 0.31.0 dist/rules/transition-service.js:367).
 * It reads only the snapshot it is handed, so the sync worker keeps the facts
 * it needs (card kind, open-children count, held status) on the card's
 * metadata.
 *
 * An overview card stands for an epic, milestone or molecule root: it groups
 * its children's cards and holds no work itself (samskara-l2t.2). It enters no
 * working phase, and reaches Done only with no open children.
 *
 * A research card stands for an open decision bead (samskara-l2t.2.3). Its
 * only working phase is Researching, where the decision skill writes the
 * decision into the bead. Approval is a person moving it to Done, so any other
 * actor's move there is refused with `approval_required`.
 *
 * A plan card stands for a childless open epic (samskara-l2t.2.4). Proposing
 * writes its child beads into the epic's notes; Filing files them. Approval is
 * a person moving it into Filing, so every other actor's move there is refused
 * with `approval_required`. Only a person moves a plan card to Done, which
 * would close the epic without children.
 *
 * A gate card stands for an open human gate (samskara-l2t.9). It holds no
 * work, so it enters no working phase; a person approves it by moving it to
 * Done, which closes the gate. A person who moves it to Canceled leaves the
 * gate open, and the step stays held.
 *
 * Every other card is an ordinary bead: it may enter Work's phases, but not
 * the phases that run a decision's or an epic's skill.
 *
 * A held card (samskara-l2t.4) stands for a bead blocked, deferred, pinned,
 * hooked or set to a custom status in bd: the sync worker marks it
 * `beadsHeld`. No move from a resting or terminal phase into a working phase
 * is allowed while the marker is set, whoever makes it. Moves between working
 * phases pass: the sync worker moves such a card to Intake once its run has
 * finished.
 *
 * One exception to the Done gates (samskara-l2t.3): when the bead was already
 * closed outside the Factory, the sync worker marks the card
 * `beadsClosedOutside: <phase>` and commits the move as a rule decision. While
 * the marker names the target phase, any system move there is allowed
 * (`isClosedOutsideMove`). The gate guards the close, and the close has
 * already happened in bd.
 */
import type { BoardTransitionPolicy } from '@mastra/factory/boards';

import { BEADS_META, GATE_CARD_KIND, OVERVIEW_CARD_KIND, PLAN_CARD_KIND, RESEARCH_CARD_KIND } from './integration';

export interface BeadsTransitionPolicyOptions {
  /**
   * The board's working phases (phases declared `kind: 'working'`). An
   * overview or gate card never enters one; a held card starts none.
   */
  workingPhases: readonly string[];
  /** The done phase. Default `done`. */
  donePhase?: string;
  /** The one working phase a research card may enter (beads-board.ts `research`). */
  researchPhase: string;
  /** Where a plan card's children are proposed (beads-board.ts `epic-plan`). */
  proposePhase: string;
  /** Where a plan card's approved children are filed, on a person's move (beads-board.ts `epic-file`). */
  filePhase: string;
  /** Phases only a research or plan card may enter: an ordinary bead never runs those skills. */
  beadsOnlyPhases: readonly string[];
}

/**
 * Also what a run seated on an overview card reads when its move is refused
 * (rules/tools.js:53-87 returns the transition result to the agent): a card
 * made before overview cards existed may carry a live run, and the reason
 * names the moves still open to it.
 */
export const OVERVIEW_WORKING_REASON =
  'An overview card holds no work and closes when its last child closes; it belongs in Intake, so work on its children instead';
export const OVERVIEW_OPEN_CHILDREN_REASON = 'This overview card still has open children; it closes when its last child closes';
export const RESEARCH_WORKING_REASON =
  'A decision card is researched in Researching and approved by a person moving it to Done; it is never planned, built or reviewed';
export const RESEARCH_APPROVAL_REASON =
  'A person approves a decision by moving its card to Done; agents and automation never do, even when plans auto-approve';
export const PLAN_WORKING_REASON =
  "An epic's planning card proposes its children in Proposing and files them in Filing; it is never planned, built or reviewed";
export const PLAN_APPROVAL_REASON =
  "A person approves an epic's proposed children by moving its card to Filing; agents and automation never do";
export const PLAN_DONE_REASON =
  "Only a person moves an epic's planning card to Done, which closes the epic with no children";
export const GATE_WORKING_REASON =
  'An approval card holds no work: a person approves it by moving it to Done, which resolves the gate and lets the step it holds start';
export const GATE_APPROVAL_REASON = 'A person approves a gate by moving its card to Done; agents and automation never do';
export const BEADS_ONLY_PHASE_REASON =
  "This phase runs a decision's or an epic's beads skill; other cards are planned in Planning";
/** Why work does not start on a card whose bead is held in bd (samskara-l2t.4). */
export function heldReason(status: string): string {
  return `This card's bead is ${status} in bd; work starts on it once the bead is open or in_progress again`;
}

/**
 * Whether this is a system move of a card whose bead was already closed
 * outside the Factory to the phase the card's `beadsClosedOutside` marker
 * names (samskara-l2t.3). The sync worker sets the marker while the bead is
 * closed and commits the move as a rule decision. The policy cannot tell
 * that move from any other system move: Factory's dispatcher applies every
 * committed rule decision as `{ type: 'system', id:
 * 'factory-rule-dispatcher' }` (@mastra/factory
 * dist/rules/dispatcher.js), whichever rule or integration
 * committed it. So while the marker names the target phase, any system move
 * to that phase passes, not only the sync worker's. The marker is cleared
 * once the bead is open again; a deleted bead is no longer in bd's list, so
 * the worker never reads it again and its card's marker is never cleared.
 *
 * A research, plan or gate card's Done gate exists so that a person approves the
 * close; a bead closed in bd has nothing left to approve, and refusing the
 * move would leave the card in a working phase, or Intake, for a closed
 * bead. An agent's own move does not get this: the actor must be the
 * system, and no beads tool closes a bead (agent-tools.ts). A rule that
 * turns an agent's tool result into a system move to the marked phase
 * would pass, as any system move does.
 */
export function isClosedOutsideMove(context: { actor: { type: string }; toStage: string; item: { metadata?: unknown } }): boolean {
  const metadata = context.item.metadata as Readonly<Record<string, unknown>> | null | undefined;
  return context.actor.type === 'system' && metadata?.[BEADS_META.closedOutside] === context.toStage;
}

/** Whether a card's metadata marks it as a beads overview card. */
export function isOverviewCard(metadata: Readonly<Record<string, unknown>> | null | undefined): boolean {
  return metadata?.[BEADS_META.cardKind] === OVERVIEW_CARD_KIND;
}

/** Whether a card's metadata marks it as a beads research card (an open decision). */
export function isResearchCard(metadata: Readonly<Record<string, unknown>> | null | undefined): boolean {
  return metadata?.[BEADS_META.cardKind] === RESEARCH_CARD_KIND;
}

/** Whether a card's metadata marks it as a beads gate card (an open human gate). */
export function isGateCard(metadata: Readonly<Record<string, unknown>> | null | undefined): boolean {
  return metadata?.[BEADS_META.cardKind] === GATE_CARD_KIND;
}

/** Whether a card's metadata marks it as a beads plan card (a childless open epic). */
export function isPlanCard(metadata: Readonly<Record<string, unknown>> | null | undefined): boolean {
  return metadata?.[BEADS_META.cardKind] === PLAN_CARD_KIND;
}

/**
 * Wrap a board's own policy (Beads has none: pass undefined) with the beads
 * card rules above. Every move the rules do not decide gets `basePolicy`'s
 * answer.
 */
export function createBeadsTransitionPolicy(
  basePolicy: BoardTransitionPolicy | undefined,
  options: BeadsTransitionPolicyOptions,
): BoardTransitionPolicy {
  const working = new Set(options.workingPhases);
  const donePhase = options.donePhase ?? 'done';
  const { researchPhase, proposePhase, filePhase } = options;
  const beadsOnly = new Set(options.beadsOnlyPhases);
  return context => {
    const metadata = context.item.metadata as Readonly<Record<string, unknown>> | null;
    // A held bead (samskara-l2t.4): work does not start, whoever moves the
    // card. Only a move from outside the working phases starts work; a run
    // already going keeps its own moves, as the owner decided it finishes.
    const held = metadata?.[BEADS_META.held];
    if (typeof held === 'string' && held && working.has(context.toStage) && !working.has(context.fromStage)) {
      return { type: 'reject', code: 'forbidden', reason: heldReason(held) };
    }
    if (isOverviewCard(metadata)) {
      if (working.has(context.toStage)) {
        return { type: 'reject', code: 'forbidden', reason: OVERVIEW_WORKING_REASON };
      }
      if (context.toStage === donePhase && Number(metadata?.[BEADS_META.openChildren] ?? 0) > 0) {
        return { type: 'reject', code: 'forbidden', reason: OVERVIEW_OPEN_CHILDREN_REASON };
      }
    } else if (isResearchCard(metadata)) {
      if (working.has(context.toStage) && context.toStage !== researchPhase) {
        return { type: 'reject', code: 'forbidden', reason: RESEARCH_WORKING_REASON };
      }
      if (context.toStage === donePhase && context.actor.type !== 'human' && !isClosedOutsideMove(context)) {
        return { type: 'reject', code: 'approval_required', reason: RESEARCH_APPROVAL_REASON };
      }
    } else if (isPlanCard(metadata)) {
      if (working.has(context.toStage) && context.toStage !== proposePhase && context.toStage !== filePhase) {
        return { type: 'reject', code: 'forbidden', reason: PLAN_WORKING_REASON };
      }
      if (context.toStage === filePhase && context.actor.type !== 'human') {
        return { type: 'reject', code: 'approval_required', reason: PLAN_APPROVAL_REASON };
      }
      if (context.toStage === donePhase && context.actor.type !== 'human' && !isClosedOutsideMove(context)) {
        return { type: 'reject', code: 'approval_required', reason: PLAN_DONE_REASON };
      }
    } else if (isGateCard(metadata)) {
      if (working.has(context.toStage)) {
        return { type: 'reject', code: 'forbidden', reason: GATE_WORKING_REASON };
      }
      if (context.toStage === donePhase && context.actor.type !== 'human' && !isClosedOutsideMove(context)) {
        return { type: 'reject', code: 'approval_required', reason: GATE_APPROVAL_REASON };
      }
    } else if (beadsOnly.has(context.toStage)) {
      return { type: 'reject', code: 'forbidden', reason: BEADS_ONLY_PHASE_REASON };
    }
    return basePolicy?.(context);
  };
}
