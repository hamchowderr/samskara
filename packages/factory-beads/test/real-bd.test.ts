/**
 * The integration against a REAL `bd` and git, end to end, with no network: a
 * bare git repository in a temp directory is the origin, and Dolt reaches it
 * through a `git+file://` remote exactly as it reaches GitHub through
 * `git+https://`.
 *
 * LOCAL-ONLY: skipped when `bd` is not on PATH, which includes CI (the check
 * workflow installs no bd). Run it where bd is installed; set
 * FACTORY_BEADS_REAL_BD=0 to skip it there too.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BdRepo, BdRunner, BEADS_META, createBeadsTransitionPolicy } from '../src/index';
import { createHarness, sweep } from './harness';
import type { Harness } from './harness';

/** A two-step workflow; the second step needs the first. */
const DEMO_FORMULA = `formula = "demo"
description = "Demo workflow"
version = 1
type = "workflow"

[vars.name]
description = "name"
required = true

[[steps]]
id = "first"
title = "First: {{name}}"
description = "do first"

[[steps]]
id = "second"
title = "Second: {{name}}"
description = "do second"
needs = ["first"]
`;

const bdAvailable = process.env.FACTORY_BEADS_REAL_BD !== '0' && spawnSync('bd', ['--version']).status === 0;

describe.skipIf(!bdAvailable)('real bd (local-only)', () => {
  // Short root: Dolt's git cache nests deep, and git refuses an over-long
  // $GIT_DIR on Windows even with core.longpaths.
  const root = mkdtempSync(join(tmpdir(), 'fbr-'));
  const bare = join(root, 'o.git');
  const seed = join(root, 's');
  const originUrl = pathToFileURL(bare).href;
  const env = {
    ...process.env,
    BD_NON_INTERACTIVE: '1',
    DOLT_REMOTE_INFO_BRANCH: '',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.longpaths',
    GIT_CONFIG_VALUE_0: 'true',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  const run = (cmd: string, args: string[], cwd = seed) => execFileSync(cmd, args, { cwd, env, encoding: 'utf8' }).trim();
  const ids = { alpha: '', beta: '', epic: '' };
  let h: Harness;

  beforeAll(() => {
    run('git', ['init', '-q', '--bare', '-b', 'trunk', bare], root);
    run('git', ['clone', '-q', originUrl, seed], root);
    run('git', ['commit', '-q', '--allow-empty', '-m', 'chore: init fixture']);
    run('git', ['push', '-q', 'origin', 'trunk']);
    run('bd', ['init', '-p', 'fx', '--skip-agents', '-q']);
    run('bd', ['dolt', 'remote', 'add', 'origin', `git+${originUrl}`]);
    run('bd', ['config', 'set', 'sync.remote', `git+${originUrl}`]);
    ids.alpha = run('bd', ['create', 'Alpha', '-t', 'task', '--silent']).split(/\r?\n/)[0]!;
    ids.beta = run('bd', ['create', 'Beta', '-t', 'task', '--silent']).split(/\r?\n/)[0]!;
    ids.epic = run('bd', ['create', 'Epic', '-t', 'epic', '--silent']).split(/\r?\n/)[0]!;
    // Containers and pinned beads must never become cards (samskara-l2t.1).
    run('bd', ['create', 'Milestone', '-t', 'milestone', '--silent']);
    const pinned = run('bd', ['create', 'Pinned', '-t', 'task', '--silent']).split(/\r?\n/)[0]!;
    run('bd', ['update', pinned, '--status', 'pinned']);
    run('bd', ['dep', 'add', ids.beta, ids.alpha]);
    // Held by someone else: bd refuses a close by any other actor (samskara-l2t.13).
    run('bd', ['update', ids.alpha, '--assignee', 'someone']);
    run('bd', ['dolt', 'push']);
    run('git', ['add', '-A']);
    spawnSync('git', ['commit', '-q', '-m', 'chore: beads config'], { cwd: seed, env });
    run('git', ['push', '-q', 'origin', 'trunk']);

    h = createHarness([]);
  }, 180_000);

  afterAll(() => {
    h?.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it('bootstraps, cards ready beads, closes on done and publishes to refs/dolt/data', async () => {
    const integration = h.integration({
      sourceControl: {
        id: 'github',
        versionControl: { getRepositoryAccess: async () => ({ cloneUrl: originUrl }) } as never,
      },
      cacheDir: join(root, 'c'),
      runner: new BdRunner(),
    });

    const first = await sweep(integration);
    expect(first.repos[0], JSON.stringify(first)).toMatchObject({ state: 'ok', created: 1 });
    const cards = () => h.workItems.beadCards().map(c => c.metadata?.[BEADS_META.id]);
    expect(cards()).toEqual([ids.alpha]);

    h.workItems.move(h.workItems.beadCards()[0]!.id, 'done');
    const second = await sweep(integration);
    expect(second.repos[0], JSON.stringify(second)).toMatchObject({ state: 'ok', closed: 1, created: 1 });
    expect(cards()).toEqual([ids.alpha, ids.beta]);

    // The close is on the remote: a different copy sees it after a pull.
    run('bd', ['dolt', 'pull']);
    const shown = JSON.parse(run('bd', ['--readonly', 'show', ids.alpha, '--json'])) as Array<{ status: string }>;
    expect(shown[0]?.status).toBe('closed');
    // No remote-info branch was created on the origin.
    expect(run('git', ['ls-remote', originUrl])).not.toMatch(/remote-info/);
  }, 300_000);

  it('cards containers with children as overview cards and links their children, molecules included (samskara-l2t.2.1)', async () => {
    // Added after the first sweep, as new work lands in a live repository.
    const make = (title: string, type: string, parent?: string) =>
      run('bd', ['create', title, '-t', type, '--silent', ...(parent ? ['--parent', parent] : [])]).split(/\r?\n/)[0]!;
    const epic = make('Overview epic', 'epic');
    const one = make('Child one', 'task', epic);
    const two = make('Child two', 'task', epic);
    const nested = make('Nested epic', 'epic', epic);
    const grand = make('Grandchild', 'task', nested);
    mkdirSync(join(seed, '.beads', 'formulas'), { recursive: true });
    writeFileSync(join(seed, '.beads', 'formulas', 'demo.formula.toml'), DEMO_FORMULA);
    const poured = JSON.parse(run('bd', ['mol', 'pour', 'demo', '--var', 'name=x', '--json'])) as {
      new_epic_id: string;
      id_mapping: Record<string, string>;
    };
    const mol = poured.new_epic_id;
    const first = poured.id_mapping['demo.first']!;
    const second = poured.id_mapping['demo.second']!;
    run('bd', ['dolt', 'push']);

    const integration = h.integration({
      sourceControl: {
        id: 'github',
        versionControl: { getRepositoryAccess: async () => ({ cloneUrl: originUrl }) } as never,
      },
      cacheDir: join(root, 'c'),
      runner: new BdRunner(),
    });
    const summary = await sweep(integration);
    expect(summary.repos[0], JSON.stringify(summary)).toMatchObject({ state: 'ok' });

    const card = (id: string) => h.workItems.beadCards().find(c => c.metadata?.[BEADS_META.id] === id);
    const order = h.workItems.beadCards().map(c => c.metadata?.[BEADS_META.id] as string);
    // The parent card is always made before its children's.
    for (const [parent, child] of [[epic, one], [epic, two], [epic, nested], [nested, grand], [mol, first]] as const) {
      expect(order.indexOf(parent), `${parent} before ${child}: ${order.join(', ')}`).toBeLessThan(order.indexOf(child));
      expect(card(child)?.parentWorkItemId, `${child} under ${parent}`).toBe(card(parent)!.id);
    }
    expect(card(epic)!.metadata).toMatchObject({ beadsCardKind: 'overview', beadsOpenChildren: 3, beadsType: 'epic' });
    expect(card(nested)!.metadata).toMatchObject({ beadsCardKind: 'overview', beadsOpenChildren: 1 });
    // A poured root is a molecule, which bd ready never lists; its steps carry parent-child edges to it.
    expect(card(mol)!.metadata).toMatchObject({ beadsCardKind: 'overview', beadsOpenChildren: 2, beadsType: 'molecule' });
    expect(h.feed.on(card(mol)!.id).map(c => c.body)).toEqual(['Demo workflow']);
    // The second step needs the first, so it is not ready yet.
    expect(card(second)).toBeUndefined();
    expect(card(grand)?.metadata?.beadsCardKind).toBeUndefined();

    // Idempotent: a further sweep changes no card.
    const revisions = h.workItems.beadCards().map(c => [c.id, c.revision, c.parentWorkItemId]);
    await sweep(integration);
    expect(h.workItems.beadCards().map(c => [c.id, c.revision, c.parentWorkItemId])).toEqual(revisions);
  }, 300_000);

  it('moves an overview card to Done when its last child closes: the epic closed by factory-beads, a molecule root by bd (samskara-l2t.2.2)', async () => {
    const make = (title: string, type: string, parent?: string) =>
      run('bd', ['create', title, '-t', type, '--silent', ...(parent ? ['--parent', parent] : [])]).split(/\r?\n/)[0]!;
    const epic = make('Closing epic', 'epic');
    const one = make('Closing one', 'task', epic);
    const two = make('Closing two', 'task', epic);
    mkdirSync(join(seed, '.beads', 'formulas'), { recursive: true });
    writeFileSync(join(seed, '.beads', 'formulas', 'demo.formula.toml'), DEMO_FORMULA);
    const poured = JSON.parse(run('bd', ['mol', 'pour', 'demo', '--var', 'name=closing', '--json'])) as {
      new_epic_id: string;
      id_mapping: Record<string, string>;
    };
    const mol = poured.new_epic_id;
    const first = poured.id_mapping['demo.first']!;
    const second = poured.id_mapping['demo.second']!;
    run('bd', ['dolt', 'push']);

    // Every bd call the integration makes, to show which beads it closed itself.
    const calls: string[][] = [];
    class RecordingRunner extends BdRunner {
      override bd(args: readonly string[], options: Parameters<BdRunner['bd']>[1]) {
        calls.push([...args]);
        return super.bd(args, options);
      }
    }
    const integration = h.integration({
      sourceControl: {
        id: 'github',
        versionControl: { getRepositoryAccess: async () => ({ cloneUrl: originUrl }) } as never,
      },
      cacheDir: join(root, 'c'),
      runner: new RecordingRunner(),
    });
    const card = (id: string) => h.workItems.beadCards().find(c => c.metadata?.[BEADS_META.id] === id)!;
    const closedBy = (id: string) => calls.filter(c => c.includes('close') && c.includes(id));
    const policy = createBeadsTransitionPolicy(undefined);
    const show = (id: string) =>
      (JSON.parse(run('bd', ['--readonly', 'show', id, '--json'])) as Array<{ status: string; close_reason?: string }>)[0]!;

    await sweep(integration);
    h.workItems.move(card(one).id, 'done');
    h.workItems.move(card(two).id, 'done');
    h.workItems.move(card(first).id, 'done');
    const children = await sweep(integration);
    expect(children.repos[0], JSON.stringify(children)).toMatchObject({ state: 'ok', closed: 3 });
    expect(card(epic).metadata?.[BEADS_META.openChildren]).toBe(0);
    expect(card(mol).metadata?.[BEADS_META.openChildren]).toBe(1);
    // The second step became ready when the first closed.
    h.workItems.move(card(second).id, 'done');
    const steps = await sweep(integration);
    expect(steps.repos[0], JSON.stringify(steps)).toMatchObject({ state: 'ok', closed: 1 });
    expect(card(mol).metadata?.[BEADS_META.openChildren]).toBe(0);

    // Both moves were committed, and the board policy accepts each.
    const moved = await h.workItems.applyDecisions(policy);
    expect(moved).toEqual(
      expect.arrayContaining([
        { workItemId: card(epic).id, stage: 'done', outcome: 'moved' },
        { workItemId: card(mol).id, stage: 'done', outcome: 'moved' },
      ]),
    );
    expect(closedBy(epic)).toHaveLength(0);
    const settled = await sweep(integration);
    expect(settled.repos[0], JSON.stringify(settled)).toMatchObject({ state: 'ok', closed: 2 });
    for (const id of [epic, mol]) expect(card(id).metadata?.[BEADS_META.writeback], id).toBe('synced');
    // The epic was closed by the integration, as its actor; the molecule root by bd, with its last step.
    expect(closedBy(epic)).toEqual([expect.arrayContaining(['--actor', 'factory-beads', 'close', epic])]);
    expect(closedBy(mol)).toHaveLength(0);

    // Both closes are on the remote.
    run('bd', ['dolt', 'pull']);
    expect(show(epic)).toMatchObject({ status: 'closed', close_reason: `Factory card ${card(epic).id} reached done` });
    expect(show(mol)).toMatchObject({ status: 'closed', close_reason: 'all steps complete' });
  }, 300_000);

  it('cards an open decision as a research card and never a closed one; approving it closes the bead (samskara-l2t.2.3)', async () => {
    // An open question as an agent files one: beads_create validates, and bd
    // accepts the three required sections empty.
    const open = run('bd', [
      'create', 'Which queue', '-t', 'decision', '--validate', '--silent',
      '-d', 'Which queue should jobs use?\n\n## Decision\n\n## Rationale\n\n## Alternatives Considered\n',
    ]).split(/\r?\n/)[0]!;
    const settled = run('bd', ['create', 'Settled', '-t', 'decision', '--silent']).split(/\r?\n/)[0]!;
    run('bd', ['close', settled, '--reason', 'decided']);
    run('bd', ['dolt', 'push']);

    const integration = h.integration({
      sourceControl: {
        id: 'github',
        versionControl: { getRepositoryAccess: async () => ({ cloneUrl: originUrl }) } as never,
      },
      cacheDir: join(root, 'c'),
      runner: new BdRunner(),
    });
    const card = (id: string) => h.workItems.beadCards().find(c => c.metadata?.[BEADS_META.id] === id);
    const first = await sweep(integration);
    expect(first.repos[0], JSON.stringify(first)).toMatchObject({ state: 'ok' });
    expect(card(open)?.metadata).toMatchObject({ beadsCardKind: 'research', beadsType: 'decision' });
    expect(h.feed.on(card(open)!.id).map(c => c.body)[0]).toContain('Which queue should jobs use?');
    // bd ready never lists a closed bead, so a settled decision is a record, not a card.
    expect(card(settled)).toBeUndefined();

    h.workItems.move(card(open)!.id, 'done');
    const approved = await sweep(integration);
    expect(approved.repos[0], JSON.stringify(approved)).toMatchObject({ state: 'ok', closed: 1 });
    expect(card(open)!.metadata?.[BEADS_META.writeback]).toBe('synced');
    run('bd', ['dolt', 'pull']);
    const shown = JSON.parse(run('bd', ['--readonly', 'show', open, '--json'])) as Array<{ status: string }>;
    expect(shown[0]?.status).toBe('closed');
    expect(card(settled)).toBeUndefined();
  }, 300_000);

  it('BdRepo.close: takes over a live claim, never forces, and returns a bead bd refuses to close', async () => {
    const dir = join(root, 'l');
    run('git', ['init', '-q', dir], root);
    run('bd', ['init', '-p', 'cl', '--skip-agents', '-q'], dir);
    const make = (title: string) => run('bd', ['create', title, '-t', 'task', '--silent'], dir).split(/\r?\n/)[0]!;
    const show = (id: string) =>
      (JSON.parse(run('bd', ['--readonly', 'show', id, '--json'], dir)) as Array<{ status: string; assignee?: string }>)[0]!;
    const repo = new BdRepo('local/claims', dir, '', new BdRunner());

    // A live claim: bd refuses a plain reassign of it without --force.
    const claimed = make('Claimed');
    run('bd', ['--actor', 'alice', 'update', claimed, '--claim'], dir);
    expect(show(claimed)).toMatchObject({ status: 'in_progress', assignee: 'alice' });
    const done = await repo.close(claimed, 'card reached done', 'alice');
    expect(done.code, done.stderr).toBe(0);
    expect(show(claimed)).toMatchObject({ status: 'closed', assignee: 'factory-beads' });

    // Pinned: the handover succeeds, bd refuses the close, the bead goes back.
    const pinned = make('Pinned');
    run('bd', ['update', pinned, '--assignee', 'alice', '--status', 'pinned'], dir);
    const refused = await repo.close(pinned, 'card reached done', 'alice');
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('pinned');
    expect(refused.stderr).toContain('returned to "alice"');
    expect(show(pinned)).toMatchObject({ status: 'pinned', assignee: 'alice' });

    // Blocked by an open bead: same.
    const blocker = make('Blocker');
    const blocked = make('Blocked');
    run('bd', ['dep', 'add', blocked, blocker], dir);
    run('bd', ['update', blocked, '--assignee', 'alice'], dir);
    const blockedRes = await repo.close(blocked, 'card reached done', 'alice');
    expect(blockedRes.code).not.toBe(0);
    expect(blockedRes.stderr).toContain('returned to "alice"');
    expect(show(blocked)).toMatchObject({ status: 'open', assignee: 'alice' });
  }, 300_000);
});
