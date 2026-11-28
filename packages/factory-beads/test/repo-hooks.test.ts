import { afterEach, describe, expect, it } from 'vitest';

import { BEADS_META } from '../src/index';
import type { BeadsRepoHook, BeadsRepoHookContext } from '../src/index';
import { createHarness, SLUG, sweep } from './harness';
import type { Harness } from './harness';

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

const verbs = (harness: Harness) => harness.state().calls.map(c => c.argv.filter(a => !a.startsWith('-'))[0]);

describe('repository hooks (samskara-rvq)', () => {
  it('runs a hook on the linked repository, publishes its write and cards the bead it filed in the same sweep', async () => {
    h = createHarness([{ id: 'bd-1', title: 'Existing' }]);
    const seen: BeadsRepoHookContext[] = [];
    const hook: BeadsRepoHook = {
      name: 'filer',
      appliesTo: slug => slug === SLUG,
      run: async ctx => {
        seen.push(ctx);
        const res = await ctx.bd(['create', '--title', 'Filed by hook', '--type', 'bug', '--silent']);
        return { wrote: res.code === 0 };
      },
    };
    const summary = await sweep(h.integration({ repoHooks: [hook] }));
    expect(summary.repos[0]!.state).toBe('ok');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.slug).toBe(SLUG);
    expect(seen[0]!.snapshot.get('bd-1')?.title).toBe('Existing');
    const create = h.state().calls.find(c => c.argv.includes('create'))!;
    expect(create.argv.slice(0, 3)).toEqual(['--sandbox', '--actor', 'factory-beads']);
    // Published after the hook's write, before intake.
    const v = verbs(h);
    expect(v.indexOf('sync')).toBeGreaterThan(v.indexOf('create'));
    // The fake bd names a created bead fake-1: carded in this same sweep.
    expect(h.workItems.beadCards().map(c => c.metadata?.[BEADS_META.id])).toContain('fake-1');
    expect(h.workItems.beadCards().map(c => c.metadata?.[BEADS_META.id])).toContain('bd-1');
  });

  it('skips a hook for other repositories', async () => {
    h = createHarness([{ id: 'bd-1', title: 'Existing' }]);
    let ran = false;
    await sweep(h.integration({ repoHooks: [{ name: 'other', appliesTo: () => false, run: async () => ((ran = true), { wrote: false }) }] }));
    expect(ran).toBe(false);
  });

  it('reports a failing or throwing hook and still cards ready beads', async () => {
    h = createHarness([{ id: 'bd-1', title: 'Existing' }]);
    const summary = await sweep(
      h.integration({
        repoHooks: [
          { name: 'down', appliesTo: () => true, run: async () => ({ wrote: false, failed: true, diagnostic: 'app answered 503' }) },
          { name: 'boom', appliesTo: () => true, run: async () => { throw new Error('kaput'); } },
        ],
      }),
    );
    expect(summary.repos[0]!.diagnostic).toBe('down: app answered 503');
    expect(h.workItems.beadCards().map(c => c.metadata?.[BEADS_META.id])).toEqual(['bd-1']);
    // Nothing was written, so nothing extra was published.
    expect(verbs(h).filter(v => v === 'sync')).toHaveLength(0);
  });
});
