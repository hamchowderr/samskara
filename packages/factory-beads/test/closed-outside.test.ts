/**
 * Beads closed or reopened outside the Factory (samskara-l2t.3): a card
 * whose bead was closed in bd moves to Done, or to Canceled when the bead
 * was superseded, marked a duplicate or dismissed; a card in Done whose bead
 * was reopened moves back to Intake. The person's bd commands run through the
 * fake bd in the shapes bd 1.3.1 gives them (test/fixtures/fake-bd.mjs).
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  BEADS_META,
  beadsClaimKey,
  closedOutsideOutcome,
  createBeadsTransitionPolicy,
  isClosedOutsideMove,
  PLAN_CARD_KIND,
  RESEARCH_CARD_KIND,
} from '../src/index';
import { createHarness, ORG, PROJECT, SLUG, sweep } from './harness';
import type { Harness } from './harness';

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

const card = (harness: Harness, beadId: string) => harness.workItems.items.find(i => i.metadata?.[BEADS_META.id] === beadId)!;
const moves = (harness: Harness) =>
  harness.workItems.evaluations.map(e => [e.input.workItemId, e.input.ingress.triggerType, e.result.decisions[0]?.stage]);
/**
 * Each bd call the integration made after call `from`, as "<command> <first
 * operand>". The person's own commands (run from the harness directory, not
 * from a copy) are left out.
 */
const integrationCalls = (harness: Harness, from: number) =>
  harness
    .state()
    .calls.slice(from)
    .filter(c => c.cwd !== harness.dir)
    .map(c => {
      const words: string[] = [];
      for (let i = 0; i < c.argv.length; i++) {
        const arg = c.argv[i]!;
        if (arg === '--actor' || arg === '--reason' || arg === '-n') i++;
        else if (!arg.startsWith('-')) words.push(arg);
      }
      return words.slice(0, 2).join(' ');
    });
const writes = (calls: string[]) => calls.filter(c => c.startsWith('close') || c === 'sync');
const binding = (workItemId: string, role: string) => ({
  id: `binding_${workItemId}_${role}`,
  orgId: ORG,
  factoryProjectId: PROJECT,
  workItemId,
  role,
  threadId: 't',
  resourceId: 'r',
  sessionId: 's',
  branch: 'b',
  status: 'active' as const,
  createdAt: new Date(),
  revokedAt: null,
});

