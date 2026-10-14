import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { getRecommendedIsolation } from '@mastra/core/workspace';
import { IsolatedLocalFactorySandbox } from '../../src/mastra/sandbox/local-factory-sandbox';

const root = join(tmpdir(), 'samskara-local-factory-sandbox-test');

describe('IsolatedLocalFactorySandbox', () => {
  it('roots each session under its own directory and keeps the session id', async () => {
    const provider = new IsolatedLocalFactorySandbox({ root, isolation: 'none' });
    const sandbox = provider.create({ sessionId: 'sess-1' } as never);

    expect(provider.provider).toBe('local');
    expect(sandbox.id).toBe('sess-1');
    expect(sandbox.workingDirectory).toBe(join(root, 'sess-1'));
  });

  const backend = getRecommendedIsolation();
  it.skipIf(backend === 'none')('passes the native backend through with network allowed', async () => {
    const sandbox = new IsolatedLocalFactorySandbox({ root, isolation: backend }).create({
      sessionId: 'sess-2',
    } as never);
    const info = await sandbox.getInfo();

    expect(info.metadata?.isolation).toBe(backend);
    expect(info.metadata?.isolationConfig).toMatchObject({ allowNetwork: true });
  });
});
