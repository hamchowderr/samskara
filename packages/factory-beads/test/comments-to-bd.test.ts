/**
 * Card comments to bd (samskara-l2t.7): a person's comment on a beads card is
 * copied to its bead with `bd comments add --author`, through Factory's
 * feedPublisher seam, and never comes back to the card as a second comment.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { BEADS_COMMENT_SOURCE, BEADS_INTEGRATION_ID, BEADS_META } from '../src/index';
import type { BeadsIntegration } from '../src/index';
import { createHarness, ORG, sweep } from './harness';
import type { Harness } from './harness';

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

const card = (harness: Harness, beadId: string) => harness.workItems.items.find(i => i.metadata?.[BEADS_META.id] === beadId)!;
const beadComments = (harness: Harness, beadId: string) =>
  ((harness.state().beads.find(b => b.id === beadId) as { comments?: Array<{ id: string; author: string; text: string }> }).comments ?? []);

/** A board with the integration's publisher wired, as Factory wires it at boot. */
async function setup(beads: Parameters<typeof createHarness>[0]): Promise<{ harness: Harness; integration: BeadsIntegration }> {
  const harness = createHarness(beads);
  const integration = harness.integration();
  harness.feed.publishers = [integration.feedPublisher(harness.ctx) as never];
  await sweep(integration);
  return { harness, integration };
}

const comment = (harness: Harness, beadId: string, author: { kind: string; id: string; displayName?: string }, body: string) =>
  harness.feed.createComment({ orgId: ORG, workItemId: card(harness, beadId).id, author, body });

describe('card comments to bd (samskara-l2t.7)', () => {
  it("copies a person's comment to the bead under their name, and never posts it back", async () => {
    const { harness, integration } = await setup([{ id: 'w-1', title: 'One' }]);
    h = harness;
    const created = await comment(h, 'w-1', { kind: 'user', id: 'u1', displayName: 'Jane Doe' }, '- starts with a dash\nand **two** lines');
    if (created.status !== 'created') throw new Error(created.status);
    await created.mirrored;

    const [written] = beadComments(h, 'w-1');
    expect(written).toMatchObject({ author: 'Jane Doe', text: '- starts with a dash\nand **two** lines' });
    const write = h.state().calls.find(c => c.argv.includes('comments') && c.argv.includes('add'))!;
    expect(write.argv.slice(0, 3)).toEqual(['--sandbox', '--actor', write.argv[2]]);
    expect(write.argv[2]).not.toMatch(/\/agent$/);
    expect(h.feed.on(card(h, 'w-1').id)[0]!.externalSource).toEqual({
      integrationId: BEADS_INTEGRATION_ID,
      type: BEADS_COMMENT_SOURCE,
      externalId: written!.id,
    });

    await sweep(integration);
    await sweep(integration);
    expect(h.feed.on(card(h, 'w-1').id)).toHaveLength(1);
  });

  it('does not post a copied comment back after a restart, and still posts a new bd comment', async () => {
    const { harness } = await setup([{ id: 'w-1', title: 'One' }]);
    h = harness;
    const created = await comment(h, 'w-1', { kind: 'user', id: 'u1', displayName: 'Jane' }, 'From the card');
    if (created.status !== 'created') throw new Error(created.status);
    await created.mirrored;

    const restarted = h.integration();
    h.bd('comments', 'add', 'w-1', 'From bd', '--actor=bob');
    await sweep(restarted);
    expect(h.feed.on(card(h, 'w-1').id).map(c => c.body)).toEqual(['From the card', 'From bd']);
  });

  it('does not post a copied comment back from a sweep that runs before Factory records its source', async () => {
    const { harness, integration } = await setup([{ id: 'w-1', title: 'One' }]);
    h = harness;
    const real = integration.feedPublisher(h.ctx);
    h.feed.publishers = [
      {
        id: real.id,
        publish: async (row, item) => {
          const published = await real.publish(row as never, item);
          await sweep(integration);
          return published;
        },
      },
    ];
    const created = await comment(h, 'w-1', { kind: 'user', id: 'u1', displayName: 'Jane' }, 'Racing');
    if (created.status !== 'created') throw new Error(created.status);
    await created.mirrored;
    expect(h.feed.on(card(h, 'w-1').id)).toHaveLength(1);
  });

  it('writes one bd comment when a client retry offers the same comment again mid-copy', async () => {
    const { harness, integration } = await setup([{ id: 'w-1', title: 'One' }]);
    h = harness;
    const publisher = integration.feedPublisher(h.ctx);
    h.feed.publishers = [];
    const created = await comment(h, 'w-1', { kind: 'user', id: 'u1', displayName: 'Jane' }, 'Once');
    if (created.status !== 'created') throw new Error(created.status);
    const row = h.feed.on(card(h, 'w-1').id)[0]!;
    const item = card(h, 'w-1');
    const [first, retry] = await Promise.all([publisher.publish(row as never, item), publisher.publish(row as never, item)]);
    expect(retry).toEqual(first);
    expect(beadComments(h, 'w-1')).toHaveLength(1);
  });

  it('finds a copied comment on a feed longer than one page', async () => {
    const { harness } = await setup([{ id: 'w-1', title: 'One' }]);
    h = harness;
    h.feed.pageSize = 1;
    for (const body of ['Copied', 'Second', 'Third']) {
      const created = await comment(h, 'w-1', { kind: 'user', id: 'u1', displayName: 'Jane' }, body);
      if (created.status !== 'created') throw new Error(created.status);
      await created.mirrored;
    }
    await sweep(h.integration());
    expect(h.feed.on(card(h, 'w-1').id)).toHaveLength(3);
  });

  it('copies nothing from an agent, from bd itself, or on a card that is not a beads card', async () => {
    const { harness, integration } = await setup([{ id: 'w-1', title: 'One' }]);
    h = harness;
    const agent = await comment(h, 'w-1', { kind: 'agent', id: 'agent:binding_1' }, 'Agent note');
    if (agent.status === 'created') await agent.mirrored;
    const unlinked = await comment(h, 'w-1', { kind: 'user', id: 'slack:U123', displayName: 'Slack person' }, 'Aside');
    if (unlinked.status === 'created') await unlinked.mirrored;
    h.bd('comments', 'add', 'w-1', 'From bd', '--actor=bob');
    await sweep(integration);
    expect(beadComments(h, 'w-1').map(c => c.text)).toEqual(['From bd']);

    const other = { ...card(h, 'w-1'), id: 'manual_1', externalSource: null, metadata: {} };
    h.workItems.items.push(other as never);
    const manual = await h.feed.createComment({ orgId: ORG, workItemId: 'manual_1', author: { kind: 'user', id: 'u1', displayName: 'Jane' }, body: 'Hi' });
    if (manual.status === 'created') await manual.mirrored;
    expect(h.state().calls.filter(c => c.argv.includes('add')).length).toBe(1);
  });

  it('never writes an email address to bd', async () => {
    const { harness } = await setup([{ id: 'w-1', title: 'One' }]);
    h = harness;
    const created = await comment(h, 'w-1', { kind: 'user', id: 'u1', displayName: 'jane@example.com' }, 'Hello');
    if (created.status !== 'created') throw new Error(created.status);
    await created.mirrored;
    expect(beadComments(h, 'w-1')[0]).toMatchObject({ author: 'jane' });
  });
});