describe('beads closed outside the Factory (samskara-l2t.3)', () => {
  it('reads the outcome from what bd 1.3.1 leaves on the row: edges for supersede and duplicate, the reason for dismiss', () => {
    const edge = (type: string, issue_id = 'x-1') => ({ dependencies: [{ issue_id, depends_on_id: 'x-2', type }] });
    expect(closedOutsideOutcome({ id: 'x-1', ...edge('supersedes') })).toBe('canceled');
    expect(closedOutsideOutcome({ id: 'x-1', ...edge('duplicates') })).toBe('canceled');
    // Another bead's edge pointing here sits on that bead's row, not this one.
    expect(closedOutsideOutcome({ id: 'x-1', ...edge('supersedes', 'x-9') })).toBe('completed');
    expect(closedOutsideOutcome({ id: 'x-1', ...edge('blocks') })).toBe('completed');
    expect(closedOutsideOutcome({ id: 'x-1', close_reason: 'Dismissed' })).toBe('canceled');
    expect(closedOutsideOutcome({ id: 'x-1', close_reason: 'Dismissed: no longer applicable' })).toBe('canceled');
    expect(closedOutsideOutcome({ id: 'x-1', close_reason: 'Responded' })).toBe('completed');
    expect(closedOutsideOutcome({ id: 'x-1', close_reason: 'Dismissedly done' })).toBe('completed');
    expect(closedOutsideOutcome({ id: 'x-1' })).toBe('completed');
  });

  it('moves the card of a bead closed in bd to Done, once, and write-back only marks it synced', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    const integration = h.integration();
    let kicks = 0;
    const kick = integration.kick.bind(integration);
    integration.kick = () => {
      kicks++;
      kick();
    };
    await sweep(integration);
    h.bd('close', 'w-1', '--reason', 'fixed on a laptop');

    await sweep(integration);
    const committed = card(h, 'w-1');
    expect(committed.metadata).toMatchObject({ [BEADS_META.closedOutside]: 'done' });
    expect(moves(h)).toEqual([[committed.id, 'beads.closed-outside', 'done']]);
    expect(h.workItems.evaluations[0]!.input).toMatchObject({
      ingress: { identity: `beads:closed-outside:${committed.id}@${committed.revision}` },
      actor: { type: 'system', id: 'integration:beads' },
    });
    // A repeat before the dispatcher runs writes nothing and replays the same evaluation.
    await sweep(integration);
    expect(card(h, 'w-1').revision).toBe(committed.revision);
    expect(h.workItems.evaluations).toHaveLength(1);

    expect(await h.workItems.applyDecisions()).toEqual([{ workItemId: committed.id, stage: 'done', outcome: 'moved' }]);
    expect(kicks).toBe(1);
    const from = h.state().calls.length;
    const synced = await sweep(integration);
    // Nothing to close and nothing to publish: no close, no sync; the copy is pulled as usual.
    expect(synced.repos[0]).toMatchObject({ state: 'ok', closed: 0 });
    expect(writes(integrationCalls(h, from))).toEqual([]);
    expect(integrationCalls(h, from)).toContain('dolt pull');
    expect(card(h, 'w-1').metadata).toMatchObject({ [BEADS_META.writeback]: 'synced', [BEADS_META.syncedAt]: expect.any(String) });
    expect(h.state().beads[0]).toMatchObject({ status: 'closed', closeReason: 'fixed on a laptop' });

    await sweep(integration);
    expect(h.workItems.evaluations).toHaveLength(1);
    expect(await h.workItems.applyDecisions()).toEqual([]);
  });

  it('moves the card of a superseded, duplicate or dismissed bead to Canceled, and of a responded one to Done', async () => {
    h = createHarness([
      { id: 'w-old', title: 'Old' },
      { id: 'w-new', title: 'New' },
      { id: 'w-dup', title: 'Dup' },
      { id: 'w-dis', title: 'Dismissed', labels: ['human'] },
      { id: 'w-res', title: 'Responded', labels: ['human'] },
    ]);
    const integration = h.integration();
    await sweep(integration);
    h.bd('supersede', 'w-old', '--with', 'w-new');
    h.bd('duplicate', 'w-dup', '--of=w-new');
    // As bd human dismiss and respond close (bd v1.3.1 cmd/bd/human.go:315,366-368).
    h.bd('close', 'w-dis', '--reason', 'Dismissed: not needed');
    h.bd('close', 'w-res', '--reason', 'Responded');
    // Like bd 1.3.1: no close reason, the edge on the closed bead.
    expect(h.state().beads.find(b => b.id === 'w-old')).toMatchObject({ status: 'closed', closeReason: null, supersededBy: 'w-new' });

    await sweep(integration);
    expect(moves(h)).toEqual([
      [card(h, 'w-old').id, 'beads.closed-outside', 'canceled'],
      [card(h, 'w-dup').id, 'beads.closed-outside', 'canceled'],
      [card(h, 'w-dis').id, 'beads.closed-outside', 'canceled'],
      [card(h, 'w-res').id, 'beads.closed-outside', 'done'],
    ]);
    expect((await h.workItems.applyDecisions()).map(r => r.outcome)).toEqual(['moved', 'moved', 'moved', 'moved']);
    const from = h.state().calls.length;
    await sweep(integration);
    expect(card(h, 'w-old').stages).toEqual(['canceled']);
    // A canceled card is never written back.
    expect(writes(integrationCalls(h, from))).toEqual([]);
    expect(card(h, 'w-old').metadata?.[BEADS_META.syncedAt]).toBeUndefined();
    expect(card(h, 'w-res').metadata).toMatchObject({ [BEADS_META.writeback]: 'synced' });
    expect(h.workItems.evaluations).toHaveLength(4);
  });

  it('falls back to Done when the board has no canceled phase', async () => {
    h = createHarness([
      { id: 'w-old', title: 'Old' },
      { id: 'w-new', title: 'New' },
    ]);
    const integration = h.integration({ canceledPhase: 'archived' });
    await sweep(integration);
    h.bd('supersede', 'w-old', '--with=w-new');
    await sweep(integration);
    expect(moves(h)).toEqual([[card(h, 'w-old').id, 'beads.closed-outside', 'done']]);
  });

  it('moves a card with a live run: the run ends with the move', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    const integration = h.integration();
    await sweep(integration);
    h.workItems.move(card(h, 'w-1').id, 'execute');
    h.workItems.runBindings = [binding(card(h, 'w-1').id, 'work')];
    h.bd('close', 'w-1');
    await sweep(integration);
    expect(await h.workItems.applyDecisions()).toEqual([{ workItemId: card(h, 'w-1').id, stage: 'done', outcome: 'moved' }]);
  });

  it('lets the system move a research or plan card whose bead was closed in bd, which the policy otherwise refuses', async () => {
    h = createHarness([
      { id: 'w-d', title: 'Pick a queue', issue_type: 'decision' },
      { id: 'w-p', title: 'Plan me', issue_type: 'epic' },
    ]);
    const integration = h.integration();
    await sweep(integration);
    expect(card(h, 'w-d').metadata?.[BEADS_META.cardKind]).toBe(RESEARCH_CARD_KIND);
    expect(card(h, 'w-p').metadata?.[BEADS_META.cardKind]).toBe(PLAN_CARD_KIND);
    h.workItems.move(card(h, 'w-d').id, 'planning');
    h.bd('close', 'w-d', '--reason', 'Decided in the design review');
    h.bd('close', 'w-p');
    await sweep(integration);
    expect(await h.workItems.applyDecisions()).toEqual([
      { workItemId: card(h, 'w-d').id, stage: 'done', outcome: 'moved' },
      { workItemId: card(h, 'w-p').id, stage: 'done', outcome: 'moved' },
    ]);
    // Write-back closes neither again.
    const from = h.state().calls.length;
    await sweep(integration);
    expect(writes(integrationCalls(h, from))).toEqual([]);
    expect(card(h, 'w-d').metadata).toMatchObject({ [BEADS_META.writeback]: 'synced' });
    expect(card(h, 'w-p').metadata).toMatchObject({ [BEADS_META.writeback]: 'synced' });
  });

  it('allows the closed-outside move only for the system and only to the marked phase', () => {
    const policy = createBeadsTransitionPolicy(undefined);
    const context = (actor: string, toStage: string, metadata: Record<string, unknown>) =>
      ({ actor: { type: actor }, toStage, fromStage: 'planning', item: { metadata } }) as never;
    for (const kind of [RESEARCH_CARD_KIND, PLAN_CARD_KIND]) {
      const marked = { [BEADS_META.cardKind]: kind, [BEADS_META.closedOutside]: 'done' };
      expect(policy(context('system', 'done', marked))).toBeUndefined();
      expect(policy(context('agent', 'done', marked))).toMatchObject({ type: 'reject', code: 'approval_required' });
      expect(policy(context('system', 'done', { ...marked, [BEADS_META.closedOutside]: 'canceled' }))).toMatchObject({ type: 'reject' });
      expect(policy(context('system', 'done', { [BEADS_META.cardKind]: kind }))).toMatchObject({ type: 'reject', code: 'approval_required' });
    }
    expect(isClosedOutsideMove(context('system', 'canceled', { [BEADS_META.closedOutside]: 'canceled' }))).toBe(true);
    expect(isClosedOutsideMove(context('human', 'done', { [BEADS_META.closedOutside]: 'done' }))).toBe(false);
  });

  it('leaves an overview card, a terminal card, and a card a person moved out of Done after write-back', async () => {
    h = createHarness([
      { id: 'w-e', title: 'Epic', issue_type: 'epic' },
      { id: 'w-e.1', title: 'Child', parent: 'w-e' },
      { id: 'w-1', title: 'One' },
      { id: 'w-2', title: 'Two' },
    ]);
    const integration = h.integration();
    await sweep(integration);
    // Done through the Factory: write-back closes and syncs it; then a person moves the card back out.
    h.workItems.move(card(h, 'w-1').id, 'done');
    await sweep(integration);
    expect(card(h, 'w-1').metadata).toMatchObject({ [BEADS_META.writeback]: 'synced' });
    h.workItems.move(card(h, 'w-1').id, 'review');
    // Canceled by a person (the bead stays open by owner decision), then closed in bd.
    h.workItems.move(card(h, 'w-2').id, 'canceled');
    h.bd('close', 'w-2');
    // The container is closed while its child is open: its card stays (samskara-l2t.2.2).
    h.bd('close', 'w-e', '--force');
    await sweep(integration);
    await sweep(integration);
    expect(h.state().beads.find(b => b.id === 'w-e')!.status).toBe('closed');
    expect(h.workItems.evaluations).toHaveLength(0);
    expect(card(h, 'w-1').stages).toEqual(['review']);
    expect(card(h, 'w-2').stages).toEqual(['canceled']);
  });

  it('moves nothing while the refresh read fails', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    const integration = h.integration();
    await sweep(integration);
    h.bd('close', 'w-1');
    h.setState(s => (s.listFail = true));
    await sweep(integration);
    expect(h.workItems.evaluations).toHaveLength(0);
    h.setState(s => (s.listFail = false));
    await sweep(integration);
    expect(h.workItems.evaluations).toHaveLength(1);
  });
});

