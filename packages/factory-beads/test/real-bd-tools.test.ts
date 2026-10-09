/**
 * The agent tools against a REAL `bd` and git (samskara-e64): beads_init on a
 * repository with no beads, then create/update/dep add, then the sweep cards
 * what the tools wrote. Origin is a bare repository in a temp directory,
 * reached through `file://` like real-bd.test.ts.
 *
 * LOCAL-ONLY: skipped when `bd` is not on PATH (CI installs none). Set
 * FACTORY_BEADS_REAL_BD=0 to skip it on a machine that has bd.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RequestContext } from '@mastra/core/request-context';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BdRunner, BEADS_META } from '../src/index';
import { createHarness, PROJECT, sweep } from './harness';
import type { Harness } from './harness';

const bdAvailable = process.env.FACTORY_BEADS_REAL_BD !== '0' && spawnSync('bd', ['--version']).status === 0;

/** A repository formula: two steps, the second needing the first. */
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

/** A repository formula whose first step is gated. */
const GATED_FORMULA = `formula = "mol-demo"
description = "Demo with a gate"
version = 1
type = "workflow"

[[steps]]
id = "gate-a"
title = "Wait"
description = "wait"

[steps.gate]
type = "human"

[[steps]]
id = "b"
title = "Work"
description = "work"
needs = ["gate-a"]
`;

/** Inherits the gate: \`formula show\` lists no gate for it, \`cook\` does. */
const CHILD_FORMULA = `formula = "mol-child"
description = "Child"
version = 1
type = "workflow"
extends = ["mol-demo"]

[[steps]]
id = "c"
title = "More"
description = "more"
`;

/** Extends a formula that lives outside the repository. */
const WRAP_FORMULA = `formula = "mol-wrap"
description = "Wrap"
version = 1
type = "workflow"
extends = ["outside"]

[[steps]]
id = "w"
title = "Wrap step"
description = "wrap"
`;

/** In the server user's ~/.beads/formulas (a temp home here), not the repository. */
const OUTSIDE_FORMULA = `formula = "outside"
description = "Outside"
version = 1
type = "workflow"

[[steps]]
id = "o"
title = "OUTSIDE private step"
description = "private"
`;

/** Attaches the gated formula through a hook, which bd 1.3.0 never applies. */
const HOOKED_FORMULA = `formula = "mol-hooked"
description = "Hooked"
version = 1
type = "workflow"

[[steps]]
id = "h"
title = "Hooked step"
description = "hooked"

[[compose.hooks]]
trigger = "label:security"
attach = "mol-demo"
`;

/** Outside the repository; the repository commits a symlink to it. */
const LINKED_FORMULA = `formula = "linked"
description = "Linked"
version = 1
type = "workflow"

[[steps]]
id = "l"
title = "LINKED private step"
description = "private"
`;

type Tools = Record<string, { execute: (input: unknown) => Promise<Record<string, unknown> & { error?: string }> }>;

