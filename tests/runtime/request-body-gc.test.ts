import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// samskara-z1i. Mastra's context middleware clones every POST body twice and
// discards one clone. The undici bundled with Node 22.19.0 (6.21.2) cancels the
// ORIGINAL body when a discarded clone is garbage-collected, so a request that
// waits on slow auth long enough for a GC reaches getParams with a dead body
// and fails with "TypeError: unusable". Node 22.23+ and 24 do not. This pins the
// runtime to one where the body survives.
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

describe('runtime Request body', () => {
  it('survives garbage collection of a discarded clone', async () => {
    const req = new Request('http://localhost/api/agent-controller/code/sessions', {
      method: 'POST',
      body: '{"resourceId":"r"}',
      headers: { 'content-type': 'application/json' },
    });
    const pristine = req.clone(); // Mastra keeps this copy for custom routes
    await req.clone().json(); // Mastra reads this copy and drops it

    for (let i = 0; i < 5; i++) {
      gc();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    await expect(req.clone().text()).resolves.toBe('{"resourceId":"r"}');
    expect(pristine.bodyUsed).toBe(false);
  });
});
