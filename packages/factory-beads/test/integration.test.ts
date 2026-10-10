import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BEADS_META,
  beadsClaimKey,
  cacheDirFor,
  createBeadsDoneRule,
  descriptionBody,
  FACTORY_REPOSITORY_META,
  MAX_COMMENT_BODY,
  OVERVIEW_CARD_KIND,
  OVERVIEW_WORKING_REASON,
  parentsFirst,
  PLAN_CARD_KIND,
  RESEARCH_CARD_KIND,
} from '../src/index';
import type { FactoryStageRuleContext } from '@mastra/factory/rules/types';
// Factory's own resolver, the one dispatch runs (rules/start-coordinator.js:80, routes/surface.js:159).
import { resolveWorkItemRepository } from '@mastra/factory/session/work-item-repository';
import type { SourceControlStorageHandle } from '@mastra/factory/storage/domains/source-control/base';
import { createHarness, MAX_DISPATCH_ATTEMPTS, ORG, PROJECT, SLUG, sweep, TOKEN } from './harness';
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
  it('cards ready beads only, never milestones or pinned beads, with the claim key and external source', async () => {
    h = createHarness([
      { id: 'w-1', title: 'Epic', issue_type: 'epic' },
      { id: 'w-4', title: 'Milestone', issue_type: 'milestone' },
      { id: 'w-5', title: 'Pinned', issue_type: 'task', status: 'pinned' },
      { id: 'w-2', title: 'First', issue_type: 'task', priority: 1 },
      { id: 'w-3', title: 'Second', issue_type: 'task', blockedBy: ['w-2'] },
    ]);
    const summary = await sweep(h.integration());

    // The childless epic is a planning card (samskara-l2t.2.4), not work.
    expect(summary.repos).toEqual([expect.objectContaining({ repo: SLUG, created: 2, state: 'ok' })]);
    expect(ids(h)).toEqual(['w-1', 'w-2']);
    expect(cardFor(h, 'w-1').metadata?.[BEADS_META.cardKind]).toBe(PLAN_CARD_KIND);
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
    // No --brief: it would drop the description (bd ready --help, bd 1.3.0).
    // Epics are read (samskara-l2t.2.4); milestones never are.
    expect(ready.argv).toEqual(['--readonly', 'ready', '--json', '--exclude-type=milestone', '-n', '0']);
    // Reads get no credential at all.
    expect(ready.env.token).toBeNull();
  });
});

