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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BdRunner, BEADS_META } from '../src/index';
import { createHarness, sweep } from './harness';
import type { Harness } from './harness';

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
    run('bd', ['dep', 'add', ids.beta, ids.alpha]);
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
});
