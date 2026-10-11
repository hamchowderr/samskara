/**
 * Label chips (samskara-l2t.5): a card carries its bead's bd labels, its
 * priority as P0-P4 and its type in Factory's own `labels` metadata, which the
 * board draws as chips; a bead labelled `human` also carries Factory's
 * approval label, so Triage prepares an approval instead of investigating.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { FactoryStageRuleContext } from '@mastra/factory/rules/types';

import { requestsBoard } from '../../../src/mastra/boards/requests-board';
import { BeadSnapshot, BEADS_META, CARD_LABEL_COLORS_META, CARD_LABELS_META, cardChips, dependencyChips, NEEDS_APPROVAL_LABEL } from '../src/index';
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

describe('dependency chips (samskara-l2t.11)', () => {
  it('shows each open blocker as an amber chip, and drops it once the blocker closes', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }, { id: 'w-2', title: 'Two' }, { id: 'w-3', title: 'Three', status: 'closed' }]);
    const integration = h.integration();
    await sweep(integration);
    // Blocked in bd after it was carded: the card stays, and shows why it is stuck.
    h.setState(s => Object.assign(s.beads[0]!, { blockedBy: ['w-2', 'w-3'] }));
    await sweep(integration);
    expect(card(h, 'w-1').metadata?.[CARD_LABELS_META]).toEqual(['P2', 'task', 'blocked by w-2']);
    expect(card(h, 'w-1').metadata?.[CARD_LABEL_COLORS_META]).toEqual({ 'blocked by w-2': '#d97706' });
    h.bd('close', 'w-2', '--reason', 'done');
    await sweep(integration);
    expect(card(h, 'w-1').metadata?.[CARD_LABELS_META]).toEqual(['P2', 'task']);
  });

  it('shows a related bead on both cards, though bd stores the link on one side', async () => {
    h = createHarness([{ id: 'w-1', title: 'One', related: ['w-2'] }, { id: 'w-2', title: 'Two' }]);
    await sweep(h.integration());
    expect(card(h, 'w-1').metadata?.[CARD_LABELS_META]).toEqual(['P2', 'task', 'related w-2']);
    expect(card(h, 'w-1').metadata?.[CARD_LABEL_COLORS_META]).toEqual({ 'related w-2': '#64748b' });
    expect(card(h, 'w-2').metadata?.[CARD_LABELS_META]).toEqual(['P2', 'task', 'related w-1']);
  });

  it('dependencyChips: open blockers, then related beads from either side; closed, self and duplicates left out', () => {
    const snapshot = new BeadSnapshot([
      {
        id: 'a',
        dependencies: [
          { issue_id: 'a', depends_on_id: 'b', type: 'blocks' },
          { issue_id: 'a', depends_on_id: 'b', type: 'blocks' },
          { issue_id: 'a', depends_on_id: 'done', type: 'blocks' },
          { issue_id: 'a', depends_on_id: 'external:other:x', type: 'blocks' },
          { issue_id: 'a', depends_on_id: 'p', type: 'parent-child' },
          { issue_id: 'a', depends_on_id: 'c', type: 'relates-to' },
        ],
      },
      { id: 'b', status: 'open' },
      { id: 'c', status: 'open' },
      { id: 'd', status: 'open', dependencies: [{ issue_id: 'd', depends_on_id: 'a', type: 'related' }] },
      { id: 'old', status: 'closed', dependencies: [{ issue_id: 'old', depends_on_id: 'a', type: 'related' }] },
      { id: 'done', status: 'closed' },
      { id: 'p', status: 'open' },
    ]);
    expect(dependencyChips(snapshot.get('a')!, snapshot)).toEqual(['blocked by b', 'blocked by external:other:x', 'related c', 'related d']);
    // bd lists it as ready: an external reference it could not resolve is not a blocker.
    expect(dependencyChips(snapshot.get('a')!, snapshot, true)).toEqual(['blocked by b', 'related c', 'related d']);
    expect(dependencyChips(snapshot.get('a')!, undefined)).toEqual([]);
    // conditional-blocks blocks while its bead is open; waits-for while its bead has an open child; sorted.
    const waits = new BeadSnapshot([
      {
        id: 'x',
        dependencies: [
          { issue_id: 'x', depends_on_id: 'z-cond', type: 'conditional-blocks' },
          { issue_id: 'x', depends_on_id: 'parent-busy', type: 'waits-for' },
          { issue_id: 'x', depends_on_id: 'parent-idle', type: 'waits-for' },
        ],
      },
      { id: 'z-cond', status: 'open' },
      { id: 'parent-busy', status: 'open' },
      { id: 'parent-idle', status: 'open' },
      { id: 'kid', status: 'open', dependencies: [{ issue_id: 'kid', depends_on_id: 'parent-busy', type: 'parent-child' }] },
      { id: 'kid2', status: 'closed', dependencies: [{ issue_id: 'kid2', depends_on_id: 'parent-idle', type: 'parent-child' }] },
    ]);
    expect(dependencyChips(waits.get('x')!, waits)).toEqual(['blocked by parent-busy', 'blocked by z-cond']);
    // Without an id (a caller that passes none), cardChips adds none.
    expect(cardChips({ priority: 2, issue_type: 'task' }, false, snapshot).labels).toEqual(['P2', 'task']);
  });
});
