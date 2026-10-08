/**
 * The done-phase `onEnter` handler that triggers write-back.
 *
 * It ONLY wakes the sync worker. Board rules run before the transition
 * commits, inside a 5 s timeout (@mastra/factory 0.20.0
 * dist/rules/transition-service.js:9 RULE_TIMEOUT_MS, :93-96): a side effect
 * there could fire for a move that then fails to commit, and `bd sync`
 * routinely takes longer than 5 s. The worker re-reads committed card state
 * and writes under the single-writer lease.
 *
 * It returns no decision, so it can never block or alter the move.
 */
import type { FactoryRuleHandler, FactoryStageRuleContext } from '@mastra/factory/rules/types';

interface Kickable {
  kick(): void;
}

const live = new Set<Kickable>();

/** @internal Called by each BeadsIntegration on construction. */
export function registerLive(integration: Kickable): void {
  live.add(integration);
}

/**
 * A `manual` onEnter handler for the board's done phase. Beads cards classify
 * as `manual` (their externalSource integration is not a known tracker), so
 * wire it as `onEnter: { ...existing, manual: createBeadsDoneRule() }`.
 *
 * Safe to install when the integration is off: with no live integration in the
 * process it does nothing.
 */
export function createBeadsDoneRule(): FactoryRuleHandler<FactoryStageRuleContext> {
  return context => {
    if (typeof context.item.metadata?.beadsId !== 'string') return undefined;
    for (const integration of live) integration.kick();
    return undefined;
  };
}
