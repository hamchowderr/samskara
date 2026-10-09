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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RequestContext } from '@mastra/core/request-context';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BdRunner, BEADS_META } from '../src/index';
import { createHarness, PROJECT, sweep } from './harness';
import type { Harness } from './harness';

const bdAvailable = process.env.FACTORY_BEADS_REAL_BD !== '0' && spawnSync('bd', ['--version']).status === 0;

type Tools = Record<string, { execute: (input: unknown) => Promise<Record<string, unknown> & { error?: string }> }>;

describe.skipIf(!bdAvailable)('real bd agent tools (local-only)', () => {
  const root = mkdtempSync(join(tmpdir(), 'fbt-'));
  const bare = join(root, 'o.git');
  const seed = join(root, 's');
  const originUrl = pathToFileURL(bare).href;
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const run = (cmd: string, args: string[], cwd = seed) => execFileSync(cmd, args, { cwd, env, encoding: 'utf8' }).trim();
  let h: Harness;

  beforeAll(() => {
    // A plain repository: no .beads, no refs/dolt/data.
    run('git', ['init', '-q', '--bare', '-b', 'trunk', bare], root);
    run('git', ['clone', '-q', originUrl, seed], root);
    run('git', ['commit', '-q', '--allow-empty', '-m', 'chore: init fixture']);
    run('git', ['push', '-q', 'origin', 'trunk']);
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
      runner: new BdRunner(),
    });
    const rc = {
      get: (key: string) => (key === 'controller' ? { resourceId: 's', getState: () => ({ factoryProjectId: PROJECT }) } : undefined),
    } as unknown as RequestContext;
    const tools = (await integration.agentTools({ requestContext: rc })) as unknown as Tools;

    expect((await sweep(integration)).repos[0]!.state).toBe('no-beads-data');
    expect((await tools.beads_ready!.execute({})).error).toMatch(/does not use beads yet/);

    const init = await tools.beads_init!.execute({ confirm: true });
    expect(init, JSON.stringify(init)).toMatchObject({ published: true, prefix: 'widgets' });
    expect(run('git', ['ls-remote', originUrl])).toMatch(/refs\/dolt\/data/);
    expect(run('git', ['ls-remote', originUrl])).not.toMatch(/remote-info/);

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

    // The sweep finds the new data at once and cards the ready bead.
    const after = await sweep(integration);
    expect(after.repos[0], JSON.stringify(after)).toMatchObject({ state: 'ok', created: 1 });
    expect(h.workItems.beadCards().map(c => c.metadata?.[BEADS_META.id])).toEqual([id]);
  }, 600_000);
});
