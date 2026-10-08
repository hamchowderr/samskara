/**
 * samskara-iz6.8: on by default, startup preconditions that idle the
 * integration with one log line, and the per-repository states shown by
 * GET /web/beads/status.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BdRunner, BEADS_META, beadsSetting, beadsStartupLine, cacheDirFor } from '../src/index';
import type { BeadsIntegration } from '../src/index';
import { createHarness, PROJECT, SLUG, sweep, TOKEN } from './harness';
import type { Harness } from './harness';

let h: Harness | undefined;
afterEach(() => {
  vi.useRealTimers();
  h?.cleanup();
  h = undefined;
});

/** A logger that records every line by level. */
function recorder() {
  const lines = { info: [] as string[], warn: [] as string[], error: [] as string[] };
  const logger = {
    info: (...args: unknown[]) => void lines.info.push(args.join(' ')),
    warn: (...args: unknown[]) => void lines.warn.push(args.join(' ')),
    error: (...args: unknown[]) => void lines.error.push(args.join(' ')),
  };
  return { lines, logger };
}

/** bd subcommands run, ignoring the startup `--version` probe. */
const bdCommands = (harness: Harness) =>
  harness
    .state()
    .calls.map(c => c.argv.filter(a => !a.startsWith('-')).find(a => a !== 'factory-beads') ?? c.argv.join(' '))
    .filter(c => c !== '--version');

const MIN = 60_000;

describe('on/off switch', () => {
  it('is on by default', () => {
    expect(beadsSetting(undefined)).toEqual({ enabled: true, explicit: false });
    expect(beadsSetting('')).toEqual({ enabled: true, explicit: false });
    expect(beadsSetting('  ')).toEqual({ enabled: true, explicit: false });
  });

  it.each(['0', 'false', 'off', 'OFF', ' False ', 'no'])('BEADS_INTEGRATION=%j turns it off', raw => {
    expect(beadsSetting(raw)).toEqual({ enabled: false, explicit: true });
  });

  it.each(['1', 'true', 'on'])('BEADS_INTEGRATION=%j leaves it on', raw => {
    expect(beadsSetting(raw)).toEqual({ enabled: true, explicit: true });
  });

  it('says how to turn it off in one startup line', () => {
    expect(beadsStartupLine(beadsSetting(undefined), true)).toBe('[beads] on by default; set BEADS_INTEGRATION=0 to turn it off.');
    expect(beadsStartupLine(beadsSetting('0'), true)).toBe('[beads] off (BEADS_INTEGRATION is set to turn it off).');
    expect(beadsStartupLine(beadsSetting('0'), false)).toBe('[beads] off (BEADS_INTEGRATION is set to turn it off).');
    expect(beadsStartupLine(beadsSetting(undefined), false)).toMatch(
      /^\[beads\] on by default, but the GitHub App is not configured, so the integration is idle\. Set BEADS_INTEGRATION=0/,
    );
    for (const line of [beadsStartupLine(beadsSetting('1'), true), beadsStartupLine(beadsSetting(undefined), false)]) {
      expect(line).not.toContain('\n');
    }
  });
});

describe('startup preconditions', () => {
  it('missing bd: one log line, then idle across sweeps', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    const { lines, logger } = recorder();
    const integration = h.integration({
      logger,
      runner: new BdRunner({ bdPath: join(h.dir, 'no-such-bd') }),
    });
    const first = await sweep(integration);
    await sweep(integration);
    const third = await sweep(integration);

    expect(first.idle).toMatch(/^bd binary not found/);
    expect(third.idle).toBe(first.idle);
    expect(third.repos).toEqual([]);
    expect(lines.warn).toHaveLength(1);
    expect(lines.warn[0]).toMatch(/^\[factory-beads\] integration idle: bd binary not found \(".*no-such-bd"; set BEADS_BD_PATH/);
    expect(lines.error).toEqual([]);
    expect(h.workItems.beadCards()).toHaveLength(0);
    expect(existsSync(cacheDirFor(h.cacheDir, SLUG))).toBe(false);
    expect(integration.diagnostics()).toMatchObject({ state: 'idle', idleReason: first.idle });
  });

  it('no versionControl (GitHub App not configured): one log line, then idle', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    const { lines, logger } = recorder();
    const integration = h.integration({ logger, sourceControl: { id: 'github' } });
    await sweep(integration);
    const second = await sweep(integration);
    expect(second.idle).toMatch(/has no versionControl capability/);
    expect(lines.warn).toHaveLength(1);
    // Never probed bd: the first failed precondition is enough.
    expect(h.state().calls).toHaveLength(0);
  });

  it('a present bd is probed once and the integration runs', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    const integration = h.integration();
    await sweep(integration);
    await sweep(integration);
    expect(h.state().calls.filter(c => c.argv.includes('--version'))).toHaveLength(1);
    expect(integration.diagnostics()).toMatchObject({ state: 'running' });
    expect(integration.diagnostics()).not.toHaveProperty('idleReason');
  });
});

