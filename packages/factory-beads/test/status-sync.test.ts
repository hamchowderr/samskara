/**
 * Two-way status sync (samskara-l2t.4): a card's move sets its bead open or
 * in_progress; a bead held in bd (blocked, deferred, pinned, hooked, custom)
 * moves its card out of a working phase to Intake once no run on it is in
 * flight, and work does not start on it until the bead is workable again.
 * The person's bd commands run through the fake bd in bd 1.3.1's shapes.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { BoardTransitionPolicyResult } from '@mastra/factory/boards';

import { requestsBoard } from '../../../src/mastra/boards/requests-board';
import { BEADS_META, heldReason, OVERVIEW_CARD_KIND } from '../src/index';
import { createHarness, sweep } from './harness';
import type { Harness } from './harness';

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

const card = (harness: Harness, beadId: string) => harness.workItems.items.find(i => i.metadata?.[BEADS_META.id] === beadId)!;
const bead = (harness: Harness, id: string) => {
  const row = harness.state().beads.find(b => b.id === id)!;
  return { ...row, status: row.status ?? 'open' };
};
/** A marker the sweep cleared or never set. */
const marker = (harness: Harness, beadId: string, key: string) => card(harness, beadId).metadata?.[key] ?? null;
const moves = (harness: Harness) =>
  harness.workItems.evaluations.map(e => [e.input.workItemId, e.input.ingress.triggerType, e.result.decisions[0]?.stage]);
/** The integration's bd writes after call `from`: `update <id> --status=<s>`, `close <id>`, `sync`. */
const writes = (harness: Harness, from: number) =>
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
      const status = c.argv.find(a => a.startsWith('--status='));
      const assignee = c.argv.find(a => a.startsWith('--assignee='));
      return [words[0], words[1], status, assignee].filter(Boolean).join(' ');
    })
    .filter(c => c.startsWith('update') || c.startsWith('close') || c === 'sync');

/** What a person's move into `toStage` gets from the Requests board policy. */
const personMove = (harness: Harness, beadId: string, toStage: string): BoardTransitionPolicyResult | undefined => {
  const item = card(harness, beadId);
  return requestsBoard.transitionPolicy?.({
    actor: { type: 'human', id: 'u1' },
    board: 'work',
    fromStage: item.stages[0]!,
    toStage,
    source: 'manual',
    initialEntry: false,
    reenter: false,
    itemRevision: item.revision,
    isHumanTransition: true,
    plansAutoApproved: false,
    planApproved: false,
    item: { id: item.id, source: 'manual', stages: item.stages, metadata: item.metadata, triageType: null },
  } as never) as BoardTransitionPolicyResult | undefined;
};

const run = (workItemId: string, status: string) => ({
  id: `decision_${workItemId}_${status}`,
  workItemId,
  status,
  decision: { type: 'invokeSkill', role: 'work' },
  createdAt: new Date(),
});

