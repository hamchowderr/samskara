import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { BEADS_META, beadsClaimKey, cacheDirFor, createBeadsDoneRule } from '../src/index';
import type { FactoryStageRuleContext } from '@mastra/factory/rules/types';
import { createHarness, ORG, PROJECT, SLUG, sweep, TOKEN } from './harness';
import type { Harness } from './harness';

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

const ids = (harness: Harness) => harness.workItems.beadCards().map(c => c.metadata?.[BEADS_META.id]);
const cardFor = (harness: Harness, beadId: string) =>
  harness.workItems.beadCards().find(c => c.metadata?.[BEADS_META.id] === beadId)!;
/** Each call as "<command> <first operand>", skipping flags and flag values. */
const commands = (harness: Harness) =>
  harness.state().calls.map(c => {
    const words: string[] = [];
    for (let i = 0; i < c.argv.length; i++) {
      const arg = c.argv[i]!;
      if (arg === '--actor' || arg === '--reason' || arg === '-n') i++;
      else if (!arg.startsWith('-')) words.push(arg);
    }
    return words.slice(0, 2).join(' ');
  });

describe('intake', () => {
  it('cards ready beads only, never epics, with the claim key and external source', async () => {
    h = createHarness([
      { id: 'w-1', title: 'Epic', issue_type: 'epic' },
      { id: 'w-2', title: 'First', issue_type: 'task', priority: 1 },
      { id: 'w-3', title: 'Second', issue_type: 'task', blockedBy: ['w-2'] },
    ]);
    const summary = await sweep(h.integration());

    expect(summary.repos).toEqual([expect.objectContaining({ repo: SLUG, created: 1, state: 'ok' })]);
    expect(ids(h)).toEqual(['w-2']);
    const card = cardFor(h, 'w-2');
    expect(card.externalSource).toEqual({ integrationId: 'beads', type: 'issue', externalId: 'w-2' });
    expect(card.claimKey).toBe(beadsClaimKey(SLUG, 'w-2'));
    expect(card.claimKey).toBe('beads:acme/widgets:w-2');
    expect(card.board).toBe('work');
    expect(card.stages).toEqual(['intake']);
    expect(card.title).toBe('w-2: First');
    expect(card.metadata).toMatchObject({ beadsRepo: SLUG, beadsType: 'task', beadsPriority: 1 });
  });

  it('is idempotent across repeated sweeps and a restart', async () => {
    h = createHarness([
      { id: 'w-1', title: 'One' },
      { id: 'w-2', title: 'Two' },
    ]);
    const first = h.integration();
    await sweep(first);
    await sweep(first);
    await sweep(first);
    // A new instance with a cold in-memory state, as after a server restart.
    const restarted = h.integration();
    const summary = await sweep(restarted);

    expect(ids(h).sort()).toEqual(['w-1', 'w-2']);
    expect(summary.repos[0]).toMatchObject({ created: 0, existing: 2 });
    // Bootstrapped once: the copy survives in the cache directory.
    expect(commands(h).filter(c => c === 'bootstrap')).toHaveLength(1);
  });

  it('skips a bead another project in the org already claimed', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    await h.workItems.upsert({
      orgId: ORG,
      userId: 'u',
      factoryProjectId: 'other_project',
      input: { title: 'held elsewhere', claimKey: beadsClaimKey(SLUG, 'w-1') },
    });
    const summary = await sweep(h.integration());
    expect(summary.repos[0]).toMatchObject({ created: 0, existing: 1, state: 'ok' });
    expect(h.workItems.items.filter(i => i.factoryProjectId === PROJECT)).toHaveLength(0);
  });

  it('pulls with credentials before reading, and reads with --readonly', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    await sweep(h.integration());
    const calls = h.state().calls;
    const pull = calls.find(c => c.argv.join(' ') === 'dolt pull')!;
    const ready = calls.find(c => c.argv.includes('ready'))!;
    expect(calls.indexOf(pull)).toBeLessThan(calls.indexOf(ready));
    expect(pull.env.token).toBe(TOKEN);
    expect(ready.argv).toEqual(['--readonly', 'ready', '--json', '--brief', '--exclude-type=epic', '-n', '0']);
    // Reads get no credential at all.
    expect(ready.env.token).toBeNull();
  });
});

