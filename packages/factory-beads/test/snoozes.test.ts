/**
 * Dated snoozes (samskara-l2t.14): a bead deferred until a date that has
 * passed is woken with bd's own wake (a writable bd ready) on the host copy,
 * published, and carded in the same sweep. A future snooze and the icebox (a
 * defer with no date) stay deferred.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { BeadSnapshot, BEADS_META, expiredSnoozes } from '../src/index';
import { createHarness, sweep } from './harness';
import type { Harness } from './harness';

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

const card = (harness: Harness, beadId: string) => harness.workItems.items.find(i => i.metadata?.[BEADS_META.id] === beadId);
/** The integration's writable ready reads (its wakes) and syncs, from its own copy. */
const wakes = (harness: Harness) =>
  harness.state().calls.filter(c => c.cwd !== harness.dir && c.argv.includes('ready') && !c.argv.includes('--readonly'));
const syncs = (harness: Harness) => harness.state().calls.filter(c => c.cwd !== harness.dir && c.argv.includes('sync')).length;

const PAST = '2025-01-15T08:00:00Z';
const FUTURE = new Date(Date.now() + 24 * 60 * 60_000).toISOString();

describe('dated snoozes (samskara-l2t.14)', () => {
  it('wakes a bead snoozed until a past date, publishes it, and cards it in the same sweep, not held', async () => {
    h = createHarness([{ id: 'w-1', title: 'Snoozed', status: 'deferred', deferUntil: PAST }]);
    const result = await sweep(h.integration());
    expect(result.repos[0]).toMatchObject({ state: 'ok', created: 1 });
    expect(h.state().beads[0]).toMatchObject({ status: 'open' });
    expect(wakes(h)).toHaveLength(1);
    expect(wakes(h)[0]!.argv.slice(0, 3)).toEqual(['--sandbox', '--actor', wakes(h)[0]!.argv[2]]);
    expect(syncs(h)).toBe(1);
    expect(card(h, 'w-1')).toMatchObject({ stages: ['intake'] });
    expect(card(h, 'w-1')!.metadata?.[BEADS_META.held]).toBeUndefined();
  });

  it('leaves a future snooze and the icebox deferred, with no wake and no sync', async () => {
    h = createHarness([
      { id: 'w-later', title: 'Later', status: 'deferred', deferUntil: FUTURE },
      { id: 'w-ice', title: 'Iced', status: 'deferred' },
    ]);
    const integration = h.integration();
    await sweep(integration);
    await sweep(integration);
    expect(card(h, 'w-later')).toBeUndefined();
    expect(card(h, 'w-ice')).toBeUndefined();
    expect(wakes(h)).toHaveLength(0);
    expect(syncs(h)).toBe(0);
    expect(h.state().beads.map(b => b.status)).toEqual(['deferred', 'deferred']);
  });

  it("releases a held card when its bead's snooze runs out", async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    const integration = h.integration();
    await sweep(integration);
    // Snoozed in bd after it was carded: the card is held while the date is ahead.
    h.setState(s => Object.assign(s.beads[0]!, { status: 'deferred', deferUntil: FUTURE }));
    await sweep(integration);
    expect(card(h, 'w-1')!.metadata?.[BEADS_META.held]).toBe('deferred');
    h.setState(s => Object.assign(s.beads[0]!, { deferUntil: PAST }));
    await sweep(integration);
    expect(h.state().beads[0]).toMatchObject({ status: 'open' });
    expect(card(h, 'w-1')!.metadata?.[BEADS_META.held] ?? null).toBeNull();
  });

  it('expiredSnoozes: only deferred beads whose date is at or before now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const snapshot = new BeadSnapshot([
      { id: 'past', status: 'deferred', defer_until: '2025-12-31T23:59:59Z' },
      { id: 'now', status: 'deferred', defer_until: '2026-01-01T00:00:00Z' },
      { id: 'later', status: 'deferred', defer_until: '2026-01-01T00:00:01Z' },
      { id: 'ice', status: 'deferred' },
      { id: 'open', status: 'open', defer_until: '2025-01-01T00:00:00Z' },
      { id: 'junk', status: 'deferred', defer_until: 'soon' },
    ]);
    expect(expiredSnoozes(snapshot, now)).toEqual(['past', 'now']);
  });
});
