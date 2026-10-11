/**
 * Human gates as approval cards (samskara-l2t.9): an open human gate is
 * carded in Intake for a person to approve, titled after the step it holds;
 * a person's move to Done closes the gate, and the step becomes ready.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { BeadSnapshot, beadCardTitle, BEADS_META, cardChips, GATE_CARD_KIND, NEEDS_APPROVAL_LABEL } from '../src/index';
import { createHarness, sweep } from './harness';
import type { FakeBead, Harness } from './harness';

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

const card = (harness: Harness, beadId: string) => harness.workItems.items.find(i => i.metadata?.[BEADS_META.id] === beadId);
const closes = (harness: Harness) => harness.state().calls.filter(c => c.argv.includes('close')).map(c => c.argv.find(a => a.startsWith('w-')));

/** A poured molecule as bd 1.3.1 makes it: a root, a step, and a gate under the root that blocks the step. */
const molecule = (type = 'human'): FakeBead[] => [
  { id: 'w-mol', title: 'release', issue_type: 'molecule' },
  { id: 'w-gate', title: `Gate: ${type}`, issue_type: 'gate', await_type: type, parent: 'w-mol' },
  { id: 'w-ship', title: 'Ship it', issue_type: 'task', parent: 'w-mol', blockedBy: ['w-gate'] },
];

describe('human gates as approval cards (samskara-l2t.9)', () => {
  it('cards an open human gate for approval under its molecule, titled after the step it holds', async () => {
    h = createHarness(molecule());
    await sweep(h.integration());
    const gate = card(h, 'w-gate')!;
    expect(gate).toMatchObject({ title: 'w-gate: Approve: Ship it', stages: ['intake'], parentWorkItemId: card(h, 'w-mol')!.id });
    expect(gate.metadata).toMatchObject({
      [BEADS_META.cardKind]: GATE_CARD_KIND,
      [BEADS_META.type]: 'gate',
      labels: ['P2', 'gate', NEEDS_APPROVAL_LABEL],
    });
    // The step it holds is not ready, so it has no card yet.
    expect(card(h, 'w-ship')).toBeUndefined();
    // The open gate counts as an open child of the molecule.
    expect(card(h, 'w-mol')!.metadata?.[BEADS_META.openChildren]).toBe(2);
  });

  it("closes the gate when a person moves its card to Done, and the step it held is carded", async () => {
    h = createHarness(molecule());
    const integration = h.integration();
    await sweep(integration);
    h.workItems.move(card(h, 'w-gate')!.id, 'done');
    const approved = await sweep(integration);
    expect(approved.repos[0]).toMatchObject({ state: 'ok', closed: 1 });
    expect(closes(h)).toEqual(['w-gate']);
    expect(h.state().beads.find(b => b.id === 'w-gate')).toMatchObject({ status: 'closed' });
    expect(card(h, 'w-gate')!.metadata?.[BEADS_META.writeback]).toBe('synced');
    // Ready now that the gate is closed: carded on the next sweep, as any bead bd ready lists.
    await sweep(integration);
    expect(card(h, 'w-ship')).toMatchObject({ title: 'w-ship: Ship it', stages: ['intake'] });
  });

  it('moves the card to Done when the gate is resolved in bd', async () => {
    h = createHarness(molecule());
    const integration = h.integration();
    await sweep(integration);
    h.bd('close', 'w-gate', '--reason', 'approved in bd');
    await sweep(integration);
    expect(card(h, 'w-gate')!.metadata).toMatchObject({ [BEADS_META.closedOutside]: 'done' });
    expect(await h.workItems.applyDecisions()).toEqual([{ workItemId: card(h, 'w-gate')!.id, stage: 'done', outcome: 'moved' }]);
  });

  it('never cards a timer or GitHub gate, nor a closed human gate', async () => {
    h = createHarness([
      ...molecule('timer'),
      { id: 'w-pr', title: 'Gate: gh:pr', issue_type: 'gate', await_type: 'gh:pr' },
      { id: 'w-done', title: 'Gate: human', issue_type: 'gate', await_type: 'human', status: 'closed' },
    ]);
    await sweep(h.integration());
    for (const id of ['w-gate', 'w-pr', 'w-done', 'w-ship']) expect(card(h, id), id).toBeUndefined();
  });

  it('waits to card a gate while a blocker of its own is open, as bd ready waits for any bead', async () => {
    h = createHarness([
      { id: 'w-first', title: 'First' },
      { id: 'w-held', title: 'Gate: human', issue_type: 'gate', await_type: 'human', blockedBy: ['w-first'] },
    ]);
    const integration = h.integration();
    await sweep(integration);
    expect(card(h, 'w-held')).toBeUndefined();
    h.bd('close', 'w-first', '--reason', 'done');
    await sweep(integration);
    expect(card(h, 'w-held')?.metadata?.[BEADS_META.cardKind]).toBe(GATE_CARD_KIND);
  });

  it('follows the step it holds: a renamed step renames the card, and a gate titled by hand keeps its title', async () => {
    h = createHarness([...molecule(), { id: 'w-own', title: 'Owner signs off', issue_type: 'gate', await_type: 'human' }]);
    const integration = h.integration();
    await sweep(integration);
    expect(card(h, 'w-own')!.title).toBe('w-own: Owner signs off');
    h.bd('update', 'w-ship', '--title=Ship v2');
    await sweep(integration);
    expect(card(h, 'w-gate')!.title).toBe('w-gate: Approve: Ship v2');
  });
});

describe('beadCardTitle and the gate chip (samskara-l2t.9)', () => {
  const rows = [
    { id: 'g', title: 'Gate: human', issue_type: 'gate', await_type: 'human' },
    { id: 'a', title: 'Build', dependencies: [{ issue_id: 'a', depends_on_id: 'g', type: 'blocks' }] },
    { id: 'b', title: 'Ship', dependencies: [{ issue_id: 'b', depends_on_id: 'g', type: 'blocks' }] },
    { id: 'c', title: 'Child', dependencies: [{ issue_id: 'c', depends_on_id: 'g', type: 'parent-child' }] },
  ];
  it('names a default-titled human gate after every step it blocks, and nothing else', () => {
    const snapshot = new BeadSnapshot(rows);
    expect(beadCardTitle(rows[0]!, snapshot)).toBe('Approve: Build, Ship');
    expect(beadCardTitle(rows[0]!, undefined)).toBe('Gate: human');
    expect(beadCardTitle({ ...rows[0]!, await_type: 'timer' }, snapshot)).toBe('Gate: human');
    expect(beadCardTitle(rows[1]!, snapshot)).toBe('Build');
    expect(beadCardTitle({ id: 'lone', title: 'Gate: human', issue_type: 'gate', await_type: 'human' }, snapshot)).toBe('Gate: human');
  });

  it('labels only a human gate for approval, until accepted', () => {
    expect(cardChips({ issue_type: 'gate', await_type: 'human' }).labels).toContain(NEEDS_APPROVAL_LABEL);
    expect(cardChips({ issue_type: 'gate', await_type: 'human' }, true).labels).not.toContain(NEEDS_APPROVAL_LABEL);
    expect(cardChips({ issue_type: 'gate', await_type: 'timer' }).labels).not.toContain(NEEDS_APPROVAL_LABEL);
  });
});
