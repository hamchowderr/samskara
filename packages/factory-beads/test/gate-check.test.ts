/**
 * Timer, bead and GitHub gates checked on the host (samskara-l2t.10): each
 * sweep runs bd's own `bd gate check` when a gate may resolve, publishes what
 * it closed, and cards the step it freed in the same sweep. GitHub gates get
 * the App token as GH_TOKEN, and only the gate check does.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { BeadSnapshot, BEADS_META, checkableGates } from '../src/index';
import { createHarness, sweep, TOKEN } from './harness';
import type { FakeBead, Harness } from './harness';

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

const card = (harness: Harness, beadId: string) => harness.workItems.items.find(i => i.metadata?.[BEADS_META.id] === beadId);
const checks = (harness: Harness) => harness.state().calls.filter(c => c.argv.includes('gate') && c.argv.includes('check'));
const syncs = (harness: Harness) => harness.state().calls.filter(c => c.cwd !== harness.dir && c.argv.includes('sync')).length;

const HOUR_NS = 3_600 * 1e9;
/** A step held by one gate. */
const held = (gate: Partial<FakeBead> & { await_type: string }): FakeBead[] => [
  { id: 'w-gate', title: `Gate: ${gate.await_type}`, issue_type: 'gate', ...gate },
  { id: 'w-step', title: 'Step', blockedBy: ['w-gate'] },
];

