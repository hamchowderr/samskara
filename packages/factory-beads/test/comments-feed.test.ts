/**
 * bd comments on the card feed (samskara-l2t.6): each comment on a carded
 * bead is posted to its card's feed once, backdated to its bd timestamp and
 * keyed by its bd comment id, and bd is read only when the bead's
 * comment_count changes.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { BEADS_COMMENT_SOURCE, BEADS_INTEGRATION_ID, BEADS_META, fitFeedComment } from '../src/index';
import { createHarness, sweep } from './harness';
import type { Harness } from './harness';

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

const card = (harness: Harness, beadId: string) => harness.workItems.items.find(i => i.metadata?.[BEADS_META.id] === beadId)!;
const commentReads = (harness: Harness) => harness.state().calls.filter(c => c.argv.includes('comments')).length;

describe('bd comments on the card feed (samskara-l2t.6)', () => {
  it('posts each bd comment once, as its bd author and at its bd time', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    h.bd('comments', 'add', 'w-1', 'First **finding**', '--actor=alice');
    const integration = h.integration();
    await sweep(integration);
    const item = card(h, 'w-1');
    const [first] = h.feed.on(item.id);
    expect(h.feed.on(item.id)).toHaveLength(1);
    expect(first).toMatchObject({
      body: 'First **finding**',
      author: { kind: 'user', id: 'beads:alice', displayName: 'alice', external: { platform: 'beads', userId: 'alice' } },
      externalSource: { integrationId: BEADS_INTEGRATION_ID, type: BEADS_COMMENT_SOURCE },
      occurredAt: new Date('2026-01-02T00:00:00Z'),
    });
    const revision = item.revision;

    // Unchanged count: bd is not read again and nothing is posted.
    const reads = commentReads(h);
    await sweep(integration);
    expect(commentReads(h)).toBe(reads);
    expect(h.feed.on(item.id)).toHaveLength(1);

    // A new comment: only it is added, and the card's revision never moves.
    h.bd('comments', 'add', 'w-1', 'Second', '--actor=bob');
    await sweep(integration);
    expect(h.feed.on(item.id).map(c => c.body)).toEqual(['First **finding**', 'Second']);
    expect(card(h, 'w-1').revision).toBe(revision);
  });

  it('does not post a comment twice after a restart', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    h.bd('comments', 'add', 'w-1', 'Hello', '--actor=alice');
    await sweep(h.integration());
    const fresh = h.integration();
    await sweep(fresh);
    expect(h.feed.on(card(h, 'w-1').id)).toHaveLength(1);
  });

  it('follows comments on a card whose bead is in progress or closed', async () => {
    h = createHarness([
      { id: 'w-1', title: 'One' },
      { id: 'w-2', title: 'Two' },
    ]);
    const integration = h.integration();
    await sweep(integration);
    h.bd('update', 'w-1', '--status=in_progress');
    h.bd('close', 'w-2', '--reason=done');
    h.bd('comments', 'add', 'w-1', 'Working on it');
    h.bd('comments', 'add', 'w-2', 'Shipped in #12');
    await sweep(integration);
    expect(h.feed.on(card(h, 'w-1').id).map(c => c.body)).toEqual(['Working on it']);
    expect(h.feed.on(card(h, 'w-2').id).map(c => c.body)).toEqual(['Shipped in #12']);
  });

  it('retries on the next sweep when a post fails, and leaves the card otherwise updated', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    const integration = h.integration();
    await sweep(integration);
    h.bd('comments', 'add', 'w-1', 'Late');
    h.bd('update', 'w-1', '--title=Renamed');
    const id = card(h, 'w-1').id;
    // The feed refuses the post once (a work item it cannot find, say).
    const create = h.feed.createComment.bind(h.feed);
    let refusals = 1;
    h.feed.createComment = async input => (refusals-- > 0 ? { status: 'work_item_not_found' as const } : create(input));
    await sweep(integration);
    expect(h.feed.on(id)).toHaveLength(0);
    expect(card(h, 'w-1').title).toBe('w-1: Renamed');
    await sweep(integration);
    expect(h.feed.on(id).map(c => c.body)).toEqual(['Late']);
  });

  it('cuts a comment longer than the feed takes, and skips an empty one', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    h.bd('comments', 'add', 'w-1', 'x'.repeat(20_000));
    h.bd('comments', 'add', 'w-1', '   ');
    await sweep(h.integration());
    const [only, ...rest] = h.feed.on(card(h, 'w-1').id);
    expect(rest).toHaveLength(0);
    expect(only!.body.length).toBeLessThanOrEqual(16_000);
    expect(only!.body).toMatch(/the full comment is in bd\)$/);
  });
});

describe('fitFeedComment (samskara-l2t.6)', () => {
  it('never splits a surrogate pair at the cut', () => {
    const body = 'a'.repeat(16_000 - 42 - 1) + '😀'.repeat(10);
    const cut = fitFeedComment(body);
    expect(cut.length).toBeLessThanOrEqual(16_000);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(fitFeedComment('short')).toBe('short');
  });
});
