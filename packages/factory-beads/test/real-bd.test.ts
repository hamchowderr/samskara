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
import type { RequestContext } from '@mastra/core/request-context';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BdRepo, BdRunner, BEADS_META } from '../src/index';
import { createHarness, PROJECT, sweep } from './harness';
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

/** One step held by a human gate (samskara-l2t.9). */
const GATED_FORMULA = `formula = "signoff"
description = "Gated workflow"
version = 1
type = "workflow"

[[steps]]
id = "ship"
title = "Ship the release"
description = "ship it"

[steps.gate]
type = "human"
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
    // bd lists an event (its own audit record) as ready; it is never carded (samskara-l2t.17).
    run('bd', ['create', 'Event', '-t', 'event', '--silent']);
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
    // Alpha, and the childless epic as a planning card (samskara-l2t.2.4).
    expect(first.repos[0], JSON.stringify(first)).toMatchObject({ state: 'ok', created: 2 });
    const cards = () =>
      h.workItems
        .beadCards()
        .filter(c => c.metadata?.[BEADS_META.cardKind] === undefined)
        .map(c => c.metadata?.[BEADS_META.id]);
    expect(cards()).toEqual([ids.alpha]);
    const epicCard = h.workItems.beadCards().find(c => c.metadata?.[BEADS_META.id] === ids.epic);
    expect(epicCard?.metadata).toMatchObject({ beadsCardKind: 'plan', beadsType: 'epic' });

    h.workItems.move(h.workItems.beadCards().find(c => c.metadata?.[BEADS_META.id] === ids.alpha)!.id, 'done');
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

    // Every bd call the integration makes, to count the reads per sweep (samskara-l2t.15).
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
    // The second step needs the first, so it is not ready yet.
    expect(card(second)).toBeUndefined();
    expect(card(grand)?.metadata?.beadsCardKind).toBeUndefined();

    // Idempotent: a further sweep changes no card, and reads every bead with one
    // bd list, whatever the number of containers (samskara-l2t.15).
    const revisions = h.workItems.beadCards().map(c => [c.id, c.revision, c.parentWorkItemId]);
    calls.length = 0;
    await sweep(integration);
    expect(h.workItems.beadCards().map(c => [c.id, c.revision, c.parentWorkItemId])).toEqual(revisions);
    expect(calls.map(c => c.filter(a => !a.startsWith('-'))[0])).toEqual(['dolt', 'list', 'ready']);
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
    const moved = await h.workItems.applyDecisions();
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

  it('re-reads after a close: a molecule root bd closed with its last step keeps its holder (samskara-l2t.15)', async () => {
    mkdirSync(join(seed, '.beads', 'formulas'), { recursive: true });
    writeFileSync(join(seed, '.beads', 'formulas', 'demo.formula.toml'), DEMO_FORMULA);
    const poured = JSON.parse(run('bd', ['mol', 'pour', 'demo', '--var', 'name=reread', '--json'])) as {
      new_epic_id: string;
      id_mapping: Record<string, string>;
    };
    const mol = poured.new_epic_id;
    run('bd', ['close', poured.id_mapping['demo.first']!]);
    const last = poured.id_mapping['demo.second']!;
    run('bd', ['update', mol, '--assignee', 'alice']);
    run('bd', ['dolt', 'push']);

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
    await sweep(integration);
    // Both cards wait in Done in one sweep, the last step's first: the refresh
    // read still shows the root open and held by alice when that close closes it.
    h.workItems.move(card(last).id, 'done');
    h.workItems.move(card(mol).id, 'done');
    h.workItems.items.sort((a, b) => Number(a.metadata?.[BEADS_META.id] === mol) - Number(b.metadata?.[BEADS_META.id] === mol));
    calls.length = 0;
    const summary = await sweep(integration);
    expect(summary.repos[0], JSON.stringify(summary)).toMatchObject({ state: 'ok', closed: 2 });
    expect(calls.filter(c => c.includes(mol) && (c.includes('update') || c.includes('close')))).toEqual([]);
    expect(card(mol).metadata?.[BEADS_META.writeback]).toBe('synced');

    run('bd', ['dolt', 'pull']);
    const rootBead = (JSON.parse(run('bd', ['--readonly', 'show', mol, '--json'])) as Array<{ status: string; assignee?: string; close_reason?: string }>)[0]!;
    expect(rootBead).toMatchObject({ status: 'closed', assignee: 'alice', close_reason: 'all steps complete' });
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

  it('cards a poured human gate for approval; a person moving it to Done closes the gate and the step becomes ready (samskara-l2t.9)', async () => {
    mkdirSync(join(seed, '.beads', 'formulas'), { recursive: true });
    writeFileSync(join(seed, '.beads', 'formulas', 'signoff.formula.toml'), GATED_FORMULA);
    const poured = JSON.parse(run('bd', ['mol', 'pour', 'signoff', '--json'])) as { new_epic_id: string; id_mapping: Record<string, string> };
    const gate = poured.id_mapping['signoff.gate-ship']!;
    const step = poured.id_mapping['signoff.ship']!;
    expect(gate, JSON.stringify(poured)).toBeTruthy();
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
    expect(card(gate)).toMatchObject({ title: `${gate}: Approve: Ship the release`, parentWorkItemId: card(poured.new_epic_id)!.id });
    expect(card(gate)!.metadata).toMatchObject({ beadsCardKind: 'gate', beadsType: 'gate', labels: expect.arrayContaining(['status: needs approval']) });
    expect(card(step)).toBeUndefined();

    h.workItems.move(card(gate)!.id, 'done');
    const approved = await sweep(integration);
    expect(approved.repos[0], JSON.stringify(approved)).toMatchObject({ state: 'ok', closed: 1 });
    expect(card(step)?.stages).toEqual(['intake']);
    run('bd', ['dolt', 'pull']);
    const shown = JSON.parse(run('bd', ['--readonly', 'show', gate, '--json'])) as Array<{ status: string }>;
    expect(shown[0]?.status).toBe('closed');
  }, 300_000);

  it('wakes a bead snoozed until a past date on the host copy, publishes it, and cards it; a future snooze stays deferred (samskara-l2t.14)', async () => {
    const snoozed = run('bd', ['create', 'Snoozed past', '-t', 'task', '--silent']).split(/\r?\n/)[0]!;
    const later = run('bd', ['create', 'Snoozed ahead', '-t', 'task', '--silent']).split(/\r?\n/)[0]!;
    // bd warns about a past date and defers anyway (checked on bd 1.3.1).
    run('bd', ['defer', snoozed, '--until=2025-01-15']);
    run('bd', ['defer', later, '--until=+1d']);
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
    const result = await sweep(integration);
    expect(result.repos[0], JSON.stringify(result)).toMatchObject({ state: 'ok' });
    expect(card(snoozed)?.stages).toEqual(['intake']);
    expect(card(snoozed)!.metadata?.[BEADS_META.held]).toBeUndefined();
    expect(card(later)).toBeUndefined();
    // The wake reached origin.
    run('bd', ['dolt', 'pull']);
    const shown = JSON.parse(run('bd', ['--readonly', 'show', snoozed, later, '--json'])) as Array<{ id: string; status: string }>;
    expect(shown.map(b => b.status)).toEqual(['open', 'deferred']);
  }, 300_000);

  it('closes a timer gate after its time with bd gate check on the host, publishes it, and cards the step (samskara-l2t.10)', async () => {
    const step = run('bd', ['create', 'Timed step', '-t', 'task', '--silent']).split(/\r?\n/)[0]!;
    const gate = (JSON.parse(run('bd', ['gate', 'create', '--type=timer', '--timeout=1s', '--blocks', step, '--json'])) as { id: string }).id;
    run('bd', ['dolt', 'push']);
    // Past its time before the sweep reads it.
    await new Promise(resolve => setTimeout(resolve, 1_500));

    const integration = h.integration({
      sourceControl: {
        id: 'github',
        versionControl: { getRepositoryAccess: async () => ({ cloneUrl: originUrl }) } as never,
      },
      cacheDir: join(root, 'c'),
      runner: new BdRunner(),
    });
    const card = (id: string) => h.workItems.beadCards().find(c => c.metadata?.[BEADS_META.id] === id);
    const result = await sweep(integration);
    expect(result.repos[0], JSON.stringify(result)).toMatchObject({ state: 'ok' });
    expect(card(step)?.stages).toEqual(['intake']);
    expect(card(gate)).toBeUndefined();
    run('bd', ['dolt', 'pull']);
    const shown = JSON.parse(run('bd', ['--readonly', 'show', gate, '--json'])) as Array<{ status: string }>;
    expect(shown[0]?.status).toBe('closed');
  }, 300_000);

  it('shows a carded bead\'s open blocker and its related bead as chips, on both related cards (samskara-l2t.11)', async () => {
    const make = (title: string) => run('bd', ['create', title, '-t', 'task', '--silent']).split(/\r?\n/)[0]!;
    const work = make('Dep work');
    const other = make('Dep related');
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
    await sweep(integration);
    const blocker = make('Dep blocker');
    run('bd', ['dep', 'add', work, blocker]);
    run('bd', ['dep', 'add', work, other, '--type', 'related']);
    run('bd', ['dolt', 'push']);
    const result = await sweep(integration);
    expect(result.repos[0], JSON.stringify(result)).toMatchObject({ state: 'ok' });
    expect(card(work)!.metadata?.labels).toEqual(expect.arrayContaining([`blocked by ${blocker}`, `related ${other}`]));
    expect(card(other)!.metadata?.labels).toEqual(expect.arrayContaining([`related ${work}`]));
  }, 300_000);

  it('cards a childless epic as a planning card; children filed through the beads tools make it an overview card (samskara-l2t.2.4)', async () => {
    const make = (title: string, type: string, parent?: string) =>
      run('bd', ['create', title, '-t', type, '--silent', ...(parent ? ['--parent', parent] : [])]).split(/\r?\n/)[0]!;
    const epic = make('Plan me', 'epic');
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
    const planned = await sweep(integration);
    expect(planned.repos[0], JSON.stringify(planned)).toMatchObject({ state: 'ok' });
    expect(card(epic)?.metadata).toMatchObject({ beadsCardKind: 'plan', beadsType: 'epic' });
    // Stable: a further sweep writes nothing to it.
    const revision = card(epic)!.revision;
    await sweep(integration);
    expect(card(epic)!.revision).toBe(revision);

    // File mode: the work seat's tools create the approved children under the epic and link them.
    const projects = h.ctx.storage.projects as unknown as { getById?: unknown };
    projects.getById = async ({ id }: { id: string }) => h.sourceControl.projects.find(p => p.id === id) ?? null;
    const rc = {
      get: (key: string) => (key === 'controller' ? { resourceId: `factory-supervisor:${PROJECT}`, getState: () => ({}) } : undefined),
    } as unknown as RequestContext;
    type Tools = Record<string, { execute: (input: unknown) => Promise<Record<string, unknown> & { error?: string }> }>;
    const tools = (await integration.agentTools({ requestContext: rc })) as unknown as Tools;
    const child = async (title: string) => {
      const created = await tools.beads_create!.execute({
        title,
        type: 'task',
        description: `${title}: the problem.`,
        design: 'How, and why.',
        acceptance: 'It is done.',
        parent: epic,
      });
      expect(created, JSON.stringify(created)).toMatchObject({ published: true });
      return (created.result as { id: string }).id;
    };
    const one = await child('Child A');
    const two = await child('Child B');
    expect(await tools.beads_dep_add!.execute({ issue: two, depends_on: one })).toMatchObject({ published: true });

    const flipped = await sweep(integration);
    expect(flipped.repos[0], JSON.stringify(flipped)).toMatchObject({ state: 'ok' });
    expect(card(epic)!.metadata).toMatchObject({ beadsCardKind: 'overview', beadsOpenChildren: 2 });
    expect(card(one)?.parentWorkItemId).toBe(card(epic)!.id);
    // Blocked by the first child, so not ready and not carded yet.
    expect(card(two)).toBeUndefined();
  }, 300_000);

  it('links a subtask card under its parent task card without making the task an overview card (samskara-l2t.2.5)', async () => {
    // The previous test published through the integration's tools: catch this copy up first.
    run('bd', ['dolt', 'pull']);
    const make = (title: string, type: string, parent?: string) =>
      run('bd', ['create', title, '-t', type, '--silent', ...(parent ? ['--parent', parent] : [])]).split(/\r?\n/)[0]!;
    const task = make('Parent task', 'task');
    const sub = make('Subtask', 'task', task);
    run('bd', ['dolt', 'push']);

    const integration = h.integration({
      sourceControl: {
        id: 'github',
        versionControl: { getRepositoryAccess: async () => ({ cloneUrl: originUrl }) } as never,
      },
      cacheDir: join(root, 'c'),
      runner: new BdRunner(),
      maxCloseAttempts: 1,
    });
    const card = (id: string) => h.workItems.beadCards().find(c => c.metadata?.[BEADS_META.id] === id)!;
    const linked = await sweep(integration);
    expect(linked.repos[0], JSON.stringify(linked)).toMatchObject({ state: 'ok' });
    // bd 1.3.1 lists both as ready, the subtask naming its parent.
    expect(card(sub).parentWorkItemId).toBe(card(task).id);
    expect(card(task).metadata?.[BEADS_META.cardKind]).toBeUndefined();
    expect(card(task).metadata?.[BEADS_META.openChildren]).toBeUndefined();

    // The task's card reaches Done first: bd refuses to close a bead with an open child.
    h.workItems.move(card(task).id, 'done');
    await sweep(integration);
    expect(card(task).metadata).toMatchObject({ [BEADS_META.writeback]: 'close-failed' });
    expect(String(card(task).metadata?.[BEADS_META.diagnostic])).toContain('open child');
    // The subtask closes, which re-arms the task's close; the next sweep closes it.
    h.workItems.move(card(sub).id, 'done');
    await sweep(integration);
    expect(card(task).metadata?.[BEADS_META.closeRearmedAt]).toEqual(expect.any(String));
    const closed = await sweep(integration);
    expect(closed.repos[0], JSON.stringify(closed)).toMatchObject({ state: 'ok' });
    expect(card(task).metadata?.[BEADS_META.writeback]).toBe('synced');
    run('bd', ['dolt', 'pull']);
    const shown = JSON.parse(run('bd', ['--readonly', 'show', task, '--json'])) as Array<{ status: string }>;
    expect(shown[0]?.status).toBe('closed');
  }, 300_000);

  it('moves cards of beads closed, superseded, marked duplicate and reopened in bd (samskara-l2t.3)', async () => {
    const integration = h.integration({
      sourceControl: {
        id: 'github',
        versionControl: { getRepositoryAccess: async () => ({ cloneUrl: originUrl }) } as never,
      },
      cacheDir: join(root, 'c'),
      runner: new BdRunner(),
    });
    const make = (title: string) => run('bd', ['create', title, '-t', 'task', '--silent']).split(/\r?\n/)[0]!;
    const fixed = make('Fixed elsewhere');
    const old = make('Old spec');
    const replacement = make('New spec');
    const dup = make('Same report');
    run('bd', ['dolt', 'push']);
    await sweep(integration);
    const card = (id: string) => h.workItems.beadCards().find(c => c.metadata?.[BEADS_META.id] === id)!;
    const mine = new Set([fixed, old, dup].map(id => card(id).id));
    const decisions = (applied: Awaited<ReturnType<typeof h.workItems.applyDecisions>>) =>
      applied.filter(a => mine.has(a.workItemId)).map(a => [a.workItemId, a.stage, a.outcome]);

    // A person closes, supersedes and marks a duplicate in their own copy, and pushes.
    run('bd', ['close', fixed, '--reason', 'fixed on a laptop']);
    run('bd', ['supersede', old, '--with', replacement]);
    run('bd', ['duplicate', dup, '--of', replacement]);
    run('bd', ['dolt', 'push']);
    await sweep(integration);
    expect(card(old).metadata?.[BEADS_META.closedOutside]).toBe('canceled');
    expect(decisions(await h.workItems.applyDecisions())).toEqual([
      [card(fixed).id, 'done', 'moved'],
      [card(old).id, 'canceled', 'moved'],
      [card(dup).id, 'canceled', 'moved'],
    ]);
    const synced = await sweep(integration);
    expect(synced.repos[0], JSON.stringify(synced)).toMatchObject({ state: 'ok' });
    expect(card(fixed).metadata).toMatchObject({ [BEADS_META.writeback]: 'synced' });
    // bd kept the person's close: write-back did not close it again as factory-beads.
    run('bd', ['dolt', 'pull']);
    const shown = (id: string) => (JSON.parse(run('bd', ['--readonly', 'show', id, '--json'])) as Array<{ status: string; close_reason?: string }>)[0]!;
    expect(shown(fixed)).toMatchObject({ status: 'closed', close_reason: 'fixed on a laptop' });

    // Reopened: the Done card comes back to Intake; the canceled ones stay.
    run('bd', ['reopen', fixed]);
    run('bd', ['reopen', old]);
    run('bd', ['dolt', 'push']);
    await sweep(integration);
    expect(decisions(await h.workItems.applyDecisions())).toEqual([[card(fixed).id, 'intake', 'moved']]);
    await sweep(integration);
    expect(card(fixed).metadata?.[BEADS_META.syncedAt]).toBeNull();
    expect(card(old).stages).toEqual(['canceled']);

    // Its next Done closes it again, as factory-beads.
    h.workItems.move(card(fixed).id, 'done');
    const closed = await sweep(integration);
    expect(closed.repos[0], JSON.stringify(closed)).toMatchObject({ state: 'ok', closed: 1 });
    run('bd', ['dolt', 'pull']);
    expect(shown(fixed).status).toBe('closed');
  }, 300_000);

  it('syncs status both ways: a card move sets in_progress or open, a bead blocked in bd sends its card to Intake (samskara-l2t.4)', async () => {
    const integration = h.integration({
      sourceControl: {
        id: 'github',
        versionControl: { getRepositoryAccess: async () => ({ cloneUrl: originUrl }) } as never,
      },
      cacheDir: join(root, 'c'),
      runner: new BdRunner(),
    });
    const bead = run('bd', ['create', 'Status sync', '-t', 'task', '--silent']).split(/\r?\n/)[0]!;
    run('bd', ['dolt', 'push']);
    await sweep(integration);
    const card = () => h.workItems.beadCards().find(c => c.metadata?.[BEADS_META.id] === bead)!;
    const shown = () => {
      run('bd', ['dolt', 'pull']);
      return (JSON.parse(run('bd', ['--readonly', 'show', bead, '--json'])) as Array<{ status: string; assignee?: string }>)[0]!;
    };

    h.workItems.move(card().id, 'execute');
    const started = await sweep(integration);
    expect(started.repos[0], JSON.stringify(started)).toMatchObject({ state: 'ok' });
    expect(shown()).toMatchObject({ status: 'in_progress' });
    expect(shown().assignee ?? '').toBe('');

    h.workItems.move(card().id, 'intake');
    await sweep(integration);
    expect(shown().status).toBe('open');

    // Blocked in bd while the card is in Building with no run: it moves to Intake, and the bead stays blocked.
    h.workItems.move(card().id, 'execute');
    await sweep(integration);
    run('bd', ['dolt', 'pull']);
    run('bd', ['update', bead, '--status', 'blocked']);
    run('bd', ['dolt', 'push']);
    await sweep(integration);
    expect(card().metadata?.[BEADS_META.held]).toBe('blocked');
    const applied = (await h.workItems.applyDecisions()).filter(a => a.workItemId === card().id);
    expect(applied).toEqual([{ workItemId: card().id, stage: 'intake', outcome: 'moved' }]);
    await sweep(integration);
    expect(shown().status).toBe('blocked');
  }, 300_000);

  it('posts bd comments to the card feed once, keyed by the bd comment id every copy shares (samskara-l2t.6)', async () => {
    const integration = h.integration({
      sourceControl: {
        id: 'github',
        versionControl: { getRepositoryAccess: async () => ({ cloneUrl: originUrl }) } as never,
      },
      cacheDir: join(root, 'c'),
      runner: new BdRunner(),
    });
    run('bd', ['dolt', 'pull']);
    const bead = run('bd', ['create', 'Commented', '-t', 'task', '--silent']).split(/\r?\n/)[0]!;
    run('bd', ['comments', 'add', bead, 'Line one\nline **two**', '--actor', 'alice']);
    run('bd', ['dolt', 'push']);
    const [seedComment] = JSON.parse(run('bd', ['--readonly', 'comments', bead, '--json'])) as Array<{ id: string; created_at: string }>;

    await sweep(integration);
    await sweep(integration);
    const card = h.workItems.beadCards().find(c => c.metadata?.[BEADS_META.id] === bead)!;
    const posted = h.feed.on(card.id);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      body: 'Line one\nline **two**',
      author: { id: 'beads:alice', displayName: 'alice' },
      externalSource: { integrationId: 'beads', type: 'comment', externalId: seedComment!.id },
      occurredAt: new Date(seedComment!.created_at),
    });
  }, 300_000);

  it("copies a person's card comment to bd under their name, published to origin, and never posts it back (samskara-l2t.7)", async () => {
    const integration = h.integration({
      sourceControl: {
        id: 'github',
        versionControl: { getRepositoryAccess: async () => ({ cloneUrl: originUrl }) } as never,
      },
      cacheDir: join(root, 'c'),
      runner: new BdRunner(),
    });
    h.feed.publishers = [integration.feedPublisher(h.ctx) as never];
    run('bd', ['dolt', 'pull']);
    const bead = run('bd', ['create', 'Card commented', '-t', 'task', '--silent']).split(/\r?\n/)[0]!;
    run('bd', ['dolt', 'push']);
    await sweep(integration);
    const card = h.workItems.beadCards().find(c => c.metadata?.[BEADS_META.id] === bead)!;

    const created = await h.feed.createComment({
      orgId: card.orgId,
      workItemId: card.id,
      author: { kind: 'user', id: 'u1', displayName: 'Jane Doe' },
      body: '--flag-like start\nsecond "line" cc @sam@example.com',
    });
    if (created.status !== 'created') throw new Error(created.status);
    await created.mirrored;

    run('bd', ['dolt', 'pull']);
    const inBd = JSON.parse(run('bd', ['--readonly', 'comments', bead, '--json'])) as Array<{ id: string; author: string; text: string }>;
    expect(inBd).toHaveLength(1);
    expect(inBd[0]).toMatchObject({ author: 'Jane Doe', text: '--flag-like start\nsecond "line" cc @sam' });
    expect(h.feed.on(card.id)[0]!.externalSource).toMatchObject({ integrationId: 'beads', type: 'comment', externalId: inBd[0]!.id });

    await sweep(integration);
    await sweep(h.integration({
      sourceControl: { id: 'github', versionControl: { getRepositoryAccess: async () => ({ cloneUrl: originUrl }) } as never },
      cacheDir: join(root, 'c'),
      runner: new BdRunner(),
    }));
    expect(h.feed.on(card.id)).toHaveLength(1);
    h.feed.publishers = [];
  }, 300_000);

  it('BdRepo.setStatus: writes only over the status read, exit 13 otherwise (samskara-l2t.4)', async () => {
    const dir = join(root, 'st');
    run('git', ['init', '-q', dir], root);
    run('bd', ['init', '-p', 'st', '--skip-agents', '-q'], dir);
    const id = run('bd', ['create', 'One', '-t', 'task', '--silent'], dir).split(/\r?\n/)[0]!;
    const repo = new BdRepo('local/status', dir, '', new BdRunner());
    const show = () => (JSON.parse(run('bd', ['--readonly', 'show', id, '--json'], dir)) as Array<{ status: string; assignee?: string }>)[0]!;
    expect((await repo.setStatus(id, 'in_progress', 'open')).code).toBe(0);
    expect(show()).toMatchObject({ status: 'in_progress' });
    expect(show().assignee ?? '').toBe('');
    const stale = await repo.setStatus(id, 'open', 'blocked');
    expect(stale.code, stale.stderr).toBe(13);
    expect(show().status).toBe('in_progress');
  }, 300_000);

  it('BdRepo.refresh: one bd list answers every bead and its children as bd list --parent does (samskara-l2t.15)', async () => {
    const dir = join(root, 'r');
    run('git', ['init', '-q', dir], root);
    run('bd', ['init', '-p', 'rf', '--skip-agents', '-q'], dir);
    const make = (title: string, type: string, parent?: string) =>
      run('bd', ['create', title, '-t', type, '--silent', ...(parent ? ['--parent', parent] : [])], dir).split(/\r?\n/)[0]!;
    // Nested epics, a task with subtasks, closed and claimed children.
    const outer = make('Outer', 'epic');
    const inner = make('Inner', 'epic', outer);
    const task = make('Task', 'task', inner);
    const sub1 = make('Sub one', 'task', task);
    const sub2 = make('Sub two', 'task', task);
    const sibling = make('Sibling', 'task', outer);
    const lone = make('Lone', 'task');
    run('bd', ['close', sub1, '--reason', 'done here'], dir);
    run('bd', ['update', sibling, '--assignee', 'alice', '--add-label', 'ui', '--add-label', 'api'], dir);
    run('bd', ['comments', 'add', task, 'a note'], dir);
    // A bead with two parents, and a dotted bead with no edge (as an import leaves one).
    const twice = make('Twice', 'task', inner);
    run('bd', ['dep', 'add', twice, sibling, '--type', 'parent-child'], dir);
    writeFileSync(join(dir, 'edgeless.jsonl'), `{"id":"${task}.9","title":"Edgeless","issue_type":"task","status":"open"}\n`);
    run('bd', ['import', 'edgeless.jsonl'], dir);

    const snapshot = await new BdRepo('local/refresh', dir, '', new BdRunner()).refresh();
    const ids = [outer, inner, task, sub1, sub2, sibling, lone, twice, `${task}.9`];
    expect(snapshot.size).toBe(ids.length);
    for (const id of ids) {
      const listed = (JSON.parse(run('bd', ['--readonly', 'list', `--parent=${id}`, '--all', '--json', '-n', '0'], dir)) as Array<{ id: string }>)
        .map(r => r.id)
        .sort();
      expect(snapshot.children(id).map(r => r.id).sort(), `children of ${id}`).toEqual(listed);
    }
    // The edge-less dotted bead is listed under every dotted prefix, the outer epic included.
    expect(snapshot.children(outer).map(r => r.id).sort()).toEqual([inner, sibling, `${task}.9`].sort());
    expect(snapshot.children(task).map(r => r.id).sort()).toEqual([sub1, sub2, `${task}.9`].sort());
    // What the inbound consumers read is on the rows (l2t.3, .4, .5, .6, .8).
    expect(snapshot.get(sub1)).toMatchObject({ status: 'closed', close_reason: 'done here', parent: task, title: 'Sub one' });
    expect(snapshot.get(sibling)).toMatchObject({ assignee: 'alice', labels: ['api', 'ui'], parent: outer, comment_count: 0 });
    expect(snapshot.get(task)).toMatchObject({ comment_count: 1, updated_at: expect.any(String) });
    // --brief: no description on any row.
    expect(Object.keys(snapshot.get(lone)!)).not.toContain('description');
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