describe('no-beads-data', () => {
  it('is a state, not an error, across repeated sweeps; nothing is bootstrapped', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    h.setBeadsData(false);
    const { lines, logger } = recorder();
    const integration = h.integration({ logger });

    const summaries = [];
    for (let i = 0; i < 4; i++) summaries.push(await sweep(integration));

    for (const s of summaries) {
      expect(s.error).toBeUndefined();
      expect(s.repos).toEqual([
        expect.objectContaining({ repo: SLUG, state: 'no-beads-data', created: 0, diagnostic: expect.stringContaining('refs/dolt/data') }),
      ]);
    }
    expect(lines.warn).toEqual([]);
    expect(lines.error).toEqual([]);
    // One informational line when the state is first seen, not one per sweep.
    expect(lines.info.filter(l => l.includes('no-beads-data'))).toHaveLength(1);
    expect(bdCommands(h)).toEqual([]);
    expect(h.workItems.beadCards()).toHaveLength(0);
    expect(existsSync(cacheDirFor(h.cacheDir, SLUG))).toBe(false);
    // Origin was looked at once; later sweeps wait for the slower re-check.
    const [first] = summaries[0]!.repos;
    expect(summaries[3]!.repos[0]!.checkedAt).toBe(first!.checkedAt);
    expect(Date.parse(first!.nextCheckAt!) - Date.parse(first!.checkedAt)).toBe(15 * MIN);
  });

  it('the slower re-check picks the repository up once refs/dolt/data appears', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
    h = createHarness([{ id: 'w-1', title: 'One', description: 'Described.' }]);
    h.setBeadsData(false);
    const { lines, logger } = recorder();
    const integration = h.integration({ logger });

    expect((await sweep(integration)).repos[0]?.state).toBe('no-beads-data');
    h.setBeadsData(true);
    // Before the re-check is due, the cached state stands and GitHub is not asked.
    vi.setSystemTime(new Date('2026-10-08T12:14:00Z'));
    expect((await sweep(integration)).repos[0]?.state).toBe('no-beads-data');
    expect(bdCommands(h)).toEqual([]);

    vi.setSystemTime(new Date('2026-10-08T12:15:01Z'));
    const picked = await sweep(integration);
    expect(picked.repos[0]).toMatchObject({ state: 'ok', created: 1 });
    expect(picked.repos[0]).not.toHaveProperty('nextCheckAt');
    expect(bdCommands(h).filter(c => c === 'bootstrap')).toHaveLength(1);
    expect(lines.info.some(l => l.includes('refs/dolt/data found on origin'))).toBe(true);
    expect(lines.warn).toEqual([]);
    // Intake and the description comment work as usual afterwards.
    const card = h.workItems.beadCards()[0]!;
    expect(card.metadata?.[BEADS_META.id]).toBe('w-1');
    expect(h.feed.on(card.id).map(c => c.body)).toEqual(['Described.']);
  });

  it('a copy bootstrapped earlier is dropped when origin has no beads data', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    const integration = h.integration();
    await sweep(integration);
    const dir = cacheDirFor(h.cacheDir, SLUG);
    expect(existsSync(dir)).toBe(true);

    h.setBeadsData(false);
    const pullsBefore = bdCommands(h).filter(c => c === 'dolt').length;
    const summary = await sweep(integration);
    expect(summary.repos[0]?.state).toBe('no-beads-data');
    expect(existsSync(dir)).toBe(false);
    expect(bdCommands(h).filter(c => c === 'dolt')).toHaveLength(pullsBefore);
  });

  it('a failing remote check is a real error, logged, and retried next sweep', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    const { lines, logger } = recorder();
    const integration = h.integration({
      logger,
      sourceControl: {
        id: 'github',
        versionControl: {
          getRepositoryAccess: async () => ({ cloneUrl: join(h!.dir, 'missing-remote'), authorization: { scheme: 'bearer', token: TOKEN } }),
        } as never,
      },
    });
    const first = await sweep(integration);
    const second = await sweep(integration);
    for (const s of [first, second]) {
      expect(s.repos[0]).toMatchObject({ state: 'error', diagnostic: expect.stringMatching(/^git ls-remote exit \d+/) });
      expect(s.repos[0]?.diagnostic).not.toContain(TOKEN);
    }
    expect(lines.warn.filter(l => l.includes('sweep finished with problems'))).toHaveLength(2);
  });
});

