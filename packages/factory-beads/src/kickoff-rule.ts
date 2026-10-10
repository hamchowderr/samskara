/**
 * The kickoff hint for beads cards (samskara-l2t.8).
 *
 * A Factory work item has no description field, and a beads card has no URL,
 * so a kickoff carries only the card's title. Factory's own tracker
 * integrations solve the same problem with a fetch hint appended to the run's
 * arguments, naming the tool that reads the full issue: Linear's "Start by
 * fetching the issue's full details (description and comments) with the
 * linear_get_issue tool", and the same for Jira and incident.io
 * (@mastra/factory 0.20.0 dist/boards/work.js:71-99). This does that for a
 * beads card, naming `beads_show`, which returns the bead in full: title,
 * description, design, acceptance criteria, notes, status and dependencies
 * (agent-tools.ts). It replaces the description comment the integration used
 * to post to the card's feed, which the feed block cut to 2,000 characters and
 * which never carried design, acceptance criteria or notes (owner decision,
 * samskara-l2t.8).
 *
 * The hint is appended to every `invokeSkill` decision the wrapped handler
 * returns for a beads card: to `arguments` for a skill run, to `prompt` for a
 * plain-prompt run (Work's Building). Every other card, and every other
 * decision, passes through unchanged.
 */
import type { FactoryRuleDecision, FactoryRuleHandler, FactoryStageRuleContext } from '@mastra/factory/rules/types';

import { BEADS_META } from './integration';

/** The hint for a card's bead, or undefined when the card is not a beads card. */
export function beadsKickoffHint(metadata: Readonly<Record<string, unknown>> | null | undefined): string | undefined {
  const beadId = metadata?.[BEADS_META.id];
  if (typeof beadId !== 'string' || !beadId) return undefined;
  const repo = metadata?.[BEADS_META.repo];
  const where = typeof repo === 'string' && repo ? ` in repository ${repo}` : '';
  return `This card is bead ${beadId}${where}. Start by reading the bead in full (description, design, acceptance criteria and notes) with the beads_show tool.`;
}

/**
 * Wrap a phase's `manual` onEnter handler so the runs it starts on a beads
 * card carry the kickoff hint. Wire it outermost:
 * `manual: withBeadsKickoffHint(existing.manual)`.
 */
export function withBeadsKickoffHint(
  handler?: FactoryRuleHandler<FactoryStageRuleContext>,
): FactoryRuleHandler<FactoryStageRuleContext> {
  return context => {
    const hint = beadsKickoffHint(context.item.metadata);
    const result = handler?.(context);
    // Synchronous when the wrapped handler is, as Work's own handlers are.
    return result instanceof Promise ? result.then(decision => withHint(decision, hint)) : withHint(result, hint);
  };
}

function withHint(decision: FactoryRuleDecision | void, hint: string | undefined): FactoryRuleDecision | void {
  if (!decision || !hint || decision.type !== 'invokeSkill') return decision;
  if (decision.prompt !== undefined) return { ...decision, prompt: `${decision.prompt}\n\n${hint}` } as FactoryRuleDecision;
  return { ...decision, arguments: decision.arguments ? `${decision.arguments}\n\n${hint}` : hint } as FactoryRuleDecision;
}
