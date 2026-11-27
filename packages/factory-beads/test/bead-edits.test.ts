/**
 * Cards follow bead edits, and agents read the full bead (samskara-l2t.8):
 * a card's title follows its bead's; a card whose bead is not ready still
 * gets its kind and parent link; no description comment is posted; and every
 * run started on a beads card is told to read the bead with beads_show.
 */
import { afterEach, describe, expect, it } from 'vitest';


import { BEADS_META, beadsKickoffHint, OVERVIEW_CARD_KIND, RESEARCH_CARD_KIND } from '../src/index';
import { createHarness, ORG, PROJECT, SLUG, sweep } from './harness';
import type { Harness } from './harness';

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

const card = (harness: Harness, beadId: string) => harness.workItems.items.find(i => i.metadata?.[BEADS_META.id] === beadId)!;

describe('card title follows the bead (samskara-l2t.8)', () => {
  it('retitles the card when the bead is retitled in bd, once', async () => {
    h = createHarness([{ id: 'w-1', title: 'Old name' }]);
    const integration = h.integration();
    await sweep(integration);
    expect(card(h, 'w-1')).toMatchObject({ title: 'w-1: Old name', metadata: { [BEADS_META.title]: 'Old name' } });
    h.bd('update', 'w-1', '--title=New name');
    await sweep(integration);
    expect(card(h, 'w-1')).toMatchObject({ title: 'w-1: New name', metadata: { [BEADS_META.title]: 'New name' } });
    const revision = card(h, 'w-1').revision;
    await sweep(integration);
    expect(card(h, 'w-1').revision).toBe(revision);
  });

  it("keeps a person's rename in the Factory until the bead's title changes", async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    const integration = h.integration();
    await sweep(integration);
    h.workItems.items.find(i => i.id === card(h!, 'w-1').id)!.title = 'Renamed by a person';
    await sweep(integration);
    expect(card(h, 'w-1').title).toBe('Renamed by a person');
    h.bd('update', 'w-1', '--title=Two');
    await sweep(integration);
    expect(card(h, 'w-1').title).toBe('w-1: Two');
  });

  it('catches up a card made before titles followed, and one whose bead is in progress or the card is done', async () => {
    h = createHarness([
      { id: 'w-1', title: 'One' },
      { id: 'w-2', title: 'Two' },
    ]);
    const integration = h.integration();
    await sweep(integration);
    for (const id of ['w-1', 'w-2']) {
      const item = h.workItems.items.find(i => i.id === card(h!, id).id)!;
      delete item.metadata![BEADS_META.title];
    }
    h.workItems.move(card(h, 'w-2').id, 'done');
    await sweep(integration);
    h.bd('update', 'w-1', '--title=One edited', '--status=in_progress');
    h.setState(s => {
      s.beads.find(b => b.id === 'w-2')!.title = 'Two edited';
    });
    await sweep(integration);
    expect(card(h, 'w-1').title).toBe('w-1: One edited');
    expect(card(h, 'w-2').title).toBe('w-2: Two edited');
  });
});

describe('cards whose bead is not ready (samskara-l2t.8)', () => {
  it('gets the research kind and its parent link from the refresh read while the bead waits on a dependency', async () => {
    h = createHarness([
      { id: 'w-1', title: 'One' },
      { id: 'w-b', title: 'Blocker' },
      { id: 'w-e', title: 'Epic', issue_type: 'epic' },
      { id: 'w-e.1', title: 'Child', parent: 'w-e' },
    ]);
    const integration = h.integration();
    await sweep(integration);
    // In bd, the bead gains a blocker (so bd ready no longer lists it),
    // becomes a decision and moves under the epic.
    h.setState(s => {
      const bead = s.beads.find(b => b.id === 'w-1')!;
      bead.blockedBy = ['w-b'];
      bead.issue_type = 'decision';
      bead.parent = 'w-e';
    });
    await sweep(integration);

    expect(card(h, 'w-1').metadata?.[BEADS_META.cardKind]).toBe(RESEARCH_CARD_KIND);
    expect(card(h, 'w-1').parentWorkItemId).toBe(card(h, 'w-e').id);
    expect(card(h, 'w-e').metadata?.[BEADS_META.cardKind]).toBe(OVERVIEW_CARD_KIND);
  });

  it('links an in-progress bead under its parent, and leaves its kind while its card is in a working phase', async () => {
    h = createHarness([
      { id: 'w-1', title: 'One' },
      { id: 'w-e', title: 'Epic', issue_type: 'epic' },
      { id: 'w-e.1', title: 'Child', parent: 'w-e' },
    ]);
    const integration = h.integration();
    await sweep(integration);
    h.workItems.move(card(h, 'w-1').id, 'execute');
    await sweep(integration);
    expect(h.state().beads.find(b => b.id === 'w-1')!.status).toBe('in_progress');
    h.setState(s => {
      const bead = s.beads.find(b => b.id === 'w-1')!;
      bead.issue_type = 'decision';
      bead.parent = 'w-e';
    });
    await sweep(integration);
    expect(card(h, 'w-1').parentWorkItemId).toBe(card(h, 'w-e').id);
    // A research kind mid-run would refuse the run's own move to Review.
    expect(card(h, 'w-1').metadata?.[BEADS_META.cardKind] ?? null).toBeNull();
  });
});

