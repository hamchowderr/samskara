/**
 * Beads data on DoltHub (dolt-remote.ts): reading `sync.remote` from a
 * committed .beads/config.yaml, the credential root bd reads, and the sweep's
 * handling of a repository with no refs/dolt/data but a DoltHub remote.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { doltHubCredentialsFromEnv, isDoltHubRemote, syncRemoteOf, writeDoltRoot } from '../src/index';
import { createHarness, SLUG, sweep } from './harness';
import type { Harness } from './harness';

const JWK = JSON.stringify({ crv: 'Ed25519', d: 'private-part', kty: 'OKP', x: 'public-part' });

describe('syncRemoteOf', () => {
  it('reads the nested and the flat spelling, quoted or not, past comments', () => {
    expect(syncRemoteOf('# Beads\ndolt.shared-server: false\nsync:\n    remote: chowderr/braynee\n')).toBe('chowderr/braynee');
    expect(syncRemoteOf('sync.remote: "chowderr/samskara"  # DoltHub\n')).toBe('chowderr/samskara');
    expect(syncRemoteOf("sync:\n  mode: auto\n  remote: 'git+https://github.com/o/r.git'\n")).toBe('git+https://github.com/o/r.git');
  });
  it('finds nothing when the key is absent, commented out, or under another section', () => {
    expect(syncRemoteOf('# sync.remote: a/b\n# issue-prefix: ""\n')).toBeUndefined();
    expect(syncRemoteOf('export:\n    remote: a/b\nsync:\n    auto: true\n')).toBeUndefined();
    expect(syncRemoteOf('sync.remote: ""\n')).toBeUndefined();
  });
});

describe('isDoltHubRemote', () => {
  it('accepts owner/db and the doltremoteapi URL, nothing else', () => {
    expect(isDoltHubRemote('chowderr/braynee')).toBe(true);
    expect(isDoltHubRemote('https://doltremoteapi.dolthub.com/chowderr/braynee')).toBe(true);
    for (const other of ['git+https://github.com/o/r.git', 'file:///tmp/x', 'aws://[t:b]/db', 'a/b/c', 'braynee']) {
      expect(isDoltHubRemote(other), other).toBe(false);
    }
  });
});

describe('doltHubCredentialsFromEnv', () => {
  it('is undefined unless both variables are set', () => {
    expect(doltHubCredentialsFromEnv({})).toBeUndefined();
    expect(doltHubCredentialsFromEnv({ DOLT_CREDS_KEY_ID: 'abc123' })).toBeUndefined();
    expect(doltHubCredentialsFromEnv({ DOLT_CREDS_JWK: JWK })).toBeUndefined();
    expect(doltHubCredentialsFromEnv({ DOLT_CREDS_KEY_ID: ' abc123 ', DOLT_CREDS_JWK: JWK })).toEqual({ keyId: 'abc123', jwk: JWK });
  });
  it('rejects a malformed key without echoing it', () => {
    for (const [env, message] of [
      [{ DOLT_CREDS_KEY_ID: '../x', DOLT_CREDS_JWK: JWK }, /not a dolt key id/],
      [{ DOLT_CREDS_KEY_ID: 'abc', DOLT_CREDS_JWK: 'secret-not-json' }, /not valid JSON/],
      [{ DOLT_CREDS_KEY_ID: 'abc', DOLT_CREDS_JWK: '{"kty":"OKP"}' }, /needs "d" and "x"/],
    ] as const) {
      expect(() => doltHubCredentialsFromEnv(env)).toThrow(message);
      try {
        doltHubCredentialsFromEnv(env);
      } catch (error) {
        expect(String(error)).not.toContain('secret-not-json');
      }
    }
  });
});

describe('writeDoltRoot', () => {
  it('writes the layout dolt creds import does, private to the server user', () => {
    const root = mkdtempSync(join(tmpdir(), 'dolt-root-'));
    try {
      writeDoltRoot(root, { keyId: 'abc123', jwk: JWK }, { name: 'factory-beads', email: 'factory-beads@localhost' });
      const key = join(root, '.dolt', 'creds', 'abc123.jwk');
      expect(readFileSync(key, 'utf8')).toBe(JWK);
      if (process.platform !== 'win32') expect(statSync(key).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(join(root, '.dolt', 'config_global.json'), 'utf8'))).toEqual({
        'user.creds': 'abc123',
        'user.name': 'factory-beads',
        'user.email': 'factory-beads@localhost',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a repository whose beads live on DoltHub', () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  /** Commit a .beads/config.yaml to the harness remote and drop refs/dolt/data. */
  function onDoltHub(harness: Harness, config: string) {
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', harness.remote, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
    mkdirSync(join(harness.remote, '.beads'), { recursive: true });
    writeFileSync(join(harness.remote, '.beads', 'config.yaml'), config);
    git('add', '.beads/config.yaml');
    git('commit', '-q', '-m', 'beads on DoltHub');
    harness.setBeadsData(false);
  }

  it('without DoltHub credentials, reports what is missing instead of no data', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    onDoltHub(h, 'sync:\n    remote: chowderr/braynee\n');
    const info: string[] = [];
    const integration = h.integration({ logger: { info: (m: string) => info.push(m), warn: () => undefined, error: () => undefined } });
    const summary = await sweep(integration);
    expect(summary.repos[0]).toMatchObject({ repo: SLUG, state: 'no-beads-data', diagnostic: expect.stringContaining('DOLT_CREDS_KEY_ID') });
    expect(summary.repos[0]!.diagnostic).toContain('chowderr/braynee');
    expect(info.filter(l => l.includes('DoltHub'))).toHaveLength(1);
    expect(h.workItems.beadCards()).toHaveLength(0);
  });

  it('with credentials, bootstraps and syncs it like a refs/dolt/data repository', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    onDoltHub(h, 'sync.remote: chowderr/braynee\n');
    const integration = h.integration({ dolthub: { keyId: 'abc123', jwk: JWK } });
    const summary = await sweep(integration);
    expect(summary.repos[0]).toMatchObject({ repo: SLUG, state: 'ok', created: 1 });
    expect(existsSync(join(h.cacheDir, 'dolt-root', '.dolt', 'creds', 'abc123.jwk'))).toBe(true);
  });

  it('a git+ sync remote is not DoltHub: still no beads data', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    onDoltHub(h, 'sync.remote: git+https://github.com/o/r.git\n');
    const summary = await sweep(h.integration({ dolthub: { keyId: 'abc123', jwk: JWK } }));
    expect(summary.repos[0]).toMatchObject({ state: 'no-beads-data', diagnostic: expect.stringContaining('names no Dolt remote') });
  });
});
