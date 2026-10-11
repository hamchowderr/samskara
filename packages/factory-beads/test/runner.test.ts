import { describe, expect, it } from 'vitest';

import { BdRunner, childEnv, CREDENTIAL_HELPER, redact, TOKEN_ENV } from '../src/index';
import { createHarness, sweep, TOKEN } from './harness';

const configOf = (env: NodeJS.ProcessEnv) =>
  Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);

describe('childEnv', () => {
  it('puts the token in the environment and a helper that reads it, never a literal', () => {
    const env = childEnv({ actor: 'a', credentials: { token: TOKEN } });
    expect(env[TOKEN_ENV]).toBe(TOKEN);
    const config = configOf(env);
    // The helper list is reset before ours is added.
    expect(config.filter(([k]) => k === 'credential.helper').map(([, v]) => v)).toEqual(['', CREDENTIAL_HELPER]);
    expect(CREDENTIAL_HELPER).toContain(`$${TOKEN_ENV}`);
    for (const [, value] of config) expect(value).not.toContain(TOKEN);
  });

  it('gives gh the token only when asked, and never without credentials (samskara-l2t.10)', () => {
    expect(childEnv({ actor: 'a', credentials: { token: TOKEN } }).GH_TOKEN).toBeUndefined();
    const gh = childEnv({ actor: 'a', credentials: { token: TOKEN }, github: true });
    expect(gh).toMatchObject({ GH_TOKEN: TOKEN, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' });
    expect(childEnv({ actor: 'a', github: true }).GH_TOKEN).toBeUndefined();
  });

  it('blanks DOLT_REMOTE_INFO_BRANCH and sets core.longpaths', () => {
    const env = childEnv({ actor: 'a' });
    expect(env.DOLT_REMOTE_INFO_BRANCH).toBe('');
    expect(configOf(env)).toContainEqual(['core.longpaths', 'true']);
    expect(env[TOKEN_ENV]).toBeUndefined();
  });

  it('turns off bd usage metrics and the detached uploader, whatever else is passed', () => {
    const env = childEnv({ actor: 'a', extra: { BD_DISABLE_METRICS: '0', BD_DISABLE_EVENT_FLUSH: '0' } });
    expect(env.BD_DISABLE_METRICS).toBe('1');
    expect(env.BD_DISABLE_EVENT_FLUSH).toBe('1');
  });

  it("does not hand the server's environment to bd", () => {
    process.env.FAKE_SERVER_SECRET = 'server-only';
    try {
      expect(childEnv({ actor: 'a' }).FAKE_SERVER_SECRET).toBeUndefined();
    } finally {
      delete process.env.FAKE_SERVER_SECRET;
    }
  });
});

describe('BdRunner', () => {
  it('refuses a token in argv', () => {
    const runner = new BdRunner({ bdPath: process.execPath });
    expect(() => runner.bd(['close', `x${TOKEN}`], { cwd: '.', credentials: { token: TOKEN } })).toThrow(/argv/);
  });

  it('redacts the token from output', async () => {
    const runner = new BdRunner({ bdPath: process.execPath });
    const res = await runner.bd(['-e', `process.stderr.write('fatal: ' + process.env.${TOKEN_ENV})`], {
      cwd: '.',
      credentials: { token: TOKEN },
    });
    expect(res.stderr).toBe('fatal: [REDACTED]');
  });

  it('redact covers the basic-auth form', () => {
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    expect(redact(`a ${TOKEN} b ${basic}`, TOKEN)).toBe('a [REDACTED] b [REDACTED]');
  });

  it('a full sweep never puts the token in any argv or leaks server env', async () => {
    const h = createHarness([{ id: 'w-a', title: 'A' }]);
    process.env.FAKE_SERVER_SECRET = 'server-only';
    // The server's own setting must not turn bd's metrics back on.
    process.env.BD_DISABLE_METRICS = '0';
    try {
      const integration = h.integration();
      await sweep(integration);
      h.workItems.move(h.workItems.beadCards()[0]!.id, 'done');
      await sweep(integration);
      const calls = h.state().calls;
      expect(calls.length).toBeGreaterThan(4);
      for (const call of calls) {
        expect(call.argv.join(' ')).not.toContain(TOKEN);
        expect(call.env.remoteInfoBranch).toBe('');
        expect(call.env.serverSecret).toBeNull();
        expect(call.env.metrics).toEqual(['1', '1']);
      }
      // Only the network commands carry the credential.
      const withToken = calls.filter(c => c.env.token === TOKEN).map(c => c.argv.filter(a => !a.startsWith('-'))[0]);
      expect(new Set(withToken)).toEqual(new Set(['bootstrap', 'dolt', 'sync']));
    } finally {
      delete process.env.FAKE_SERVER_SECRET;
      delete process.env.BD_DISABLE_METRICS;
      h.cleanup();
    }
  });
});