describe('two-way status sync (samskara-l2t.4)', () => {
  it("writes each card move to its bead once: a working phase sets in_progress, Intake and Canceled set open", async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    const integration = h.integration();
    await sweep(integration);
    // Carded in Intake with its bead open: nothing to write, the pair is recorded.
    expect(card(h, 'w-1').metadata).toMatchObject({ [BEADS_META.status]: 'open', [BEADS_META.statusStage]: 'intake' });

    h.workItems.move(card(h, 'w-1').id, 'triage');
    let from = h.state().calls.length;
    await sweep(integration);
    expect(writes(h, from)).toEqual(['update w-1 --status=in_progress', 'sync']);
    expect(bead(h, 'w-1')).toMatchObject({ status: 'in_progress' });
    // Plain status: never a claim, so no assignee.
    expect(bead(h, 'w-1').assignee).toBeUndefined();
    expect(card(h, 'w-1').metadata).toMatchObject({ [BEADS_META.status]: 'in_progress', [BEADS_META.statusStage]: 'triage' });

    // Between working phases the status already matches: nothing written.
    h.workItems.move(card(h, 'w-1').id, 'execute');
    from = h.state().calls.length;
    await sweep(integration);
    expect(writes(h, from)).toEqual([]);

    h.workItems.move(card(h, 'w-1').id, 'intake');
    from = h.state().calls.length;
    await sweep(integration);
    expect(writes(h, from)).toEqual(['update w-1 --status=open', 'sync']);
    expect(bead(h, 'w-1').status).toBe('open');

    h.workItems.move(card(h, 'w-1').id, 'review');
    await sweep(integration);
    h.workItems.move(card(h, 'w-1').id, 'canceled');
    from = h.state().calls.length;
    await sweep(integration);
    // A canceled card leaves its bead open (owner decision).
    expect(writes(h, from)).toEqual(['update w-1 --status=open', 'sync']);
    expect(bead(h, 'w-1').status).toBe('open');

    from = h.state().calls.length;
    await sweep(integration);
    await sweep(integration);
    expect(writes(h, from)).toEqual([]);
    expect(moves(h)).toEqual([]);
  });

  it('keeps a change made in bd: no write back and no move for open or in_progress, so the two never ping-pong', async () => {
    h = createHarness([
      { id: 'w-1', title: 'One' },
      { id: 'w-2', title: 'Two' },
    ]);
    const integration = h.integration();
    await sweep(integration);
    h.workItems.move(card(h, 'w-1').id, 'execute');
    await sweep(integration);
    expect(bead(h, 'w-1').status).toBe('in_progress');

    // A person sets the bead open in bd while its card is in Building, and
    // claims the other bead while its card rests in Intake.
    h.bd('update', 'w-1', '--status=open');
    h.bd('update', 'w-2', '--status=in_progress', '--assignee=alice');
    const from = h.state().calls.length;
    for (let i = 0; i < 3; i++) await sweep(integration);
    expect(writes(h, from)).toEqual([]);
    expect(moves(h)).toEqual([]);
    expect(card(h, 'w-1')).toMatchObject({ stages: ['execute'], metadata: { [BEADS_META.status]: 'open' } });
    expect(marker(h, 'w-1', BEADS_META.held)).toBeNull();
    expect(card(h, 'w-2')).toMatchObject({ stages: ['intake'], metadata: { [BEADS_META.status]: 'in_progress' } });
    expect(bead(h, 'w-1').status).toBe('open');
    expect(bead(h, 'w-2')).toMatchObject({ status: 'in_progress', assignee: 'alice' });

    // The card's next move is written again.
    h.workItems.move(card(h, 'w-1').id, 'review');
    const next = h.state().calls.length;
    await sweep(integration);
    expect(writes(h, next)).toEqual(['update w-1 --status=in_progress', 'sync']);
  });

  it("never sets someone else's in_progress claim back to open", async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    const integration = h.integration();
    await sweep(integration);
    h.workItems.move(card(h, 'w-1').id, 'execute');
    await sweep(integration);
    h.bd('update', 'w-1', '--assignee=alice');
    h.workItems.move(card(h, 'w-1').id, 'intake');
    const from = h.state().calls.length;
    await sweep(integration);
    expect(writes(h, from)).toEqual([]);
    expect(bead(h, 'w-1')).toMatchObject({ status: 'in_progress', assignee: 'alice' });
    expect(card(h, 'w-1').metadata).toMatchObject({ [BEADS_META.status]: 'in_progress', [BEADS_META.statusStage]: 'intake' });
  });

  it('writes nothing when the status changed after the refresh read, and tries again next sweep', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    const integration = h.integration();
    await sweep(integration);
    h.workItems.move(card(h, 'w-1').id, 'execute');
    h.setState(s => {
      s.casFail = ['w-1'];
    });
    await sweep(integration);
    expect(bead(h, 'w-1').status).toBe('open');
    // Not recorded, so the move is still unwritten.
    expect(card(h, 'w-1').metadata?.[BEADS_META.statusStage]).toBe('intake');
    h.setState(s => {
      s.casFail = [];
    });
    await sweep(integration);
    expect(bead(h, 'w-1').status).toBe('in_progress');
  });

  it('moves a card whose bead is blocked in bd to Intake only after its run finishes, and starts no work on it until the bead is workable', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    const integration = h.integration();
    await sweep(integration);
    const id = card(h, 'w-1').id;
    h.workItems.move(id, 'execute');
    await sweep(integration);
    h.workItems.deferredDecisions = [run(id, 'leased')];
    h.bd('update', 'w-1', '--status=blocked');

    // The run is in flight: the card is marked held and stays.
    await sweep(integration);
    expect(card(h, 'w-1')).toMatchObject({ stages: ['execute'], metadata: { [BEADS_META.held]: 'blocked', [BEADS_META.status]: 'blocked' } });
    expect(moves(h)).toEqual([]);
    // The run's own moves between working phases still pass.
    expect(personMove(h, 'w-1', 'review')?.type).not.toBe('reject');

    // The run settles: the next sweep moves the card to Intake.
    h.workItems.deferredDecisions = [run(id, 'succeeded')];
    await sweep(integration);
    expect(moves(h)).toEqual([[id, 'beads.held', 'intake']]);
    expect(await h.workItems.applyDecisions()).toEqual([{ workItemId: id, stage: 'intake', outcome: 'moved' }]);

    // The move is not written back: the bead stays blocked.
    const from = h.state().calls.length;
    await sweep(integration);
    expect(writes(h, from)).toEqual([]);
    expect(bead(h, 'w-1').status).toBe('blocked');
    expect(card(h, 'w-1').metadata).toMatchObject({ [BEADS_META.statusStage]: 'intake', [BEADS_META.held]: 'blocked' });
    expect(personMove(h, 'w-1', 'triage')).toEqual({ type: 'reject', code: 'forbidden', reason: heldReason('blocked') });
    expect(personMove(h, 'w-1', 'canceled')?.type).not.toBe('reject');

    // Open again in bd: the hold is lifted and the card waits in Intake for a person.
    h.bd('update', 'w-1', '--status=open');
    await sweep(integration);
    expect(card(h, 'w-1')).toMatchObject({ stages: ['intake'], metadata: { [BEADS_META.held]: null, [BEADS_META.status]: 'open' } });
    expect(personMove(h, 'w-1', 'triage')?.type).not.toBe('reject');
    expect(moves(h)).toHaveLength(1);
  });

  it('holds a card for deferred, pinned, hooked and custom statuses, and moves one with no run straight away', async () => {
    h = createHarness([
      { id: 'w-d', title: 'Deferred' },
      { id: 'w-p', title: 'Pinned' },
      { id: 'w-h', title: 'Hooked' },
      { id: 'w-c', title: 'Custom' },
    ]);
    const integration = h.integration();
    await sweep(integration);
    for (const id of ['w-d', 'w-p', 'w-h', 'w-c']) h.workItems.move(card(h, id).id, 'planning');
    await sweep(integration);
    h.bd('update', 'w-d', '--status=deferred');
    h.bd('update', 'w-p', '--status=pinned');
    h.bd('update', 'w-h', '--status=hooked');
    h.bd('update', 'w-c', '--status=waiting-on-client');
    // Another card's run does not hold these.
    h.workItems.deferredDecisions = [run('card_other', 'leased')];
    await sweep(integration);
    expect(moves(h).map(m => m[2])).toEqual(['intake', 'intake', 'intake', 'intake']);
    expect(['w-d', 'w-p', 'w-h', 'w-c'].map(id => card(h!, id).metadata?.[BEADS_META.held])).toEqual([
      'deferred',
      'pinned',
      'hooked',
      'waiting-on-client',
    ]);
  });

  it('leaves overview cards alone', async () => {
    h = createHarness([
      { id: 'w-e', title: 'Epic', issue_type: 'epic' },
      { id: 'w-e.1', title: 'One', parent: 'w-e' },
    ]);
    const integration = h.integration();
    await sweep(integration);
    expect(card(h, 'w-e').metadata?.[BEADS_META.cardKind]).toBe(OVERVIEW_CARD_KIND);
    h.bd('update', 'w-e', '--status=blocked');
    const from = h.state().calls.length;
    await sweep(integration);
    expect(writes(h, from)).toEqual([]);
    expect(card(h, 'w-e').metadata?.[BEADS_META.held]).toBeUndefined();
    expect(card(h, 'w-e').metadata?.[BEADS_META.status]).toBeUndefined();
  });

  it('does not try to close a claimed bead with an open child, so the claim is never handed over and back', async () => {
    h = createHarness([
      { id: 'w-t', title: 'Task', assignee: 'alice', status: 'in_progress' },
      { id: 'w-t.1', title: 'Subtask', parent: 'w-t' },
    ]);
    h.setState(s => {
      // Carded while open; claimed afterwards.
      s.beads[0]!.status = 'open';
    });
    const integration = h.integration();
    await sweep(integration);
    h.bd('update', 'w-t', '--status=in_progress', '--assignee=alice');
    h.workItems.move(card(h, 'w-t').id, 'done');
    const from = h.state().calls.length;
    await sweep(integration);
    expect(writes(h, from)).toEqual([]);
    expect(String(card(h, 'w-t').metadata?.[BEADS_META.diagnostic])).toContain('open child');
    expect(bead(h, 'w-t')).toMatchObject({ status: 'in_progress', assignee: 'alice' });
  });
});
