/**
 * The kickoff hint for beads cards (samskara-l2t.8).
 *
 * A beads card has no URL, so a phase run names it by title only
 * (@mastra/factory 0.31.0 dist/boards/phase-runner.js workItemReference). Card
 * detail reaches the agent through the `factory-work-item` state signal, and
 * 0.31 gives a card a `description`, so the integration writes this hint
 * there (integration.ts #createCard, #followBeadEdits): it names the bead and
 * the `beads_show` tool, which returns the bead in full (title, description,
 * design, acceptance criteria, notes, status and dependencies). The bead's own
 * text stays in bd; the card holds only the pointer (owner decision,
 * samskara-l2t.8).
 */
import { BEADS_META } from './integration';

/** The hint for a card's bead, or undefined when the card is not a beads card. */
export function beadsKickoffHint(metadata: Readonly<Record<string, unknown>> | null | undefined): string | undefined {
  const beadId = metadata?.[BEADS_META.id];
  if (typeof beadId !== 'string' || !beadId) return undefined;
  const repo = metadata?.[BEADS_META.repo];
  const where = typeof repo === 'string' && repo ? ` in repository ${repo}` : '';
  return `This card is bead ${beadId}${where}. Start by reading the bead in full (description, design, acceptance criteria and notes) with the beads_show tool.`;
}