describe.skipIf(!bdAvailable)('real bd agent tools (local-only)', () => {
  const root = mkdtempSync(join(tmpdir(), 'fbt-'));
  const bare = join(root, 'o.git');
  const seed = join(root, 's');
  const originUrl = pathToFileURL(bare).href;
  const home = join(root, 'home');
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const run = (cmd: string, args: string[], cwd = seed) => execFileSync(cmd, args, { cwd, env, encoding: 'utf8' }).trim();
  let h: Harness;

  beforeAll(() => {
    // A plain repository: no .beads, no refs/dolt/data.
    run('git', ['init', '-q', '--bare', '-b', 'trunk', bare], root);
    run('git', ['clone', '-q', originUrl, seed], root);
    run('git', ['commit', '-q', '--allow-empty', '-m', 'chore: init fixture']);
    run('git', ['push', '-q', 'origin', 'trunk']);
    mkdirSync(join(home, '.beads', 'formulas'), { recursive: true });
    writeFileSync(join(home, '.beads', 'formulas', 'outside.formula.toml'), OUTSIDE_FORMULA);
    h = createHarness([]);
    const projects = h.ctx.storage.projects as unknown as { getById?: unknown };
    projects.getById = async ({ id }: { id: string }) => h.sourceControl.projects.find(p => p.id === id) ?? null;
  }, 120_000);

  afterAll(() => {
    h?.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it('initialises beads, writes through the tools, and the sweep cards the result', async () => {
    const integration = h.integration({
      sourceControl: { id: 'github', versionControl: { getRepositoryAccess: async () => ({ cloneUrl: originUrl }) } as never },
      cacheDir: join(root, 'c'),
      // A home of its own whose ~/.beads/formulas holds a formula the
      // repository does not, standing in for the server user's library.
      runner: new BdRunner({ env: { HOME: home, USERPROFILE: home } }),
    });
    const rc = {
      // The supervisor session: only it gets beads_init.
      get: (key: string) => (key === 'controller' ? { resourceId: `factory-supervisor:${PROJECT}`, getState: () => ({}) } : undefined),
    } as unknown as RequestContext;
    const tools = (await integration.agentTools({ requestContext: rc })) as unknown as Tools;

    expect((await sweep(integration)).repos[0]!.state).toBe('no-beads-data');
    expect((await tools.beads_ready!.execute({})).error).toMatch(/does not use beads yet/);

    const init = await tools.beads_init!.execute({ confirm: true });
    expect(init, JSON.stringify(init)).toMatchObject({ published: true, prefix: 'widgets' });
    expect(run('git', ['ls-remote', originUrl])).toMatch(/refs\/dolt\/data/);
    expect(run('git', ['ls-remote', originUrl])).not.toMatch(/remote-info/);

    // The repository commits a formula; it is in the copy the next tool call bootstraps.
    mkdirSync(join(seed, '.beads', 'formulas'), { recursive: true });
    writeFileSync(join(seed, '.beads', 'formulas', 'demo.formula.toml'), DEMO_FORMULA);
    writeFileSync(join(seed, '.beads', 'formulas', 'mol-demo.formula.toml'), GATED_FORMULA);
    writeFileSync(join(seed, '.beads', 'formulas', 'mol-child.formula.toml'), CHILD_FORMULA);
    writeFileSync(join(seed, '.beads', 'formulas', 'mol-wrap.formula.toml'), WRAP_FORMULA);
    writeFileSync(join(seed, '.beads', 'formulas', 'mol-hooked.formula.toml'), HOOKED_FORMULA);
    run('git', ['add', '.beads/formulas']);
    // A committed symlink (mode 120000) to an absolute path outside the repository. On
    // Linux the copy checks it out as a real symlink, which bd follows; where git has
    // core.symlinks off (Git for Windows' default) it is a plain file bd skips.
    mkdirSync(join(root, 'ext'), { recursive: true });
    writeFileSync(join(root, 'ext', 'linked.formula.toml'), LINKED_FORMULA);
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: seed, env, input: join(root, 'ext', 'linked.formula.toml') }).toString().trim();
    run('git', ['update-index', '--add', '--cacheinfo', `120000,${blob},.beads/formulas/linked.formula.toml`]);
    run('git', ['commit', '-q', '-m', 'chore: add formulas']);
    run('git', ['push', '-q', 'origin', 'trunk']);

    const invalid = await tools.beads_create!.execute({
      title: 'Fix: a bug without steps',
      type: 'bug',
      description: 'Broken.',
      design: 'Unknown yet.',
      acceptance: 'It works.',
    });
    expect(invalid.error).toMatch(/Steps to Reproduce/);
    expect((await tools.beads_create!.execute({ title: 'T', type: 'widget', description: 'd', design: 'd' })).error).toMatch(/not an issue type/);

    const created = await tools.beads_create!.execute({
      title: 'Add: export button',
      type: 'feature',
      description: 'Users cannot export their data, so they copy it by hand.',
      design: 'A CSV export; chose CSV over XLSX because every tool reads it.',
      acceptance: 'A user can download their data as CSV.',
    });
    expect(created, JSON.stringify(created)).toMatchObject({ published: true });
    const id = (created.result as { id: string }).id;
    expect(id).toMatch(/^widgets-/);

    expect((await tools.beads_update!.execute({ id, status: 'closed' })).error).toMatch(/never close/);
    expect(await tools.beads_update!.execute({ id, append_notes: 'checked the CSV spec' })).toMatchObject({ published: true });
    const shown = await tools.beads_show!.execute({ id });
    expect(JSON.stringify(shown)).toMatch(/checked the CSV spec/);

    // Only the repository's formula is offered, never the server user's ~/.beads/formulas.
    const listed = await tools.beads_formula_list!.execute({});
    expect((listed.formulas as Array<{ name: string }>).map(f => f.name).sort(), JSON.stringify(listed)).toEqual([
      'demo',
      'mol-child',
      'mol-demo',
      'mol-hooked',
      'mol-wrap',
    ]);
    // The symlinked formula is not the repository's, whatever bd made of it.
    expect((await tools.beads_pour!.execute({ formula: 'linked', dry_run: true })).error).toMatch(/not one of this repository's formulas/);
    // A hook attaching a gated formula is refused, though bd 1.3.0 would pour without it.
    expect((await tools.beads_pour!.execute({ formula: 'mol-hooked', dry_run: true })).error).toMatch(/attaches "mol-demo"/);
    // A gate inherited through extends is refused: only `bd cook` shows it.
    for (const dry_run of [true, false]) {
      expect((await tools.beads_pour!.execute({ formula: 'mol-child', dry_run })).error).toMatch(/gated steps \(its own or inherited\)/);
    }
    // extends to a formula outside the repository is refused, though bd would pour it.
    expect((await tools.beads_pour!.execute({ formula: 'mol-wrap', dry_run: true })).error).toMatch(/composes with "outside"/);
    expect((await tools.beads_pour!.execute({ formula: 'outside', dry_run: true })).error).toMatch(/not one of this repository's formulas/);
    // A real dry run: bd refuses pour under --readonly, so this proves the mode.
    const preview = await tools.beads_pour!.execute({ formula: 'demo', vars: { name: 'x' }, dry_run: true });
    expect(preview.error, JSON.stringify(preview)).toBeUndefined();
    expect(String(preview.preview)).toMatch(/would pour 3 issues/);

    // The sweep finds the new data at once and cards the ready bead (the dry run wrote nothing).
    const after = await sweep(integration);
    expect(after.repos[0], JSON.stringify(after)).toMatchObject({ state: 'ok', created: 1 });
    expect(h.workItems.beadCards().map(c => c.metadata?.[BEADS_META.id])).toEqual([id]);
    // Usage metrics were off for every bd call: bd queues events and caches its
    // machine id under ~/.beads only when they are on (internal/metrics).
    expect(existsSync(join(home, '.beads', 'eventsData'))).toBe(false);
    expect(existsSync(join(home, '.beads', 'machine-id'))).toBe(false);
  }, 600_000);
});