describe('GET /web/beads/status', () => {
  const status = async (integration: BeadsIntegration, harness: Harness) => {
    const route = integration.routes(harness.ctx).find(r => r.path === '/web/beads/status')!;
    expect(route.method).toBe('GET');
    const c = { json: (body: unknown, code = 200) => ({ body, code }), req: {} };
    const { handler } = route as unknown as { handler: (ctx: typeof c) => Promise<{ body: Record<string, unknown>; code: number }> };
    return (await handler(c)).body;
  };

  it('shows each linked repository with its state and when it was last checked', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    // A second linked repository whose origin has no beads data.
    const plain = join(h.dir, 'plain');
    execFileSync('git', ['init', '-q', '-b', 'main', plain]);
    execFileSync('git', ['-C', plain, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    h.sourceControl.connections[0]!.repositoryIds.push('repo_2');
    h.sourceControl.repositories.set('repo_2', 'acme/plain');
    const remote = h.remote;
    const integration = h.integration({
      sourceControl: {
        id: 'github',
        versionControl: {
          getRepositoryAccess: async ({ repositoryId }: { repositoryId: string }) => ({
            cloneUrl: repositoryId === 'repo_2' ? plain : remote,
            authorization: { scheme: 'bearer', token: TOKEN },
          }),
        } as never,
      },
    });

    const before = await status(integration, h);
    expect(before).toMatchObject({ repos: [], lastSweep: null });

    await sweep(integration);
    const body = await status(integration, h);
    expect(body.diagnostics).toMatchObject({ state: 'running', board: 'work', donePhase: 'done', remoteCheckIntervalMs: 15 * MIN });
    expect(body.repos).toEqual([
      { repo: SLUG, projectId: PROJECT, state: 'ok', checkedAt: expect.any(String) },
      {
        repo: 'acme/plain',
        projectId: PROJECT,
        state: 'no-beads-data',
        reason: expect.stringContaining('refs/dolt/data'),
        checkedAt: expect.any(String),
        nextCheckAt: expect.any(String),
      },
    ]);
    expect((body.lastSweep as { repos: unknown[] }).repos).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it('shows a parked repository with its reason', async () => {
    h = createHarness([{ id: 'w-a', title: 'A' }]);
    const integration = h.integration();
    await sweep(integration);
    h.workItems.move(h.workItems.beadCards()[0]!.id, 'done');
    h.setState(s => (s.syncExits = [2]));
    await sweep(integration);
    const body = await status(integration, h);
    expect(body.repos).toEqual([
      expect.objectContaining({ repo: SLUG, state: 'parked', reason: expect.stringContaining('bd sync exit 2') }),
    ]);
  });

  it('shows the idle reason when a precondition failed', async () => {
    h = createHarness([]);
    const integration = h.integration({ runner: new BdRunner({ bdPath: join(h.dir, 'no-such-bd') }) });
    await sweep(integration);
    const body = await status(integration, h);
    expect(body.diagnostics).toMatchObject({ state: 'idle', idleReason: expect.stringMatching(/^bd binary not found/) });
    expect(body.repos).toEqual([]);
  });
});