describe('write-back and ordering', () => {
  it('cards B only after A reaches done, is closed and synced', async () => {
    h = createHarness([
      { id: 'w-a', title: 'A' },
      { id: 'w-b', title: 'B', blockedBy: ['w-a'] },
    ]);
    const integration = h.integration({ closeReason: item => `card ${item.id} done` });
    await sweep(integration);
    expect(ids(h)).toEqual(['w-a']);

    // Nothing is written while the card is not in the done phase.
    await sweep(integration);
    expect(commands(h)).not.toContain('close w-a');
    expect(ids(h)).toEqual(['w-a']);

    h.workItems.move(cardFor(h, 'w-a').id, 'done');
    const summary = await sweep(integration);

    expect(summary.repos[0]).toMatchObject({ closed: 1, created: 1, state: 'ok' });
    expect(ids(h)).toEqual(['w-a', 'w-b']);
    const a = cardFor(h, 'w-a');
    expect(a.metadata).toMatchObject({ beadsWriteback: 'synced' });
    expect(typeof a.metadata?.beadsSyncedAt).toBe('string');
    expect(h.state().beads.find(b => b.id === 'w-a')).toMatchObject({ status: 'closed', closeReason: `card ${a.id} done` });

    const seq = commands(h);
    expect(seq).toContain('close w-a');
    expect(seq.indexOf('close w-a')).toBeLessThan(seq.lastIndexOf('sync'));
    const close = h.state().calls.find(c => c.argv.includes('close'))!;
    expect(close.argv.slice(0, 3)).toEqual(['--sandbox', '--actor', 'factory-beads']);

    // Already synced: a further sweep writes nothing.
    const before = commands(h).filter(c => c === 'sync').length;
    await sweep(integration);
    expect(commands(h).filter(c => c === 'sync')).toHaveLength(before);
  });

  it('exit 2 (conflict): flags the card, surfaces a redacted diagnostic, never retries, parks the repo', async () => {
    h = createHarness([{ id: 'w-a', title: 'A' }]);
    const integration = h.integration();
    await sweep(integration);
    h.workItems.move(cardFor(h, 'w-a').id, 'done');
    h.setState(s => (s.syncExits = [2]));

    const summary = await sweep(integration);
    expect(summary.repos[0]?.state).toBe('blocked');
    expect(summary.repos[0]?.diagnostic).toContain('bd sync exit 2');
    expect(summary.repos[0]?.diagnostic).not.toContain(TOKEN);
    expect(commands(h).filter(c => c === 'sync')).toHaveLength(1);
    const card = cardFor(h, 'w-a');
    expect(card.metadata).toMatchObject({ beadsWriteback: 'conflict', beadsSyncExit: 2 });
    expect(String(card.metadata?.beadsDiagnostic)).toContain('[REDACTED]');
    expect(card.metadata?.beadsSyncedAt).toBeUndefined();

    // Parked: the next sweep runs no bd command at all for this repo.
    const callsBefore = h.state().calls.length;
    const parked = await sweep(integration);
    expect(parked.repos[0]?.state).toBe('blocked');
    expect(h.state().calls).toHaveLength(callsBefore);

    // Reset: the lease holder drops the copy, re-bootstraps, and syncs again.
    expect(await integration.requestReset(ORG, SLUG)).toEqual({ flagged: 1 });
    const resumed = await sweep(integration);
    expect(resumed.repos[0]).toMatchObject({ state: 'ok', closed: 1 });
    expect(cardFor(h, 'w-a').metadata).toMatchObject({ beadsWriteback: 'synced' });
    expect(commands(h).filter(c => c === 'bootstrap')).toHaveLength(2);
  });

  it('exit 3 (push race): retries with backoff, capped, then leaves the card pending', async () => {
    h = createHarness([{ id: 'w-a', title: 'A' }]);
    const integration = h.integration({ syncRetry: { retries: 2, baseDelayMs: 1 } });
    await sweep(integration);
    h.workItems.move(cardFor(h, 'w-a').id, 'done');

    h.setState(s => (s.syncExits = [3, 3, 3]));
    const exhausted = await sweep(integration);
    expect(commands(h).filter(c => c === 'sync')).toHaveLength(3);
    expect(exhausted.repos[0]).toMatchObject({ state: 'error', closed: 0 });
    expect(cardFor(h, 'w-a').metadata?.beadsSyncedAt).toBeUndefined();
    expect(cardFor(h, 'w-a').metadata?.beadsWriteback).toBeUndefined();

    // Next tick: the bead is already closed locally, so only sync runs again.
    h.setState(s => (s.syncExits = [3, 0]));
    const recovered = await sweep(integration);
    expect(recovered.repos[0]).toMatchObject({ state: 'ok', closed: 1 });
    expect(commands(h).filter(c => c === 'sync')).toHaveLength(5);
    expect(commands(h).filter(c => c === 'close w-a')).toHaveLength(1);
  });

  it('parks a card as close-failed after the attempt cap', async () => {
    h = createHarness([{ id: 'w-a', title: 'A' }]);
    const integration = h.integration({ maxCloseAttempts: 2 });
    await sweep(integration);
    h.workItems.move(cardFor(h, 'w-a').id, 'done');
    h.setState(s => (s.closeFail = ['w-a']));
    await sweep(integration);
    await sweep(integration);
    await sweep(integration);
    expect(commands(h).filter(c => c === 'close w-a')).toHaveLength(2);
    expect(cardFor(h, 'w-a').metadata).toMatchObject({ beadsWriteback: 'close-failed', beadsCloseAttempts: 2 });
  });
});

