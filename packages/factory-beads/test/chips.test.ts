/**
 * Label chips (samskara-l2t.5): a card carries its bead's bd labels, its
 * priority as P0-P4 and its type in Factory's own `labels` metadata, which the
 * board draws as chips; a bead labelled `human` also carries Factory's
 * approval label, so Triage prepares an approval instead of investigating.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { FactoryStageRuleContext } from '@mastra/factory/rules/types';

import { requestsBoard } from '../../../src/mastra/boards/requests-board';
import { BEADS_META, CARD_LABEL_COLORS_META, CARD_LABELS_META, cardChips, NEEDS_APPROVAL_LABEL } from '../src/index';
import { createHarness, sweep } from './harness';
import type { Harness } from './harness';

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

const card = (harness: Harness, beadId: string) => harness.workItems.items.find(i => i.metadata?.[BEADS_META.id] === beadId)!;

describe('card chips (samskara-l2t.5)', () => {
  it('lists the bd labels, then P0-P4 and the type, and colors P0 and P1', () => {
    expect(cardChips({ labels: ['api', 'ui'], priority: 1, issue_type: 'bug' })).toEqual({
      labels: ['api', 'ui', 'P1', 'bug'],
      labelColors: { P1: '#ea580c' },
    });
    expect(cardChips({ priority: 3, issue_type: 'task' })).toEqual({ labels: ['P3', 'task'], labelColors: {} });
    expect(cardChips({ labels: ['human'], priority: 0, issue_type: 'decision' })).toEqual({
      labels: ['human', 'P0', 'decision', NEEDS_APPROVAL_LABEL],
      labelColors: { P0: '#dc2626' },
    });
  });

  it('puts the chips on the card and follows label and priority edits in bd, writing only on change', async () => {
    h = createHarness([{ id: 'w-1', title: 'One', priority: 2, labels: ['ui'] }]);
    const integration = h.integration();
    await sweep(integration);
    expect(card(h, 'w-1').metadata).toMatchObject({
      [CARD_LABELS_META]: ['ui', 'P2', 'task'],
      [CARD_LABEL_COLORS_META]: {},
      [BEADS_META.priority]: 2,
      [BEADS_META.type]: 'task',
    });
    const revision = card(h, 'w-1').revision;
    await sweep(integration);
    expect(card(h, 'w-1').revision).toBe(revision);

    h.bd('update', 'w-1', '--add-label=api', '--priority=0');
    await sweep(integration);
    expect(card(h, 'w-1').metadata).toMatchObject({
      [CARD_LABELS_META]: ['api', 'ui', 'P0', 'task'],
      [CARD_LABEL_COLORS_META]: { P0: '#dc2626' },
      [BEADS_META.priority]: 0,
    });
  });

  it("gives a bead labelled human Work's prepare-approval run in Triage", async () => {
    h = createHarness([{ id: 'w-1', title: 'Pick a vendor', labels: ['human'] }]);
    await sweep(h.integration());
    const item = card(h, 'w-1');
    expect(item.metadata?.[CARD_LABELS_META]).toContain(NEEDS_APPROVAL_LABEL);
    const triage = (await requestsBoard.phases.triage.onEnter!.manual!({
      ingress: { id: 'ingress_1' },
      board: 'work',
      stage: 'triage',
      fromStage: 'intake',
      toStage: 'triage',
      item: { id: item.id, title: item.title, url: null, source: 'manual', sourceKey: null, stages: ['intake'], acceptedAt: null, metadata: item.metadata, triageType: null },
    } as unknown as Readonly<FactoryStageRuleContext>)) as { prompt?: string; skillName?: string } | undefined;
    expect(triage?.prompt).toMatch(/^Prepare approval for/);
    expect(triage?.skillName).toBeUndefined();
  });

  it('drops the approval label once a person accepts the card, and matches human exactly', async () => {
    h = createHarness([
      { id: 'w-1', title: 'Pick a vendor', labels: ['human'] },
      { id: 'w-2', title: 'Shouty', labels: ['HUMAN'] },
    ]);
    const integration = h.integration();
    await sweep(integration);
    expect(card(h, 'w-2').metadata?.[CARD_LABELS_META]).not.toContain(NEEDS_APPROVAL_LABEL);
    // A person's move into Planning accepts it (Work's policy, work-transition-policy.js:40).
    h.workItems.items.find(i => i.id === card(h!, 'w-1').id)!.acceptedAt = new Date() as never;
    await sweep(integration);
    expect(card(h, 'w-1').metadata?.[CARD_LABELS_META]).toEqual(['human', 'P2', 'task']);
  });
});