describe('gates checked on the host (samskara-l2t.10)', () => {
  it('closes a timer gate whose time has passed, publishes it, and cards the step in the same sweep', async () => {
    h = createHarness(held({ await_type: 'timer', timeout: HOUR_NS, createdAt: '2026-01-01T00:00:00Z' }));
    const result = await sweep(h.integration());
    expect(result.repos[0]).toMatchObject({ state: 'ok', created: 1 });
    expect(h.state().beads.find(b => b.id === 'w-gate')).toMatchObject({ status: 'closed' });
    expect(checks(h)).toHaveLength(1);
    expect(checks(h)[0]!.argv).toEqual(expect.arrayContaining(['--sandbox', '--actor', 'gate', 'check', '-l', '0', '--json']));
    expect(checks(h)[0]!.argv).not.toContain('--escalate');
    expect(syncs(h)).toBe(1);
    expect(card(h, 'w-step')).toMatchObject({ stages: ['intake'] });
    // Timer gates are never carded.
    expect(card(h, 'w-gate')).toBeUndefined();
  });

  it('runs no check while a timer is still running, and none with no gate at all', async () => {
    h = createHarness([
      ...held({ await_type: 'timer', timeout: HOUR_NS, createdAt: new Date().toISOString() }),
      { id: 'w-free', title: 'Free' },
    ]);
    const integration = h.integration();
    await sweep(integration);
    await sweep(integration);
    expect(checks(h)).toHaveLength(0);
    expect(syncs(h)).toBe(0);
    expect(card(h, 'w-step')).toBeUndefined();
  });

  it('closes a bead gate once its bead closes', async () => {
    h = createHarness([{ id: 'w-target', title: 'Target' }, ...held({ await_type: 'bead', await_id: 'w-target' })]);
    const integration = h.integration();
    await sweep(integration);
    expect(checks(h)).toHaveLength(0);
    h.bd('close', 'w-target', '--reason', 'done');
    await sweep(integration);
    expect(checks(h)).toHaveLength(1);
    expect(h.state().beads.find(b => b.id === 'w-gate')).toMatchObject({ status: 'closed' });
    expect(card(h, 'w-step')).toBeDefined();
  });

  it('checks a GitHub gate every sweep with the App token as GH_TOKEN, and closes it once merged', async () => {
    h = createHarness(held({ await_type: 'gh:pr', await_id: '42' }));
    const integration = h.integration();
    await sweep(integration);
    expect(checks(h)).toHaveLength(1);
    expect(checks(h)[0]!.env).toMatchObject({ ghToken: TOKEN, token: TOKEN });
    // No other bd call gets GH_TOKEN.
    expect(h.state().calls.filter(c => c.env.ghToken !== null && !c.argv.includes('gate'))).toEqual([]);
    expect(card(h, 'w-step')).toBeUndefined();
    h.setState(s => Object.assign(s, { ghMerged: ['42'] }));
    await sweep(integration);
    expect(checks(h)).toHaveLength(2);
    expect(card(h, 'w-step')).toBeDefined();
    // Closed: no more checks.
    await sweep(integration);
    expect(checks(h)).toHaveLength(2);
  });

  it('reports a gate gh cannot read and keeps it open, still checking the rest', async () => {
    h = createHarness([
      ...held({ await_type: 'gh:run', await_id: '7' }),
      { id: 'w-timer', title: 'Gate: timer', issue_type: 'gate', await_type: 'timer', timeout: 1, createdAt: '2026-01-01T00:00:00Z' },
      { id: 'w-other', title: 'Other', blockedBy: ['w-timer'] },
    ]);
    h.setState(s => Object.assign(s, { ghErrors: ['7'] }));
    const result = await sweep(h.integration());
    expect(result.repos[0]).toMatchObject({ state: 'ok', diagnostic: expect.stringMatching(/could not evaluate 1 gate/) });
    expect(h.state().beads.find(b => b.id === 'w-gate')!.status ?? 'open').toBe('open');
    expect(card(h, 'w-other')).toBeDefined();
  });

  it('names an escalated gate in the diagnostic and leaves it open', async () => {
    h = createHarness(held({ await_type: 'gh:pr', await_id: '9' }));
    h.setState(s => Object.assign(s, { ghClosed: ['9'] }));
    const result = await sweep(h.integration());
    expect(result.repos[0]).toMatchObject({ state: 'ok', diagnostic: expect.stringMatching(/1 gate\(s\) will not resolve/) });
    expect(h.state().beads.find(b => b.id === 'w-gate')!.status ?? 'open').toBe('open');
    expect(syncs(h)).toBe(0);
  });

  it('reports a gate check that fails, and wakes a snooze in the same sweep, publishing once', async () => {
    h = createHarness([
      ...held({ await_type: 'timer', timeout: 1, createdAt: '2026-01-01T00:00:00Z' }),
      { id: 'w-snoozed', title: 'Snoozed', status: 'deferred', deferUntil: '2025-01-15T08:00:00Z' },
    ]);
    h.setState(s => Object.assign(s, { gateCheckFail: true }));
    const integration = h.integration();
    const failed = await sweep(integration);
    expect(failed.repos[0]).toMatchObject({ state: 'error', diagnostic: expect.stringMatching(/gates not checked: bd gate check exit 1/) });
    // The wake still landed and was published, and the snoozed bead is carded.
    expect(syncs(h)).toBe(1);
    expect(card(h, 'w-snoozed')).toBeDefined();
    expect(card(h, 'w-step')).toBeUndefined();
    h.setState(s => Object.assign(s, { gateCheckFail: false }));
    await sweep(integration);
    expect(card(h, 'w-step')).toBeDefined();
  });

  it('checkableGates: due timers, closed or foreign bead targets, GitHub gates with an await_id', () => {
    const now = Date.parse('2026-01-01T02:00:00Z');
    const gate = (id: string, extra: Record<string, unknown>) => ({ id, issue_type: 'gate', status: 'open', created_at: '2026-01-01T00:00:00Z', ...extra });
    const snapshot = new BeadSnapshot([
      gate('t-due', { await_type: 'timer', timeout: HOUR_NS }),
      gate('t-later', { await_type: 'timer', timeout: 3 * HOUR_NS }),
      gate('b-closed', { await_type: 'bead', await_id: 'x-done' }),
      gate('b-open', { await_type: 'bead', await_id: 'x-open' }),
      gate('b-foreign', { await_type: 'bead', await_id: 'rig:x-1' }),
      gate('pr', { await_type: 'gh:pr', await_id: '9' }),
      gate('run-none', { await_type: 'gh:run' }),
      gate('human', { await_type: 'human' }),
      { ...gate('t-closed', { await_type: 'timer', timeout: 1 }), status: 'closed' },
      { id: 'x-done', status: 'closed' },
      { id: 'x-open', status: 'open' },
    ]);
    expect(checkableGates(snapshot, now)).toEqual(['t-due', 'b-closed', 'b-foreign', 'pr']);
  });
});
