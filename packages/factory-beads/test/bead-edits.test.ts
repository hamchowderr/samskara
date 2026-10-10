/**
 * Cards follow bead edits, and agents read the full bead (samskara-l2t.8):
 * a card's title follows its bead's; a card whose bead is not ready still
 * gets its kind and parent link; no description comment is posted; and every
 * run started on a beads card is told to read the bead with beads_show.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { FactoryStageRuleContext } from '@mastra/factory/rules/types';

import { requestsBoard } from '../../../src/mastra/boards/requests-board';
import { BEADS_META, beadsKickoffHint, OVERVIEW_CARD_KIND, RESEARCH_CARD_KIND, withBeadsKickoffHint } from '../src/index';
import { createHarness, sweep } from './harness';
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
  it('gets the research kind and its parent link from the refresh read while the bead is in progress', async () => {
    h = createHarness([
      { id: 'w-1', title: 'One' },
      { id: 'w-e', title: 'Epic', issue_type: 'epic' },
      { id: 'w-e.1', title: 'Child', parent: 'w-e' },
    ]);
    const integration = h.integration();
    await sweep(integration);
    h.workItems.move(card(h, 'w-1').id, 'planning');
    await sweep(integration);
    expect(h.state().beads.find(b => b.id === 'w-1')!.status).toBe('in_progress');
    // In bd, the in-progress bead becomes a decision and moves under the epic.
    h.setState(s => {
      const bead = s.beads.find(b => b.id === 'w-1')!;
      bead.issue_type = 'decision';
      bead.parent = 'w-e';
    });
    await sweep(integration);
    expect(card(h, 'w-1').metadata?.[BEADS_META.cardKind]).toBe(RESEARCH_CARD_KIND);
    expect(card(h, 'w-1').parentWorkItemId).toBe(card(h, 'w-e').id);
    expect(card(h, 'w-e').metadata?.[BEADS_META.cardKind]).toBe(OVERVIEW_CARD_KIND);
  });
});

describe('no description comment (samskara-l2t.8)', () => {
  it('posts nothing to the feed, and intake reads bd ready with --brief', async () => {
    h = createHarness([{ id: 'w-1', title: 'One', description: 'A long description.' }]);
    await sweep(h.integration());
    expect(h.feed.comments).toEqual([]);
    expect(h.state().calls.find(c => c.argv.includes('ready'))!.argv).toContain('--brief');
  });
});

describe('kickoff hint (samskara-l2t.8)', () => {
  const beadsMeta = { [BEADS_META.id]: 'w-1', [BEADS_META.repo]: 'acme/widgets' };
  const context = (stage: string, metadata: Record<string, unknown> | null) =>
    ({
      ingress: { id: 'ingress_1' },
      board: 'work',
      stage,
      fromStage: 'intake',
      toStage: stage,
      item: { id: 'card_1', title: 'w-1: One', url: null, source: 'manual', sourceKey: null, stages: [stage], metadata, triageType: null },
    }) as unknown as Readonly<FactoryStageRuleContext>;
  const run = (stage: 'triage' | 'planning' | 'execute', metadata: Record<string, unknown> | null) =>
    requestsBoard.phases[stage].onEnter!.manual!(context(stage, metadata)) as Promise<Record<string, unknown> | undefined>;
  const hint = beadsKickoffHint(beadsMeta)!;

  it('names the bead, its repository and beads_show', () => {
    expect(hint).toBe(
      'This card is bead w-1 in repository acme/widgets. Start by reading the bead in full (description, design, acceptance criteria and notes) with the beads_show tool.',
    );
    expect(beadsKickoffHint({ other: true })).toBeUndefined();
    expect(beadsKickoffHint(null)).toBeUndefined();
  });

  it("is appended to the Requests board's Planning and Building runs on a beads card, and to no other card's", async () => {
    const plan = await run('planning', beadsMeta);
    expect(plan).toMatchObject({ type: 'invokeSkill', skillName: 'factory-plan', arguments: `w-1: One\n\n${hint}` });
    const build = await run('execute', beadsMeta);
    expect(build?.type).toBe('invokeSkill');
    expect(String(build?.prompt).endsWith(`\n\n${hint}`)).toBe(true);
    expect(String((await run('planning', null))?.arguments)).not.toContain('beads_show');
    expect(String((await run('execute', { other: true }))?.prompt)).not.toContain('beads_show');
  });

  it("is appended to a research card's decision run and to Triage", async () => {
    const research = await run('planning', { ...beadsMeta, [BEADS_META.cardKind]: RESEARCH_CARD_KIND });
    expect(research).toMatchObject({ skillName: 'factory-beads-decision' });
    expect(String(research?.arguments).endsWith(hint)).toBe(true);
    const triage = await run('triage', beadsMeta);
    if (triage?.type === 'invokeSkill') expect(String(triage.arguments ?? triage.prompt)).toContain(hint);
  });

  it('passes every other decision through unchanged', async () => {
    const reject = { type: 'reject', code: 'forbidden', reason: 'no' } as const;
    expect(await withBeadsKickoffHint(() => reject)(context('planning', beadsMeta))).toEqual(reject);
    expect(await withBeadsKickoffHint(() => undefined)(context('planning', beadsMeta))).toBeUndefined();
    expect(await withBeadsKickoffHint()(context('planning', beadsMeta))).toBeUndefined();
  });
});