describe('description on the card feed', () => {
  it('posts one integration-authored comment per card across repeated sweeps and a restart', async () => {
    h = createHarness([
      { id: 'w-1', title: 'One', description: 'Do the first thing.\nCarefully.' },
      { id: 'w-2', title: 'Two', description: 'Second.' },
    ]);
    const first = h.integration();
    await sweep(first);
    await sweep(first);
    await sweep(first);
    const callsBeforeRestart = h.feed.calls;
    // Confirmed cards are not re-posted within one process.
    expect(callsBeforeRestart).toBe(2);
    await sweep(h.integration());

    expect(h.feed.comments).toHaveLength(2);
    // A restart replays each card once; the store returns the existing row.
    expect(h.feed.calls).toBe(callsBeforeRestart + 2);
    const card = cardFor(h, 'w-1');
    const [comment] = h.feed.on(card.id);
    expect(comment).toMatchObject({
      body: 'Do the first thing.\nCarefully.',
      author: { kind: 'integration', id: 'integration:beads', displayName: 'beads' },
      externalSource: { integrationId: 'beads', type: 'description', externalId: 'w-1' },
    });
    expect(comment!.occurredAt.getTime()).toBe(new Date(card.createdAt).getTime());
  });

  it('back-fills a card that predates the feature', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    await sweep(h.integration());
    expect(h.feed.comments).toHaveLength(0);
    // The bead gains a description (or the card came from an older build).
    h.setState(s => (s.beads[0]!.description = 'Now described.'));
    const summary = await sweep(h.integration());
    expect(summary.repos[0]).toMatchObject({ created: 0, existing: 1 });
    expect(h.feed.on(cardFor(h, 'w-1').id).map(c => c.body)).toEqual(['Now described.']);
  });

  it('keeps the first description when the bead is edited later', async () => {
    h = createHarness([{ id: 'w-1', title: 'One', description: 'Original.' }]);
    await sweep(h.integration());
    h.setState(s => (s.beads[0]!.description = 'Edited.'));
    await sweep(h.integration());
    expect(h.feed.comments.map(c => c.body)).toEqual(['Original.']);
  });

  it('posts nothing for an empty or whitespace description', async () => {
    h = createHarness([
      { id: 'w-1', title: 'One' },
      { id: 'w-2', title: 'Two', description: '   \n' },
    ]);
    await sweep(h.integration());
    expect(ids(h).sort()).toEqual(['w-1', 'w-2']);
    expect(h.feed.calls).toBe(0);
  });

  it('cards still land when the feed is unavailable, and it warns once', async () => {
    h = createHarness([
      { id: 'w-1', title: 'One', description: 'Described.' },
      { id: 'w-2', title: 'Two', description: 'Also described.' },
    ]);
    delete (h.ctx as { feed?: unknown }).feed;
    const warnings: string[] = [];
    const integration = h.integration({
      logger: { info: () => undefined, warn: (...args: unknown[]) => void warnings.push(args.join(' ')), error: () => undefined },
    });
    const summary = await sweep(integration);
    await sweep(integration);
    expect(summary.repos[0]).toMatchObject({ created: 2, state: 'ok' });
    expect(warnings.filter(w => w.includes('feed is not available'))).toHaveLength(1);
    expect(h.feed.calls).toBe(0);
  });

  it('a failing feed does not fail the sweep', async () => {
    h = createHarness([{ id: 'w-1', title: 'One', description: 'Described.' }]);
    h.feed.createComment = async () => {
      throw new Error('database is locked');
    };
    const summary = await sweep(h.integration());
    expect(summary.repos[0]).toMatchObject({ created: 1, state: 'ok' });
  });

  it('truncates a description over the body limit, with a note, and never splits a surrogate pair', async () => {
    const long = 'a'.repeat(MAX_COMMENT_BODY - 200) + '😀'.repeat(400);
    h = createHarness([{ id: 'w-1', title: 'One', description: long }]);
    await sweep(h.integration());
    const [comment] = h.feed.comments;
    expect(comment!.body.length).toBeLessThanOrEqual(MAX_COMMENT_BODY);
    expect(comment!.body).toMatch(/\[Truncated: the bead's description is \d+ characters; the full text is in beads\.\]$/);
    expect(comment!.body.startsWith(long.slice(0, MAX_COMMENT_BODY - 300))).toBe(true);
    expect(comment!.body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    // At or under the limit, the body is the description unchanged.
    expect(descriptionBody('x'.repeat(MAX_COMMENT_BODY))).toBe('x'.repeat(MAX_COMMENT_BODY));
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
    expect(summary.repos[0]?.state).toBe('parked');
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
    expect(parked.repos[0]?.state).toBe('parked');
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

  it('closes a bead someone else holds by handing it over first, never with --force', async () => {
    h = createHarness([{ id: 'w-a', title: 'A', assignee: 'alice' }]);
    const integration = h.integration();
    await sweep(integration);
    h.workItems.move(cardFor(h, 'w-a').id, 'done');

    const summary = await sweep(integration);
    expect(summary.repos[0]).toMatchObject({ state: 'ok', closed: 1 });
    expect(h.state().beads.find(b => b.id === 'w-a')).toMatchObject({ status: 'closed', assignee: 'factory-beads' });
    const handover = h.state().calls.find(c => c.argv.includes('update'))!;
    expect(handover.argv).toEqual(
      expect.arrayContaining(['--sandbox', '--actor', 'factory-beads', 'update', 'w-a', '--assignee=factory-beads', '--if-assignee=alice']),
    );
    expect(h.state().calls.some(c => c.argv.includes('--force'))).toBe(false);
  });

  it('a handover that loses the race leaves a readable diagnostic and does not close', async () => {
    h = createHarness([{ id: 'w-a', title: 'A', assignee: 'alice' }]);
    const integration = h.integration();
    await sweep(integration);
    h.workItems.move(cardFor(h, 'w-a').id, 'done');
    // Someone takes the bead between the read and the compare-and-swap.
    h.setState(s => (s.casFail = ['w-a']));

    const summary = await sweep(integration);
    expect(summary.repos[0]).toMatchObject({ state: 'error', closed: 0 });
    expect(h.state().beads.find(b => b.id === 'w-a')?.status).not.toBe('closed');
    expect(commands(h)).not.toContain('close w-a');
    const diagnostic = String(cardFor(h, 'w-a').metadata?.beadsDiagnostic);
    expect(diagnostic).toContain('exit 13');
    expect(diagnostic).toContain('handing w-a over from "alice" failed');
  });

  it("closes a bead under someone's live claim (owner decision: Done wins)", async () => {
    h = createHarness([{ id: 'w-a', title: 'A', status: 'in_progress', assignee: 'alice' }]);
    const integration = h.integration();
    // in_progress is not ready, so card it first as open, then claim it.
    h.setState(s => (s.beads[0]!.status = 'open'));
    await sweep(integration);
    h.setState(s => (s.beads[0]!.status = 'in_progress'));
    h.workItems.move(cardFor(h, 'w-a').id, 'done');

    const summary = await sweep(integration);
    expect(summary.repos[0]).toMatchObject({ state: 'ok', closed: 1 });
    expect(h.state().beads[0]).toMatchObject({ status: 'closed', assignee: 'factory-beads' });
    expect(h.state().calls.some(c => c.argv.includes('--force'))).toBe(false);
  });

  it('a close bd refuses after the handover returns the bead to its holder', async () => {
    h = createHarness([{ id: 'w-a', title: 'A', assignee: 'alice' }]);
    const integration = h.integration();
    await sweep(integration);
    h.setState(s => (s.beads[0]!.status = 'pinned'));
    h.workItems.move(cardFor(h, 'w-a').id, 'done');

    const summary = await sweep(integration);
    expect(summary.repos[0]).toMatchObject({ state: 'error', closed: 0 });
    expect(h.state().beads[0]).toMatchObject({ status: 'pinned', assignee: 'alice' });
    const diagnostic = String(cardFor(h, 'w-a').metadata?.beadsDiagnostic);
    expect(diagnostic).toContain('cannot modify pinned issue w-a');
    expect(diagnostic).toContain('returned to "alice"');
  });

  it('reads each pending bead once per sweep', async () => {
    h = createHarness([{ id: 'w-a', title: 'A', assignee: 'alice' }]);
    const integration = h.integration();
    await sweep(integration);
    h.workItems.move(cardFor(h, 'w-a').id, 'done');
    await sweep(integration);
    expect(commands(h).filter(c => c === 'show w-a')).toHaveLength(1);
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

describe('repository on the card', () => {
  const GADGETS = 'acme/gadgets';
  /** Factory's resolver over the harness's source-control handle, for one card's metadata. */
  const resolve = (harness: Harness, metadata: Record<string, unknown> | null) =>
    resolveWorkItemRepository({
      sourceControl: (harness.ctx.storage as unknown as { sourceControls: SourceControlStorageHandle[] }).sourceControls[0]!,
      orgId: ORG,
      factoryProjectId: PROJECT,
      item: { metadata },
    });
  /** Link a second repository to the same project and connection. */
  const linkGadgets = (harness: Harness) => {
    harness.sourceControl.connections[0]!.repositoryIds.push('repo_2');
    harness.sourceControl.repositories.set('repo_2', GADGETS);
  };

  it('single repository: the card names it, keeps beadsRepo, and resolves as before', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    await sweep(h.integration());
    const card = cardFor(h, 'w-1');
    expect(card.metadata).toMatchObject({ [FACTORY_REPOSITORY_META]: SLUG, [BEADS_META.repo]: SLUG });
    expect(await resolve(h, card.metadata)).toEqual({ status: 'resolved', slug: SLUG, projectRepositoryId: 'conn_1:repo_1' });
    // Before the field existed, the only linked repository was picked anyway.
    expect(await resolve(h, { [BEADS_META.repo]: SLUG })).toEqual({ status: 'resolved', slug: SLUG, projectRepositoryId: 'conn_1:repo_1' });
  });

  it('two repositories in one project: each card resolves to its own repository, with no pick', async () => {
    h = createHarness([
      { id: 'w-1', title: 'Widget work', repo: SLUG },
      { id: 'g-1', title: 'Gadget work', repo: GADGETS },
    ]);
    linkGadgets(h);
    const summary = await sweep(h.integration());
    expect(summary.repos).toEqual([
      expect.objectContaining({ repo: SLUG, created: 1, state: 'ok' }),
      expect.objectContaining({ repo: GADGETS, created: 1, state: 'ok' }),
    ]);

    const widget = cardFor(h, 'w-1');
    const gadget = cardFor(h, 'g-1');
    expect(widget.metadata).toMatchObject({ [FACTORY_REPOSITORY_META]: SLUG, [BEADS_META.repo]: SLUG });
    expect(gadget.metadata).toMatchObject({ [FACTORY_REPOSITORY_META]: GADGETS, [BEADS_META.repo]: GADGETS });
    expect(await resolve(h, widget.metadata)).toEqual({ status: 'resolved', slug: SLUG, projectRepositoryId: 'conn_1:repo_1' });
    expect(await resolve(h, gadget.metadata)).toEqual({ status: 'resolved', slug: GADGETS, projectRepositoryId: 'conn_1:repo_2' });
    // The instrument: a card naming only beadsRepo is what stops at the picker.
    expect(await resolve(h, { [BEADS_META.repo]: SLUG })).toEqual({ status: 'ambiguous', candidates: [GADGETS, SLUG] });
  });

  it('back-fills a card made before the field, and corrects a wrong one, on the next sweep', async () => {
    h = createHarness([
      { id: 'w-1', title: 'One', repo: SLUG },
      { id: 'w-2', title: 'Two', repo: SLUG },
    ]);
    linkGadgets(h);
    const integration = h.integration();
    await sweep(integration);
    // As a card made by the previous version: no repository. And one moved on
    // the board whose repository is not its bead's.
    const old = h.workItems.items.find(i => i.metadata?.[BEADS_META.id] === 'w-1')!;
    delete old.metadata![FACTORY_REPOSITORY_META];
    const moved = h.workItems.items.find(i => i.metadata?.[BEADS_META.id] === 'w-2')!;
    moved.metadata![FACTORY_REPOSITORY_META] = GADGETS;
    h.workItems.move(moved.id, 'execute');
    expect(await resolve(h, old.metadata)).toEqual({ status: 'ambiguous', candidates: [GADGETS, SLUG] });

    const summary = await sweep(integration);
    expect(summary.repos[0]).toMatchObject({ repo: SLUG, created: 0, state: 'ok' });
    for (const id of ['w-1', 'w-2']) {
      const card = cardFor(h, id);
      // Merged, not replaced: the beads keys are intact.
      expect(card.metadata).toMatchObject({ [FACTORY_REPOSITORY_META]: SLUG, [BEADS_META.id]: id, [BEADS_META.repo]: SLUG });
      expect(await resolve(h, card.metadata)).toEqual({ status: 'resolved', slug: SLUG, projectRepositoryId: 'conn_1:repo_1' });
    }
    expect(cardFor(h, 'w-2').stages).toEqual(['execute']);

    // Already named: a further sweep writes nothing.
    const revisions = h.workItems.beadCards().map(c => c.revision);
    await sweep(integration);
    expect(h.workItems.beadCards().map(c => c.revision)).toEqual(revisions);
  });
});

describe('overview cards and child linking (samskara-l2t.2.1)', () => {
  const card = (harness: Harness, beadId: string) => harness.workItems.items.find(i => i.metadata?.[BEADS_META.id] === beadId);
  const order = (harness: Harness) => harness.workItems.beadCards().map(c => c.metadata?.[BEADS_META.id]);
  const collectWarnings = () => {
    const warnings: string[] = [];
    return {
      warnings,
      logger: { info: () => undefined, warn: (...args: unknown[]) => void warnings.push(args.join(' ')), error: () => undefined },
    };
  };

  it('cards an epic with children as an overview card first, and links each child card under it', async () => {
    h = createHarness([
      { id: 'w-e', title: 'Epic', issue_type: 'epic', priority: 1, description: 'The whole thing.' },
      { id: 'w-e.1', title: 'One', issue_type: 'task', parent: 'w-e' },
      { id: 'w-e.2', title: 'Two', issue_type: 'task', parent: 'w-e' },
    ]);
    const summary = await sweep(h.integration());

    expect(summary.repos[0]).toMatchObject({ state: 'ok', created: 3 });
    // Parent before child: Factory refuses a parentWorkItemId it cannot find.
    expect(order(h)).toEqual(['w-e', 'w-e.1', 'w-e.2']);
    const epic = card(h, 'w-e')!;
    expect(epic).toMatchObject({
      title: 'w-e: Epic',
      stages: ['intake'],
      parentWorkItemId: null,
      claimKey: beadsClaimKey(SLUG, 'w-e'),
      externalSource: { integrationId: 'beads', type: 'issue', externalId: 'w-e' },
    });
    expect(epic.metadata).toMatchObject({
      [BEADS_META.cardKind]: OVERVIEW_CARD_KIND,
      [BEADS_META.openChildren]: 2,
      [BEADS_META.type]: 'epic',
      [BEADS_META.priority]: 1,
      [FACTORY_REPOSITORY_META]: SLUG,
    });
    for (const id of ['w-e.1', 'w-e.2']) {
      expect(card(h, id)!.parentWorkItemId).toBe(epic.id);
      expect(card(h, id)!.metadata?.[BEADS_META.cardKind]).toBeUndefined();
    }
    // The container's description is on its card like any other.
    expect(h.feed.on(epic.id).map(c => c.body)).toEqual(['The whole thing.']);
    // Milestones are never read as ready; an epic is, and is sorted by its children.
    const ready = h.state().calls.find(c => c.argv.includes('ready'))!;
    expect(ready.argv).toContain('--exclude-type=milestone');
    const list = h.state().calls.find(c => c.argv.includes('list'))!;
    expect(list.argv).toEqual(['--readonly', 'list', '--parent=w-e', '--all', '--flat', '--json', '-n', '0']);
  });

  it('walks nested containers top-down and resolves each container once per sweep', async () => {
    h = createHarness([
      { id: 'w-e', title: 'Epic', issue_type: 'epic' },
      { id: 'w-e.1', title: 'Nested', issue_type: 'epic', parent: 'w-e' },
      { id: 'w-e.1.1', title: 'Grandchild', issue_type: 'task', parent: 'w-e.1' },
      { id: 'w-e.1.2', title: 'Grandchild 2', issue_type: 'task', parent: 'w-e.1' },
      { id: 'w-e.2', title: 'Child', issue_type: 'task', parent: 'w-e' },
    ]);
    await sweep(h.integration());

    expect(order(h)).toEqual(['w-e', 'w-e.1', 'w-e.1.1', 'w-e.1.2', 'w-e.2']);
    const epic = card(h, 'w-e')!;
    const nested = card(h, 'w-e.1')!;
    expect(nested.parentWorkItemId).toBe(epic.id);
    expect(nested.metadata).toMatchObject({ [BEADS_META.cardKind]: OVERVIEW_CARD_KIND, [BEADS_META.openChildren]: 2 });
    // Direct children only: the nested epic and the child, not the grandchildren.
    expect(epic.metadata?.[BEADS_META.openChildren]).toBe(2);
    expect(card(h, 'w-e.1.1')!.parentWorkItemId).toBe(nested.id);
    expect(card(h, 'w-e.1.2')!.parentWorkItemId).toBe(nested.id);
    expect(card(h, 'w-e.2')!.parentWorkItemId).toBe(epic.id);
    expect(commands(h).filter(c => c === 'show w-e')).toHaveLength(1);
    expect(commands(h).filter(c => c === 'show w-e.1')).toHaveLength(1);
  });

  it('cards a molecule root and a milestone with children as overview cards', async () => {
    h = createHarness([
      { id: 'w-mol', title: 'demo', issue_type: 'molecule' },
      { id: 'w-mol.1', title: 'First', issue_type: 'task', parent: 'w-mol' },
      { id: 'w-mol.2', title: 'Second', issue_type: 'task', parent: 'w-mol', blockedBy: ['w-mol.1'] },
      { id: 'w-m', title: 'Milestone', issue_type: 'milestone' },
      { id: 'w-m.1', title: 'Member', issue_type: 'task', parent: 'w-m' },
    ]);
    await sweep(h.integration());

    expect(order(h)).toEqual(['w-mol', 'w-mol.1', 'w-m', 'w-m.1']);
    expect(card(h, 'w-mol')!.metadata).toMatchObject({
      [BEADS_META.cardKind]: OVERVIEW_CARD_KIND,
      [BEADS_META.openChildren]: 2,
      [BEADS_META.type]: 'molecule',
    });
    expect(card(h, 'w-mol.1')!.parentWorkItemId).toBe(card(h, 'w-mol')!.id);
    expect(card(h, 'w-m')!.metadata).toMatchObject({ [BEADS_META.cardKind]: OVERVIEW_CARD_KIND, [BEADS_META.type]: 'milestone' });
    expect(card(h, 'w-m.1')!.parentWorkItemId).toBe(card(h, 'w-m')!.id);
  });

  it('gives childless containers no overview card, and links nothing under a parent that is not a container', async () => {
    h = createHarness([
      { id: 'w-e', title: 'Childless epic', issue_type: 'epic' },
      { id: 'w-m', title: 'Childless milestone', issue_type: 'milestone' },
      { id: 'w-p', title: 'Parent task', issue_type: 'task', status: 'in_progress' },
      { id: 'w-p.1', title: 'Subtask', issue_type: 'task', parent: 'w-p' },
    ]);
    const summary = await sweep(h.integration());
    // The childless epic gets a planning card instead (samskara-l2t.2.4); the milestone nothing.
    expect(summary.repos[0]).toMatchObject({ state: 'ok', created: 2 });
    expect(order(h)).toEqual(['w-e', 'w-p.1']);
    expect(card(h, 'w-e')!.metadata?.[BEADS_META.cardKind]).toBe(PLAN_CARD_KIND);
    expect(card(h, 'w-p.1')!.parentWorkItemId).toBeNull();
  });

  it('back-fills the parent of a card made before its overview card, and a further sweep writes nothing', async () => {
    h = createHarness([
      { id: 'w-e', title: 'Epic', issue_type: 'epic' },
      { id: 'w-e.1', title: 'One', issue_type: 'task' },
    ]);
    const integration = h.integration();
    await sweep(integration);
    // The epic is childless, so it is a planning card for now.
    expect(order(h)).toEqual(['w-e', 'w-e.1']);
    expect(card(h, 'w-e')!.metadata?.[BEADS_META.cardKind]).toBe(PLAN_CARD_KIND);
    // The bead is moved under the epic (or the card predates this feature).
    h.setState(s => (s.beads[1]!.parent = 'w-e'));

    const summary = await sweep(integration);
    expect(summary.repos[0]).toMatchObject({ state: 'ok', created: 0 });
    expect(card(h, 'w-e')!.metadata).toMatchObject({ [BEADS_META.cardKind]: OVERVIEW_CARD_KIND, [BEADS_META.openChildren]: 1 });
    expect(card(h, 'w-e.1')!.parentWorkItemId).toBe(card(h, 'w-e')!.id);

    const revisions = h.workItems.beadCards().map(c => c.revision);
    await sweep(integration);
    await sweep(h.integration());
    expect(h.workItems.beadCards().map(c => c.revision)).toEqual(revisions);
  });

  it('keeps a parent someone set by hand', async () => {
    h = createHarness([
      { id: 'w-e', title: 'Epic', issue_type: 'epic' },
      { id: 'w-e.1', title: 'One', issue_type: 'task' },
    ]);
    const integration = h.integration();
    await sweep(integration);
    const other = await h.workItems.upsert({ orgId: ORG, userId: 'u', factoryProjectId: PROJECT, input: { title: 'A card made by a person' } });
    await h.workItems.setParentWorkItemIfMissing({ orgId: ORG, id: card(h, 'w-e.1')!.id, userId: 'u', parentWorkItemId: other.item.id });
    h.setState(s => (s.beads[1]!.parent = 'w-e'));
    await sweep(integration);
    expect(card(h, 'w-e.1')!.parentWorkItemId).toBe(other.item.id);
  });

  it('keeps the open-children count current, writing only when it changes', async () => {
    h = createHarness([
      { id: 'w-e', title: 'Epic', issue_type: 'epic' },
      { id: 'w-e.1', title: 'One', issue_type: 'task', parent: 'w-e' },
      { id: 'w-e.2', title: 'Two', issue_type: 'task', parent: 'w-e' },
    ]);
    const integration = h.integration();
    await sweep(integration);
    const revision = () => card(h!, 'w-e')!.revision;
    const before = revision();
    await sweep(integration);
    expect(revision()).toBe(before);

    // One child closes; the other is still ready.
    h.setState(s => (s.beads[1]!.status = 'closed'));
    await sweep(integration);
    expect(card(h, 'w-e')!.metadata?.[BEADS_META.openChildren]).toBe(1);

    // No child is ready (the last one is claimed): the count is still read.
    h.setState(s => (s.beads[2]!.status = 'in_progress'));
    await sweep(integration);
    expect(card(h, 'w-e')!.metadata?.[BEADS_META.openChildren]).toBe(1);
    h.setState(s => (s.beads[2]!.status = 'closed'));
    await sweep(integration);
    expect(card(h, 'w-e')!.metadata?.[BEADS_META.openChildren]).toBe(0);
    const settled = revision();
    await sweep(integration);
    expect(revision()).toBe(settled);
  });

  it('makes no overview card for a container whose child is carded in another project, and says so once', async () => {
    h = createHarness([
      // Blocked, so it is not ready itself and is reached only through its child.
      { id: 'w-e', title: 'Epic', issue_type: 'epic', blockedBy: ['w-x'] },
      { id: 'w-x', title: 'Blocker', issue_type: 'task', status: 'in_progress' },
      { id: 'w-e.1', title: 'One', issue_type: 'task', parent: 'w-e' },
    ]);
    await h.workItems.upsert({
      orgId: ORG,
      userId: 'u',
      factoryProjectId: 'other_project',
      input: { title: 'held elsewhere', claimKey: beadsClaimKey(SLUG, 'w-e.1') },
    });
    const { warnings, logger } = collectWarnings();
    const integration = h.integration({ logger });
    const summary = await sweep(integration);
    await sweep(integration);

    expect(summary.repos[0]).toMatchObject({ state: 'ok', created: 0, existing: 1 });
    expect(h.workItems.items.filter(i => i.factoryProjectId === PROJECT)).toHaveLength(0);
    expect(commands(h)).not.toContain('show w-e');
    expect(warnings.filter(w => w.includes('w-e.1 is carded in project other_project'))).toHaveLength(1);
  });

  it('cards the children without a parent when the container is carded in another project', async () => {
    h = createHarness([
      { id: 'w-e', title: 'Epic', issue_type: 'epic' },
      { id: 'w-e.1', title: 'One', issue_type: 'task', parent: 'w-e' },
    ]);
    await h.workItems.upsert({
      orgId: ORG,
      userId: 'u',
      factoryProjectId: 'other_project',
      input: { title: 'epic elsewhere', claimKey: beadsClaimKey(SLUG, 'w-e') },
    });
    const { warnings, logger } = collectWarnings();
    const summary = await sweep(h.integration({ logger }));
    expect(summary.repos[0]).toMatchObject({ state: 'ok', created: 1 });
    expect(order(h)).toEqual(['w-e.1']);
    expect(card(h, 'w-e.1')!.parentWorkItemId).toBeNull();
    expect(warnings.some(w => w.includes('w-e is carded in another project'))).toBe(true);
  });

  it('a failed children read still cards the child, unlinked, and the next sweep links it', async () => {
    h = createHarness([
      { id: 'w-e', title: 'Epic', issue_type: 'epic' },
      { id: 'w-e.1', title: 'One', issue_type: 'task', parent: 'w-e' },
    ]);
    h.setState(s => (s.listParentFail = ['w-e']));
    const integration = h.integration();
    const failed = await sweep(integration);
    expect(failed.repos[0]).toMatchObject({ state: 'ok', created: 1 });
    expect(card(h, 'w-e.1')!.parentWorkItemId).toBeNull();

    h.setState(s => (s.listParentFail = []));
    await sweep(integration);
    expect(card(h, 'w-e.1')!.parentWorkItemId).toBe(card(h, 'w-e')!.id);
  });
});

describe('research cards for decision beads (samskara-l2t.2.3)', () => {
  const card = (harness: Harness, beadId: string) => harness.workItems.items.find(i => i.metadata?.[BEADS_META.id] === beadId);

  it('cards an open decision as a research card, a work bead with no kind, and never a closed decision', async () => {
    h = createHarness([
      { id: 'w-d', title: 'Which queue?', issue_type: 'decision', description: 'Which queue should jobs use?' },
      { id: 'w-old', title: 'Settled', issue_type: 'decision', status: 'closed' },
      { id: 'w-1', title: 'Work', issue_type: 'task' },
    ]);
    const summary = await sweep(h.integration());

    expect(summary.repos[0]).toMatchObject({ state: 'ok', created: 2 });
    expect(ids(h).sort()).toEqual(['w-1', 'w-d']);
    expect(card(h, 'w-d')).toMatchObject({ stages: ['intake'], title: 'w-d: Which queue?' });
    expect(card(h, 'w-d')!.metadata).toMatchObject({
      [BEADS_META.cardKind]: RESEARCH_CARD_KIND,
      [BEADS_META.type]: 'decision',
    });
    expect(card(h, 'w-1')!.metadata?.[BEADS_META.cardKind]).toBeUndefined();
    // The question reaches the agent on the card's feed like any description.
    expect(h.feed.on(card(h, 'w-d')!.id).map(c => c.body)).toEqual(['Which queue should jobs use?']);
  });

  it("links a decision under its epic's overview card and counts it as an open child", async () => {
    h = createHarness([
      { id: 'w-e', title: 'Epic', issue_type: 'epic' },
      { id: 'w-e.1', title: 'Which store?', issue_type: 'decision', parent: 'w-e' },
    ]);
    await sweep(h.integration());
    expect(card(h, 'w-e.1')!.metadata?.[BEADS_META.cardKind]).toBe(RESEARCH_CARD_KIND);
    expect(card(h, 'w-e.1')!.parentWorkItemId).toBe(card(h, 'w-e')!.id);
    expect(card(h, 'w-e')!.metadata).toMatchObject({ [BEADS_META.cardKind]: OVERVIEW_CARD_KIND, [BEADS_META.openChildren]: 1 });
  });

  it('marks a decision card made before research cards existed, once, and writes nothing on later sweeps', async () => {
    h = createHarness([{ id: 'w-d', title: 'Which queue?', issue_type: 'decision' }]);
    await h.workItems.upsert({
      orgId: ORG,
      userId: 'u',
      factoryProjectId: PROJECT,
      input: {
        board: 'work',
        externalSource: { integrationId: 'beads', type: 'issue', externalId: 'w-d' },
        claimKey: beadsClaimKey(SLUG, 'w-d'),
        title: 'w-d: Which queue?',
        stages: ['intake'],
        metadata: { [BEADS_META.id]: 'w-d', [BEADS_META.repo]: SLUG, [FACTORY_REPOSITORY_META]: SLUG, [BEADS_META.type]: 'decision' },
      },
    });
    const integration = h.integration();
    await sweep(integration);
    const marked = card(h, 'w-d')!;
    expect(marked.metadata?.[BEADS_META.cardKind]).toBe(RESEARCH_CARD_KIND);

    await sweep(integration);
    await sweep(h.integration());
    expect(card(h, 'w-d')!.revision).toBe(marked.revision);
    expect(h.workItems.beadCards()).toHaveLength(1);
  });

  it('clears the research kind when the bead is no longer a decision', async () => {
    h = createHarness([{ id: 'w-d', title: 'Which queue?', issue_type: 'decision' }]);
    const integration = h.integration();
    await sweep(integration);
    expect(card(h, 'w-d')!.metadata?.[BEADS_META.cardKind]).toBe(RESEARCH_CARD_KIND);

    h.setState(s => {
      s.beads.find(b => b.id === 'w-d')!.issue_type = 'task';
    });
    await sweep(integration);
    const cleared = card(h, 'w-d')!;
    expect(cleared.metadata?.[BEADS_META.cardKind] ?? null).toBeNull();
    await sweep(integration);
    expect(card(h, 'w-d')!.revision).toBe(cleared.revision);
  });

  it('closes the decision bead when a person approves its card by moving it to Done', async () => {
    h = createHarness([{ id: 'w-d', title: 'Which queue?', issue_type: 'decision' }]);
    const integration = h.integration();
    await sweep(integration);
    h.workItems.move(card(h, 'w-d')!.id, 'done');
    const approved = await sweep(integration);
    expect(approved.repos[0]).toMatchObject({ state: 'ok', closed: 1 });
    expect(h.state().beads.find(b => b.id === 'w-d')!.status).toBe('closed');
    expect(card(h, 'w-d')!.metadata?.[BEADS_META.writeback]).toBe('synced');
  });
});

describe('overview cards close when the last child closes (samskara-l2t.2.2)', () => {
  const card = (harness: Harness, beadId: string) => harness.workItems.items.find(i => i.metadata?.[BEADS_META.id] === beadId)!;
  const epicAndTwo = () =>
    createHarness([
      { id: 'w-e', title: 'Epic', issue_type: 'epic' },
      { id: 'w-e.1', title: 'One', issue_type: 'task', parent: 'w-e' },
      { id: 'w-e.2', title: 'Two', issue_type: 'task', parent: 'w-e' },
    ]);
  /** A container card as it stands in Done, made outside intake (a legacy card, or one moved by hand). */
  const doneContainerCard = (harness: Harness, metadata: Record<string, unknown>) =>
    harness.workItems.upsert({
      orgId: ORG,
      userId: 'u',
      factoryProjectId: PROJECT,
      input: {
        board: 'work',
        externalSource: { integrationId: 'beads', type: 'issue', externalId: 'w-e' },
        claimKey: beadsClaimKey(SLUG, 'w-e'),
        title: 'w-e: Epic',
        stages: ['done'],
        metadata: { [BEADS_META.id]: 'w-e', [BEADS_META.repo]: SLUG, [FACTORY_REPOSITORY_META]: SLUG, ...metadata },
      },
    });

  it('commits the epic card to done once both children are done, and the next sweep closes and syncs the epic', async () => {
    h = epicAndTwo();
    const integration = h.integration();
    await sweep(integration);
    expect(h.workItems.evaluations).toHaveLength(0);

    h.workItems.move(card(h, 'w-e.1').id, 'done');
    h.workItems.move(card(h, 'w-e.2').id, 'done');
    const closing = await sweep(integration);
    expect(closing.repos[0]).toMatchObject({ state: 'ok', closed: 2 });
    const epic = card(h, 'w-e');
    expect(epic.metadata?.[BEADS_META.openChildren]).toBe(0);
    // Committed, not moved: Factory's dispatcher applies it.
    expect(epic.stages).toEqual(['intake']);
    expect(h.workItems.evaluations).toHaveLength(1);
    const [evaluation] = h.workItems.evaluations;
    const identity = `beads:overview-done:${epic.id}@${epic.revision}`;
    expect(evaluation!.input).toMatchObject({
      orgId: ORG,
      factoryProjectId: PROJECT,
      workItemId: epic.id,
      expectedRevision: epic.revision,
      ingress: { identity, triggerType: 'beads.overview-done' },
      actor: { type: 'system', id: 'integration:beads' },
      outcome: { status: 'accepted' },
    });
    expect(evaluation!.result).toMatchObject({
      status: 'accepted',
      decisions: [{ type: 'transition', board: 'work', stage: 'done', idempotencyKey: `${identity}:transition` }],
    });
    // The sweep that commits the move does not close the epic: write-back does, after the move.
    expect(commands(h)).not.toContain('close w-e');

    // A sweep before the dispatcher runs replays the same evaluation.
    await sweep(integration);
    expect(h.workItems.evaluations).toHaveLength(1);

    // The board policy (Done only with no open children) accepts the move.
    expect(await h.workItems.applyDecisions()).toEqual([{ workItemId: epic.id, stage: 'done', outcome: 'moved' }]);
    const closed = await sweep(integration);
    expect(closed.repos[0]).toMatchObject({ state: 'ok', closed: 1 });
    expect(commands(h).filter(c => c === 'close w-e')).toHaveLength(1);
    expect(h.state().beads.find(b => b.id === 'w-e')).toMatchObject({ status: 'closed', closeReason: `Factory card ${epic.id} reached done` });
    expect(card(h, 'w-e').metadata).toMatchObject({ [BEADS_META.writeback]: 'synced' });

    // Settled: nothing further is committed.
    await sweep(integration);
    expect(h.workItems.evaluations).toHaveLength(1);
  });

  it('cards an open epic whose children are all closed as an overview card and closes it on the first sweep (owner decision)', async () => {
    // Settled before Factory ever saw it: the epic is open, every child closed.
    h = createHarness([
      { id: 'w-e', title: 'Epic', issue_type: 'epic' },
      { id: 'w-e.1', title: 'One', issue_type: 'task', parent: 'w-e', status: 'closed' },
      { id: 'w-e.2', title: 'Two', issue_type: 'task', parent: 'w-e', status: 'closed' },
    ]);
    const integration = h.integration();
    await sweep(integration);
    // Carded once, as an overview card (not a planning card), with no open children.
    expect(ids(h)).toEqual(['w-e']);
    const epic = card(h, 'w-e');
    expect(epic.metadata).toMatchObject({ [BEADS_META.cardKind]: OVERVIEW_CARD_KIND, [BEADS_META.openChildren]: 0 });
    // The same first sweep commits its move to Done.
    expect(h.workItems.evaluations).toHaveLength(1);
    expect(h.workItems.evaluations[0]!.result).toMatchObject({
      status: 'accepted',
      decisions: [{ type: 'transition', board: 'work', stage: 'done' }],
    });

    expect(await h.workItems.applyDecisions()).toEqual([{ workItemId: epic.id, stage: 'done', outcome: 'moved' }]);
    const closed = await sweep(integration);
    expect(closed.repos[0]).toMatchObject({ state: 'ok', closed: 1 });
    expect(h.state().beads.find(b => b.id === 'w-e')).toMatchObject({ status: 'closed' });
    expect(card(h, 'w-e').metadata).toMatchObject({ [BEADS_META.writeback]: 'synced' });
  });

  it('keys each evaluation on the card revision, so a stale one is never replayed in place of a fresh one', async () => {
    h = epicAndTwo();
    const integration = h.integration();
    await sweep(integration);
    h.setState(s => s.beads.filter(b => b.parent === 'w-e').forEach(b => (b.status = 'closed')));
    await sweep(integration);
    const epicId = card(h, 'w-e').id;
    const atCommit = card(h, 'w-e').revision;
    const first = h.workItems.evaluations[0]!;
    expect(first.input.ingress.identity).toBe(`beads:overview-done:${epicId}@${atCommit}`);

    // The card changes before the dispatcher runs (here, a person edits it).
    await h.workItems.update({ orgId: ORG, id: epicId, userId: 'u', patch: { metadata: { note: 'edited' } } });
    // That evaluation, committed now, would be stored as stale, with no decision.
    const stale = await h.workItems.commitRuleEvaluation({ ...first.input, ingress: { ...first.input.ingress, identity: 'probe' } });
    expect(stale).toMatchObject({ status: 'committed', result: { status: 'rejected', code: 'stale', decisions: [] } });

    await sweep(integration);
    const ours = h.workItems.evaluations.filter(e => e.input.ingress.identity.startsWith('beads:overview-done:'));
    expect(ours.map(e => e.input.ingress.identity)).toEqual([
      `beads:overview-done:${epicId}@${atCommit}`,
      `beads:overview-done:${epicId}@${atCommit + 1}`,
    ]);
    expect(ours[1]!.result.status).toBe('accepted');
    // The dispatcher applies the first; the second finds the card already there.
    expect((await h.workItems.applyDecisions()).map(r => r.outcome)).toEqual(['moved', 'inert']);
  });

  it('commits nothing the board policy would refuse: a child still open, or a count that could not be read', async () => {
    h = epicAndTwo();
    const integration = h.integration();
    await sweep(integration);
    // One child closes; the other is open.
    h.workItems.move(card(h, 'w-e.1').id, 'done');
    await sweep(integration);
    expect(card(h, 'w-e').metadata?.[BEADS_META.openChildren]).toBe(1);
    expect(h.workItems.evaluations).toHaveLength(0);

    // The last child closes, but the children cannot be read: the card's count is stale, so no move.
    h.setState(s => {
      s.beads[2]!.status = 'closed';
      s.listParentFail = ['w-e'];
    });
    await sweep(integration);
    expect(card(h, 'w-e').metadata?.[BEADS_META.openChildren]).toBe(1);
    expect(h.workItems.evaluations).toHaveLength(0);

    h.setState(s => (s.listParentFail = []));
    await sweep(integration);
    expect(card(h, 'w-e').metadata?.[BEADS_META.openChildren]).toBe(0);
    expect(h.workItems.evaluations).toHaveLength(1);
  });

  it('leaves the card of an open container that has lost every child', async () => {
    h = createHarness([
      { id: 'w-e', title: 'Epic', issue_type: 'epic' },
      { id: 'w-e.1', title: 'One', issue_type: 'task', parent: 'w-e' },
    ]);
    const integration = h.integration();
    await sweep(integration);
    // The child is moved out from under the epic: the epic is childless, not finished.
    h.setState(s => delete s.beads[1]!.parent);
    await sweep(integration);
    expect(card(h, 'w-e').metadata?.[BEADS_META.openChildren]).toBe(0);
    expect(h.workItems.evaluations).toHaveLength(0);
    // Closed, it is finished.
    h.setState(s => (s.beads[0]!.status = 'closed'));
    await sweep(integration);
    expect(h.workItems.evaluations).toHaveLength(1);
  });

  it('keeps counting a container closed while a child is ready, and moves its card without closing it again', async () => {
    h = epicAndTwo();
    const integration = h.integration();
    await sweep(integration);
    expect(card(h, 'w-e').metadata?.[BEADS_META.openChildren]).toBe(2);

    // The epic is force-closed while w-e.2 is still ready, and w-e.1 closes.
    h.setState(s => {
      s.beads[0]!.status = 'closed';
      s.beads[1]!.status = 'closed';
    });
    await sweep(integration);
    // This count used to freeze at 2: intake skips a closed container, and step 3 skipped every container intake touched.
    expect(card(h, 'w-e').metadata?.[BEADS_META.openChildren]).toBe(1);
    expect(h.workItems.evaluations).toHaveLength(0);

    h.setState(s => (s.beads[2]!.status = 'closed'));
    await sweep(integration);
    expect(card(h, 'w-e').metadata?.[BEADS_META.openChildren]).toBe(0);
    expect(await h.workItems.applyDecisions()).toEqual([{ workItemId: card(h, 'w-e').id, stage: 'done', outcome: 'moved' }]);
    const synced = await sweep(integration);
    expect(synced.repos[0]).toMatchObject({ state: 'ok', closed: 1 });
    expect(commands(h)).not.toContain('close w-e');
    expect(card(h, 'w-e').metadata).toMatchObject({ [BEADS_META.writeback]: 'synced' });
  });

  it('marks a molecule card synced without a close call when bd auto-closes the root with its last step', async () => {
    h = createHarness([
      { id: 'w-mol', title: 'demo', issue_type: 'molecule' },
      { id: 'w-mol.1', title: 'First', issue_type: 'task', parent: 'w-mol' },
      { id: 'w-mol.2', title: 'Second', issue_type: 'task', parent: 'w-mol', blockedBy: ['w-mol.1'] },
    ]);
    const integration = h.integration();
    await sweep(integration);
    h.workItems.move(card(h, 'w-mol.1').id, 'done');
    await sweep(integration);
    h.workItems.move(card(h, 'w-mol.2').id, 'done');
    await sweep(integration);
    expect(h.state().beads[0]).toMatchObject({ status: 'closed', closeReason: 'all steps complete' });
    expect(await h.workItems.applyDecisions()).toEqual([{ workItemId: card(h, 'w-mol').id, stage: 'done', outcome: 'moved' }]);
    await sweep(integration);
    expect(commands(h)).not.toContain('close w-mol');
    expect(card(h, 'w-mol').metadata).toMatchObject({ [BEADS_META.writeback]: 'synced' });
  });

  it('re-arms a close-failed container card in Done once its children have closed, and leaves it in Done', async () => {
    h = epicAndTwo();
    const integration = h.integration({ maxCloseAttempts: 2 });
    let kicks = 0;
    const kick = integration.kick.bind(integration);
    integration.kick = () => {
      kicks++;
      kick();
    };
    // A legacy card: made before overview cards, it carries only the bead type.
    await doneContainerCard(h, { [BEADS_META.type]: 'epic' });
    // bd refuses the epic's close (here: while its children are open).
    h.setState(s => (s.closeFail = ['w-e']));
    await sweep(integration);
    await sweep(integration);
    await sweep(integration);
    expect(card(h, 'w-e').metadata).toMatchObject({ [BEADS_META.writeback]: 'close-failed', [BEADS_META.closeAttempts]: 2 });
    expect(card(h, 'w-e').metadata?.[BEADS_META.closeRearmedAt]).toBeUndefined();
    expect(kicks).toBe(0);

    // The children close; bd would now close the epic.
    h.setState(s => {
      s.beads[1]!.status = 'closed';
      s.beads[2]!.status = 'closed';
      s.closeFail = [];
    });
    await sweep(integration);
    expect(card(h, 'w-e').metadata).toMatchObject({ [BEADS_META.writeback]: null, [BEADS_META.closeAttempts]: 0 });
    expect(card(h, 'w-e').metadata?.[BEADS_META.closeRearmedAt]).toEqual(expect.any(String));
    expect(card(h, 'w-e').stages).toEqual(['done']);
    expect(kicks).toBe(1);
    const retried = await sweep(integration);
    expect(retried.repos[0]).toMatchObject({ state: 'ok', closed: 1 });
    expect(h.state().beads[0]!.status).toBe('closed');
    expect(card(h, 'w-e').metadata).toMatchObject({ [BEADS_META.writeback]: 'synced' });
    expect(h.workItems.evaluations).toHaveLength(0);
  });

  it('re-arms a container card only once: a close that fails again stays parked', async () => {
    h = createHarness([
      { id: 'w-e', title: 'Epic', issue_type: 'epic' },
      { id: 'w-e.1', title: 'One', issue_type: 'task', parent: 'w-e', status: 'closed' },
    ]);
    const integration = h.integration({ maxCloseAttempts: 1 });
    await doneContainerCard(h, { [BEADS_META.type]: 'epic', [BEADS_META.cardKind]: OVERVIEW_CARD_KIND });
    h.setState(s => (s.closeFail = ['w-e']));
    // Fails and is parked; the next sweep re-arms it, as its only child is closed.
    await sweep(integration);
    expect(card(h, 'w-e').metadata).toMatchObject({ [BEADS_META.writeback]: 'close-failed' });
    await sweep(integration);
    expect(card(h, 'w-e').metadata?.[BEADS_META.closeRearmedAt]).toEqual(expect.any(String));
    // Fails again and stays parked.
    await sweep(integration);
    await sweep(integration);
    expect(commands(h).filter(c => c === 'close w-e')).toHaveLength(2);
    expect(card(h, 'w-e').metadata).toMatchObject({ [BEADS_META.writeback]: 'close-failed' });
  });

  it('re-arms no work card and no container card with an open child', async () => {
    h = epicAndTwo();
    const integration = h.integration({ maxCloseAttempts: 1 });
    await doneContainerCard(h, { [BEADS_META.type]: 'epic' });
    h.setState(s => (s.closeFail = ['w-e']));
    await sweep(integration);
    h.workItems.move(card(h, 'w-e.1').id, 'done');
    h.setState(s => (s.closeFail = ['w-e', 'w-e.1']));
    await sweep(integration);
    await sweep(integration);
    for (const id of ['w-e', 'w-e.1']) {
      expect(card(h, id).metadata).toMatchObject({ [BEADS_META.writeback]: 'close-failed' });
      expect(card(h, id).metadata?.[BEADS_META.closeRearmedAt]).toBeUndefined();
    }
  });
});

describe('planning cards for childless epics (samskara-l2t.2.4)', () => {
  const card = (harness: Harness, beadId: string) => harness.workItems.items.find(i => i.metadata?.[BEADS_META.id] === beadId)!;
  const binding = (workItemId: string, status: 'active' | 'revoked' = 'active') => ({
    id: `binding_${workItemId}_${status}`,
    orgId: ORG,
    factoryProjectId: PROJECT,
    workItemId,
    role: 'work',
    threadId: 't',
    resourceId: 'r',
    sessionId: 's',
    branch: 'b',
    status,
    createdAt: new Date(),
    revokedAt: status === 'revoked' ? new Date() : null,
  });

  it('cards a childless open epic as a planning card, under its parent overview card, and keeps it stable across sweeps', async () => {
    h = createHarness([
      { id: 'w-m', title: 'Milestone', issue_type: 'milestone' },
      { id: 'w-e', title: 'Empty epic', issue_type: 'epic', parent: 'w-m', description: 'Ship the thing.' },
      { id: 'w-f', title: 'Full epic', issue_type: 'epic' },
      { id: 'w-f.1', title: 'Child', issue_type: 'task', parent: 'w-f' },
      { id: 'w-c', title: 'Closed epic', issue_type: 'epic', status: 'closed' },
    ]);
    const integration = h.integration();
    const summary = await sweep(integration);

    expect(summary.repos[0]).toMatchObject({ state: 'ok', created: 4 });
    expect(card(h, 'w-e').metadata).toMatchObject({ [BEADS_META.cardKind]: PLAN_CARD_KIND, [BEADS_META.type]: 'epic' });
    expect(card(h, 'w-e').metadata?.[BEADS_META.openChildren]).toBeUndefined();
    // A planning card is a child like any other: the milestone is an overview card above it.
    expect(card(h, 'w-m').metadata?.[BEADS_META.cardKind]).toBe(OVERVIEW_CARD_KIND);
    expect(card(h, 'w-e').parentWorkItemId).toBe(card(h, 'w-m').id);
    // An epic with children stays an overview card.
    expect(card(h, 'w-f').metadata).toMatchObject({ [BEADS_META.cardKind]: OVERVIEW_CARD_KIND, [BEADS_META.openChildren]: 1 });
    expect(card(h, 'w-c')).toBeUndefined();
    expect(h.feed.on(card(h, 'w-e').id).map(c => c.body)).toEqual(['Ship the thing.']);

    const revisions = h.workItems.beadCards().map(c => [c.id, c.revision]);
    await sweep(integration);
    await sweep(h.integration());
    expect(h.workItems.beadCards().map(c => [c.id, c.revision])).toEqual(revisions);
    expect(h.workItems.evaluations).toHaveLength(0);
  });

  it('turns the planning card into an overview card once children appear, links them, and writes once', async () => {
    h = createHarness([{ id: 'w-e', title: 'Epic', issue_type: 'epic' }]);
    const integration = h.integration();
    await sweep(integration);
    expect(card(h, 'w-e').metadata?.[BEADS_META.cardKind]).toBe(PLAN_CARD_KIND);

    // The file run created two children, the second blocked by the first.
    h.setState(s => {
      s.beads.push({ id: 'w-e.1', title: 'One', issue_type: 'task', parent: 'w-e' });
      s.beads.push({ id: 'w-e.2', title: 'Two', issue_type: 'task', parent: 'w-e', blockedBy: ['w-e.1'] });
    });
    const flipped = await sweep(integration);
    expect(flipped.repos[0]).toMatchObject({ state: 'ok', created: 1 });
    expect(card(h, 'w-e').metadata).toMatchObject({ [BEADS_META.cardKind]: OVERVIEW_CARD_KIND, [BEADS_META.openChildren]: 2 });
    expect(card(h, 'w-e.1').parentWorkItemId).toBe(card(h, 'w-e').id);
    expect(card(h, 'w-e.2')).toBeUndefined();

    const revision = card(h, 'w-e').revision;
    await sweep(integration);
    expect(card(h, 'w-e').revision).toBe(revision);
    // An epic that later loses its children is not turned back into a planning card.
    h.setState(s => s.beads.filter(b => b.parent === 'w-e').forEach(b => delete b.parent));
    await sweep(integration);
    expect(card(h, 'w-e').metadata?.[BEADS_META.cardKind]).toBe(OVERVIEW_CARD_KIND);
  });

  it('turns a planning card whose epic is not ready into an overview card too', async () => {
    h = createHarness([
      { id: 'w-e', title: 'Epic', issue_type: 'epic' },
      { id: 'w-x', title: 'Blocker', issue_type: 'task', status: 'in_progress' },
    ]);
    const integration = h.integration();
    await sweep(integration);
    expect(card(h, 'w-e').metadata?.[BEADS_META.cardKind]).toBe(PLAN_CARD_KIND);
    // The epic is blocked now, and its only child is claimed: neither is ready.
    h.setState(s => {
      s.beads[0]!.blockedBy = ['w-x'];
      s.beads.push({ id: 'w-e.1', title: 'One', issue_type: 'task', parent: 'w-e', status: 'in_progress' });
    });
    await sweep(integration);
    expect(card(h, 'w-e').metadata).toMatchObject({ [BEADS_META.cardKind]: OVERVIEW_CARD_KIND, [BEADS_META.openChildren]: 1 });
  });

  it('never makes a planning card from a failed children read, and leaves an existing one alone', async () => {
    h = createHarness([{ id: 'w-e', title: 'Epic', issue_type: 'epic' }]);
    h.setState(s => (s.listParentFail = ['w-e']));
    const integration = h.integration();
    const failed = await sweep(integration);
    expect(failed.repos[0]).toMatchObject({ state: 'ok', created: 0 });
    expect(h.workItems.beadCards()).toHaveLength(0);

    h.setState(s => (s.listParentFail = []));
    await sweep(integration);
    const planned = card(h, 'w-e');
    expect(planned.metadata?.[BEADS_META.cardKind]).toBe(PLAN_CARD_KIND);
    h.setState(s => (s.listParentFail = ['w-e']));
    await sweep(integration);
    expect(card(h, 'w-e').revision).toBe(planned.revision);
    expect(card(h, 'w-e').metadata?.[BEADS_META.cardKind]).toBe(PLAN_CARD_KIND);
  });

  it('marks an epic card made before planning cards existed, and clears the kind when the bead is no longer an epic', async () => {
    h = createHarness([{ id: 'w-e', title: 'Epic', issue_type: 'epic' }]);
    await h.workItems.upsert({
      orgId: ORG,
      userId: 'u',
      factoryProjectId: PROJECT,
      input: {
        board: 'work',
        externalSource: { integrationId: 'beads', type: 'issue', externalId: 'w-e' },
        claimKey: beadsClaimKey(SLUG, 'w-e'),
        title: 'w-e: Epic',
        stages: ['intake'],
        metadata: { [BEADS_META.id]: 'w-e', [BEADS_META.repo]: SLUG, [FACTORY_REPOSITORY_META]: SLUG, [BEADS_META.type]: 'epic' },
      },
    });
    const integration = h.integration();
    await sweep(integration);
    expect(card(h, 'w-e').metadata?.[BEADS_META.cardKind]).toBe(PLAN_CARD_KIND);
    expect(h.workItems.beadCards()).toHaveLength(1);

    h.setState(s => (s.beads[0]!.issue_type = 'task'));
    await sweep(integration);
    expect(card(h, 'w-e').metadata?.[BEADS_META.cardKind] ?? null).toBeNull();
  });

  it('moves an overview card stranded in a working phase with no active binding to Intake, through the board policy', async () => {
    h = createHarness([
      { id: 'w-e', title: 'Epic', issue_type: 'epic' },
      { id: 'w-e.1', title: 'One', issue_type: 'task', parent: 'w-e' },
    ]);
    const integration = h.integration();
    await sweep(integration);
    const epic = card(h, 'w-e');
    // A planning card in Building whose children the file run just created.
    h.workItems.move(epic.id, 'execute');
    h.workItems.runBindings.push(binding(epic.id));
    await sweep(integration);
    // Its run is still bound: nothing moves it.
    expect(h.workItems.evaluations).toHaveLength(0);

    h.workItems.runBindings = [binding(epic.id, 'revoked')];
    await sweep(integration);
    const stranded = card(h, 'w-e');
    expect(h.workItems.evaluations).toHaveLength(1);
    const identity = `beads:overview-intake:${stranded.id}@${stranded.revision}`;
    expect(h.workItems.evaluations[0]!.input).toMatchObject({
      workItemId: stranded.id,
      ingress: { identity, triggerType: 'beads.overview-intake' },
      actor: { type: 'system', id: 'integration:beads' },
    });
    expect(h.workItems.evaluations[0]!.result.decisions).toEqual([
      expect.objectContaining({ type: 'transition', board: 'work', stage: 'intake', idempotencyKey: `${identity}:transition` }),
    ]);
    // A repeat before the dispatcher runs is a replay.
    await sweep(integration);
    expect(h.workItems.evaluations).toHaveLength(1);
    // The board policy allows it: Intake is not a working phase.
    expect(await h.workItems.applyDecisions()).toEqual([{ workItemId: stranded.id, stage: 'intake', outcome: 'moved' }]);
    await sweep(integration);
    expect(h.workItems.evaluations).toHaveLength(1);
  });

  it('moves no card that is resting, terminal, not an overview card, or about to move to Done', async () => {
    h = createHarness([
      { id: 'w-e', title: 'Epic', issue_type: 'epic' },
      { id: 'w-e.1', title: 'One', issue_type: 'task', parent: 'w-e' },
      { id: 'w-p', title: 'Plan me', issue_type: 'epic' },
      { id: 'w-s', title: 'Settled', issue_type: 'epic' },
      { id: 'w-s.1', title: 'Done child', issue_type: 'task', parent: 'w-s' },
    ]);
    const integration = h.integration();
    await sweep(integration);
    // A planning card in Building is not stranded: it is the file run's card.
    h.workItems.move(card(h, 'w-p').id, 'execute');
    // A work card in Building is Work's business.
    h.workItems.move(card(h, 'w-e.1').id, 'execute');
    // The settled epic's last child closes while its card sits in Planning: it goes to Done, once.
    h.workItems.move(card(h, 'w-s').id, 'planning');
    h.setState(s => {
      s.beads.find(b => b.id === 'w-s.1')!.status = 'closed';
      s.beads.find(b => b.id === 'w-s')!.status = 'closed';
    });
    await sweep(integration);
    expect(h.workItems.evaluations.map(e => [e.input.workItemId, e.input.ingress.triggerType])).toEqual([[card(h, 'w-s').id, 'beads.overview-done']]);
  });
});

describe('legacy container cards, subtasks and the dispatcher (samskara-l2t.2.5)', () => {
  const card = (harness: Harness, beadId: string) => harness.workItems.items.find(i => i.metadata?.[BEADS_META.id] === beadId)!;
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

  it('orders ready beads so a parent comes before its children, and survives a parent cycle', () => {
    const order = parentsFirst([
      { id: 'c', parent: 'b' },
      { id: 'd' },
      { id: 'b', parent: 'a' },
      { id: 'a', parent: 'x' },
    ]).map(b => b.id);
    expect(order).toEqual(['a', 'b', 'c', 'd']);
    expect(parentsFirst([{ id: 'x', parent: 'y' }, { id: 'y', parent: 'x' }]).map(b => b.id)).toEqual(['y', 'x']);
  });

  it("links a subtask's card under its parent task's card, in the same sweep, and leaves the parent a work card", async () => {
    // bd lists the subtask first here; intake cards the parent first anyway.
    h = createHarness([
      { id: 'w-t.1', title: 'Subtask', issue_type: 'task', parent: 'w-t' },
      { id: 'w-t', title: 'Task', issue_type: 'task' },
    ]);
    const integration = h.integration();
    const first = await sweep(integration);
    expect(first.repos[0]).toMatchObject({ state: 'ok', created: 2 });
    expect(ids(h)).toEqual(['w-t', 'w-t.1']);
    expect(card(h, 'w-t.1').parentWorkItemId).toBe(card(h, 'w-t').id);
    // Not an overview card: no kind, no count, and it still runs like any work card.
    expect(card(h, 'w-t').metadata?.[BEADS_META.cardKind]).toBeUndefined();
    expect(card(h, 'w-t').metadata?.[BEADS_META.openChildren]).toBeUndefined();
    expect(h.workItems.evaluations).toHaveLength(0);

    const revisions = h.workItems.beadCards().map(c => [c.id, c.revision, c.parentWorkItemId]);
    await sweep(integration);
    expect(h.workItems.beadCards().map(c => [c.id, c.revision, c.parentWorkItemId])).toEqual(revisions);
  });

  it('links a subtask carded before its parent had a card once the parent is carded, and makes no card for the parent itself', async () => {
    h = createHarness([
      { id: 'w-t', title: 'Task', issue_type: 'task', status: 'in_progress' },
      { id: 'w-t.1', title: 'Subtask', issue_type: 'task', parent: 'w-t' },
    ]);
    const integration = h.integration();
    await sweep(integration);
    // The parent is claimed, so not ready: it gets no card, and the subtask is carded unlinked.
    expect(ids(h)).toEqual(['w-t.1']);
    expect(card(h, 'w-t.1').parentWorkItemId).toBeNull();

    h.setState(s => (s.beads[0]!.status = 'open'));
    await sweep(integration);
    expect(card(h, 'w-t.1').parentWorkItemId).toBe(card(h, 'w-t').id);
    expect(card(h, 'w-t').metadata?.[BEADS_META.cardKind]).toBeUndefined();
  });

  it('re-arms a task card parked close-failed because a subtask was open, once the subtask closes', async () => {
    h = createHarness([
      { id: 'w-t', title: 'Task', issue_type: 'task' },
      { id: 'w-t.1', title: 'Subtask', issue_type: 'task', parent: 'w-t' },
    ]);
    const integration = h.integration({ maxCloseAttempts: 1 });
    await sweep(integration);
    // A person moves the task to Done first: bd refuses to close it while its subtask is open.
    h.workItems.move(card(h, 'w-t').id, 'done');
    await sweep(integration);
    expect(card(h, 'w-t').metadata).toMatchObject({ [BEADS_META.writeback]: 'close-failed' });
    expect(String(card(h, 'w-t').metadata?.[BEADS_META.diagnostic])).toContain('open child');

    h.workItems.move(card(h, 'w-t.1').id, 'done');
    await sweep(integration);
    expect(card(h, 'w-t').metadata?.[BEADS_META.closeRearmedAt]).toEqual(expect.any(String));
    const closed = await sweep(integration);
    expect(closed.repos[0]).toMatchObject({ state: 'ok', closed: 1 });
    expect(h.state().beads.find(b => b.id === 'w-t')!.status).toBe('closed');
    expect(card(h, 'w-t').metadata).toMatchObject({ [BEADS_META.writeback]: 'synced' });
  });

  it("holds a stranded overview card only for the phase's own seat: a person's chat session does not hold it", async () => {
    h = createHarness([
      { id: 'w-e', title: 'Epic', issue_type: 'epic' },
      { id: 'w-e.1', title: 'One', issue_type: 'task', parent: 'w-e' },
    ]);
    const integration = h.integration();
    await sweep(integration);
    const epic = card(h, 'w-e');
    // A card made before overview cards existed, in Building with its build run's seat bound.
    h.workItems.move(epic.id, 'execute');
    h.workItems.runBindings.push(binding(epic.id, 'work'));
    await sweep(integration);
    expect(h.workItems.evaluations).toHaveLength(0);

    // Only a "Start session" chat is bound (rules/start-coordinator.js: role chat, no phase run).
    h.workItems.runBindings = [binding(epic.id, 'chat')];
    await sweep(integration);
    expect(h.workItems.evaluations.map(e => e.input.ingress.triggerType)).toEqual(['beads.overview-intake']);
    expect(await h.workItems.applyDecisions()).toEqual([{ workItemId: epic.id, stage: 'intake', outcome: 'moved' }]);
  });

  it('replays a refused move on every dispatcher retry, whatever changed since, and fails it after five attempts', async () => {
    h = createHarness([
      { id: 'w-e', title: 'Epic', issue_type: 'epic' },
      { id: 'w-e.1', title: 'One', issue_type: 'task', parent: 'w-e' },
    ]);
    const integration = h.integration();
    await sweep(integration);
    const epic = card(h, 'w-e');
    // Any rule's move of an overview card into a working phase, through the wrapped Work policy.
    await h.workItems.commitRuleEvaluation({
      orgId: ORG,
      factoryProjectId: PROJECT,
      workItemId: epic.id,
      ingress: { identity: 'probe', triggerType: 'test' },
      configVersion: 'test',
      expectedRevision: epic.revision,
      actor: { type: 'system', id: 'test' },
      outcome: { status: 'accepted' },
      decisions: [{ type: 'transition', idempotencyKey: 'probe:transition', board: 'work', stage: 'execute' }],
      causalChain: [],
      now: new Date(),
    } as never);
    expect(await h.workItems.applyDecisions()).toEqual([
      {
        workItemId: epic.id,
        stage: 'execute',
        outcome: 'rejected',
        code: 'forbidden',
        reason: OVERVIEW_WORKING_REASON,
        attempt: 1,
        replayed: false,
        failed: false,
      },
    ]);
    // The card stops being an overview card; the retry still gets the stored refusal.
    await h.workItems.update({ orgId: ORG, id: epic.id, userId: 'u', patch: { metadata: { [BEADS_META.cardKind]: null } } });
    for (let attempt = 2; attempt <= MAX_DISPATCH_ATTEMPTS; attempt++) {
      expect(await h.workItems.applyDecisions()).toEqual([
        expect.objectContaining({ outcome: 'rejected', attempt, replayed: true, failed: attempt === MAX_DISPATCH_ATTEMPTS }),
      ]);
    }
    expect(await h.workItems.applyDecisions()).toEqual([]);
    expect(card(h, 'w-e').stages).toEqual(['intake']);
  });

  it("wakes the beads worker through the Done phase's handler when the dispatcher moves an overview card there", async () => {
    h = createHarness([
      { id: 'w-e', title: 'Epic', issue_type: 'epic' },
      { id: 'w-e.1', title: 'One', issue_type: 'task', parent: 'w-e', status: 'closed' },
    ]);
    const integration = h.integration();
    let kicks = 0;
    const kick = integration.kick.bind(integration);
    integration.kick = () => {
      kicks++;
      kick();
    };
    await sweep(integration);
    expect(kicks).toBe(0);
    expect(await h.workItems.applyDecisions()).toEqual([{ workItemId: card(h, 'w-e').id, stage: 'done', outcome: 'moved' }]);
    expect(kicks).toBe(1);
  });
});