describe('done rule', () => {
  const context = (metadata: Record<string, unknown> | null) =>
    ({ item: { metadata } }) as unknown as Readonly<FactoryStageRuleContext>;

  it('only wakes the worker, for beads cards, and returns no decision', async () => {
    h = createHarness([]);
    const integration = h.integration();
    let kicks = 0;
    integration.kick = () => {
      kicks++;
    };
    const rule = createBeadsDoneRule();
    expect(rule(context({ beadsId: 'w-1' }))).toBeUndefined();
    expect(rule(context({ other: true }))).toBeUndefined();
    expect(rule(context(null))).toBeUndefined();
    expect(kicks).toBe(1);
  });
});

describe('repository cache', () => {
  it('keeps one copy per repo under the cache directory', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    await sweep(h.integration());
    expect(existsSync(join(cacheDirFor(h.cacheDir, SLUG), '.git', 'factory-beads-bootstrapped'))).toBe(true);
  });
});

describe('linked repositories', () => {
  it('skips an orphaned connection and an unlinked project, and still sweeps the valid link', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    // The owner's case: one project with a valid connection and one whose
    // installation was pruned (samskara-1ra), plus a project with no connection.
    h.sourceControl.connections.push({ id: 'conn_orphan', factoryProjectId: PROJECT, installationId: 'inst_pruned', repositoryIds: ['repo_2'] });
    h.sourceControl.repositories.set('repo_2', 'acme/gone');
    h.sourceControl.projects.push({ id: 'proj_unlinked', orgId: ORG });
    const warnings: string[] = [];
    const integration = h.integration({
      logger: { info: () => undefined, warn: (...args: unknown[]) => void warnings.push(args.join(' ')), error: () => undefined },
    });

    const first = await sweep(integration);
    expect(first.error).toBeUndefined();
    expect(first.repos).toEqual([expect.objectContaining({ projectId: PROJECT, repo: SLUG, created: 1, state: 'ok' })]);
    expect(ids(h)).toEqual(['w-1']);

    const second = await sweep(integration);
    expect(second.error).toBeUndefined();
    expect(second.repos).toEqual([expect.objectContaining({ repo: SLUG, existing: 1, state: 'ok' })]);

    const orphanWarnings = warnings.filter(w => w.includes('conn_orphan'));
    expect(orphanWarnings).toHaveLength(1);
    expect(orphanWarnings[0]).toMatch(/orphaned source-control connection conn_orphan on project proj_1/);
    expect(warnings.some(w => w.includes('sweep finished with problems'))).toBe(false);
  });

  it('without the guard, the orphaned connection is what throws', async () => {
    h = createHarness([]);
    h.sourceControl.connections.push({ id: 'conn_orphan', factoryProjectId: PROJECT, installationId: 'inst_pruned', repositoryIds: ['repo_2'] });
    const handle = (h.ctx.storage as unknown as { sourceControls: Array<{ projectRepositories: { list(a: object): Promise<unknown> } }> }).sourceControls[0]!;
    await expect(handle.projectRepositories.list({ orgId: ORG, connectionId: 'conn_orphan' })).rejects.toThrow(
      'Project source-control connection not found for this organization and integration.',
    );
  });
});