describe('beads reopened outside the Factory (samskara-l2t.3)', () => {
  it('moves the same card Done -> Intake, takes its claim back, and closes the bead again on the next Done', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    const integration = h.integration();
    await sweep(integration);
    const id = card(h, 'w-1').id;
    h.workItems.move(id, 'done');
    await sweep(integration);
    expect(h.state().beads[0]!.status).toBe('closed');
    // Factory drops the org-wide claim on a terminal phase (work-items/base.js:911-920).
    expect(card(h, 'w-1').claimKey).toBeNull();

    h.bd('reopen', 'w-1');
    await sweep(integration);
    const reopened = card(h, 'w-1');
    expect(moves(h)).toEqual([[id, 'beads.reopened', 'intake']]);
    expect(h.workItems.evaluations[0]!.input.ingress.identity).toBe(`beads:reopened:${id}@${reopened.revision}`);
    // Not closed again while it waits for the dispatcher, and a repeat is a replay.
    await sweep(integration);
    expect(h.state().beads[0]!.status).toBe('open');
    expect(h.workItems.evaluations).toHaveLength(1);
    expect(await h.workItems.applyDecisions()).toEqual([{ workItemId: id, stage: 'intake', outcome: 'moved' }]);

    await sweep(integration);
    // The same card, its markers cleared, its claim back; no new card.
    expect(h.workItems.beadCards()).toHaveLength(1);
    expect(card(h, 'w-1').metadata?.[BEADS_META.syncedAt]).toBeNull();
    expect(card(h, 'w-1').metadata?.[BEADS_META.writeback]).toBeNull();
    expect(card(h, 'w-1').claimKey).toBe(beadsClaimKey(SLUG, 'w-1'));
    const quiet = card(h, 'w-1').revision;
    await sweep(integration);
    expect(card(h, 'w-1').revision).toBe(quiet);
    expect(h.workItems.evaluations).toHaveLength(1);

    h.workItems.move(id, 'done');
    const again = await sweep(integration);
    expect(again.repos[0]).toMatchObject({ state: 'ok', closed: 1 });
    expect(h.state().beads[0]!.status).toBe('closed');
  });

  it('moves a card closed outside back to Intake when its bead reopens, before or after write-back marked it synced', async () => {
    h = createHarness([
      { id: 'w-1', title: 'One' },
      { id: 'w-2', title: 'Two' },
    ]);
    const integration = h.integration();
    await sweep(integration);
    h.bd('close', 'w-1');
    h.bd('close', 'w-2');
    await sweep(integration);
    await h.workItems.applyDecisions();
    // w-1 reopens before write-back has seen its card in Done: it is not closed again.
    h.bd('reopen', 'w-1');
    await sweep(integration);
    expect(h.state().beads.find(b => b.id === 'w-1')!.status).toBe('open');
    expect(card(h, 'w-1').metadata?.[BEADS_META.syncedAt]).toBeUndefined();
    expect(card(h, 'w-2').metadata).toMatchObject({ [BEADS_META.writeback]: 'synced' });
    // w-2 reopens after.
    h.bd('reopen', 'w-2');
    await sweep(integration);
    expect(moves(h).filter(m => m[1] === 'beads.reopened')).toEqual([
      [card(h, 'w-1').id, 'beads.reopened', 'intake'],
      [card(h, 'w-2').id, 'beads.reopened', 'intake'],
    ]);
    await h.workItems.applyDecisions();
    await sweep(integration);
    for (const bead of ['w-1', 'w-2']) {
      expect(card(h, bead).stages).toEqual(['intake']);
      expect(card(h, bead).metadata?.[BEADS_META.closedOutside]).toBeNull();
    }
    expect(h.state().beads.every(b => b.status === 'open')).toBe(true);
  });

  it('never moves a canceled card back when its bead reopens', async () => {
    h = createHarness([
      { id: 'w-old', title: 'Old' },
      { id: 'w-new', title: 'New' },
    ]);
    const integration = h.integration();
    await sweep(integration);
    h.bd('supersede', 'w-old', '--with', 'w-new');
    await sweep(integration);
    await h.workItems.applyDecisions();
    expect(card(h, 'w-old').stages).toEqual(['canceled']);
    h.bd('reopen', 'w-old');
    await sweep(integration);
    await sweep(integration);
    expect(h.workItems.evaluations).toHaveLength(1);
    expect(card(h, 'w-old').stages).toEqual(['canceled']);
  });
});