describe('no description comment (samskara-l2t.8)', () => {
  it('copies no bead text onto the card, and intake reads bd ready with --brief', async () => {
    h = createHarness([{ id: 'w-1', title: 'One', description: 'A long description.' }]);
    await sweep(h.integration());
    expect(card(h, 'w-1').description).not.toContain('A long description.');
    expect(h.state().calls.find(c => c.argv.includes('ready'))!.argv).toContain('--brief');
  });
});

describe('kickoff hint (samskara-l2t.8)', () => {
  const beadsMeta = { [BEADS_META.id]: 'w-1', [BEADS_META.repo]: 'acme/widgets' };
  const hint = beadsKickoffHint(beadsMeta)!;

  it('names the bead, its repository and beads_show', () => {
    expect(hint).toBe(
      'This card is bead w-1 in repository acme/widgets. Start by reading the bead in full (description, design, acceptance criteria and notes) with the beads_show tool.',
    );
    expect(beadsKickoffHint({ other: true })).toBeUndefined();
    expect(beadsKickoffHint(null)).toBeUndefined();
  });

  it("is the card's description, which every phase run reads through the work-item signal", async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    await sweep(h.integration());
    expect(card(h, 'w-1').description).toBe(hint);
  });

  it('is written onto a card made before cards had a description', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    const integration = h.integration();
    await sweep(integration);
    h.workItems.items.find(i => i.id === card(h!, 'w-1').id)!.description = null;
    await sweep(integration);
    expect(card(h, 'w-1').description).toBe(hint);
  });
});

describe('cards on the old Work-based board (Factory 0.31 port)', () => {
  const legacy = async (harness: Harness, stage: string, sessions: Record<string, unknown> = {}) => {
    const { item } = await harness.workItems.upsert({
      orgId: ORG,
      userId: 'u',
      factoryProjectId: PROJECT,
      input: {
        board: 'work',
        externalSource: { integrationId: 'beads', type: 'issue', externalId: 'w-1' },
        title: 'w-1: One',
        stages: [stage],
        metadata: { [BEADS_META.id]: 'w-1', [BEADS_META.repo]: SLUG },
      },
    });
    harness.workItems.items.find(i => i.id === item.id)!.sessions = sessions as never;
    return item.id;
  };

  it('moves a resting card onto the Beads board in the same phase, with the kickoff hint', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    const id = await legacy(h, 'intake');
    await sweep(h.integration());
    const moved = h.workItems.items.find(i => i.id === id)!;
    expect(moved).toMatchObject({ board: 'beads', stages: ['intake'] });
    expect(moved.description).toBe(beadsKickoffHint(moved.metadata));
    expect(h.workItems.beadCards()).toHaveLength(1);
  });

  it('leaves a card with a session seated on its phase, and a finished one, where they are', async () => {
    h = createHarness([{ id: 'w-1', title: 'One' }]);
    const id = await legacy(h, 'planning', { work: { sessionId: 's1', branch: 'b', threadId: 't' } });
    await sweep(h.integration());
    expect(h.workItems.items.find(i => i.id === id)).toMatchObject({ board: 'work', stages: ['planning'] });

    h.cleanup();
    h = createHarness([{ id: 'w-1', title: 'One', status: 'closed' }]);
    const done = await legacy(h, 'done');
    await sweep(h.integration());
    expect(h.workItems.items.find(i => i.id === done)).toMatchObject({ board: 'work', stages: ['done'] });
  });
});
