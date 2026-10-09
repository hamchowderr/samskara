/**
 * The Requests board — Work's definition plus manual triage, installed as `work`.
 *
 * defineBoard() does not validate onEnter keys (dist/boards/define-board.js),
 * so a misspelled or retired source key compiles and silently never fires.
 * These tests are the validation it does not do.
 */
import { describe, expect, it } from 'vitest';
import { workBoard } from '@mastra/factory';
import { FACTORY_RULE_SOURCES } from '@mastra/factory/rules/types';
import type { FactoryRuleActor } from '@mastra/factory/rules/types';
import type { BoardTransitionPolicyContext } from '@mastra/factory/boards/transition-policy';

import { requestsBoard } from '../../src/mastra/boards/requests-board';

type Board = {
  id: string;
  phases: Record<string, { kind?: string; onEnter?: Record<string, unknown> }>;
  tools?: Record<string, { onResult: (context: unknown) => unknown }>;
};
const board = requestsBoard as unknown as Board;

describe('Requests board source keys', () => {
  it('declares only source keys the Factory runtime knows', () => {
    const known = new Set<string>(FACTORY_RULE_SOURCES);
    for (const [phase, def] of Object.entries(board.phases)) {
      for (const key of Object.keys(def.onEnter ?? {})) {
        expect(known.has(key), `phase "${phase}" declares unknown source "${key}"`).toBe(true);
      }
    }
  });

  it('runs triage for manual work — the reason this board exists', () => {
    expect(board.phases.triage?.onEnter).toHaveProperty('manual');
  });

  it('keeps Work\'s phases and roles, and adds no arrival automation (SKILL.md:23-25)', () => {
    const work = workBoard as unknown as Board & { phases: Record<string, { kind: string; role?: string }> };
    const ours = board as Board & { phases: Record<string, { kind: string; role?: string }> };
    expect(Object.keys(ours.phases)).toEqual(Object.keys(work.phases));
    for (const [id, phase] of Object.entries(work.phases)) {
      expect({ kind: ours.phases[id]?.kind, role: ours.phases[id]?.role }).toEqual({ kind: phase.kind, role: phase.role });
    }
    expect(board.phases.intake?.onEnter).toEqual(work.phases.intake?.onEnter);
  });

  it("wakes the beads worker on Done for manual cards and keeps Work's issue rule (samskara-iz6)", () => {
    const work = workBoard as unknown as Board;
    const done = board.phases.done?.onEnter ?? {};
    expect(done.issue).toBe(work.phases.done?.onEnter?.issue);
    expect(typeof done.manual).toBe('function');
    // Only signals: never a decision, beads card or not.
    const rule = done.manual as (context: unknown) => unknown;
    expect(rule({ item: { metadata: { beadsId: 'x-1' } } })).toBeUndefined();
    expect(rule({ item: { metadata: null } })).toBeUndefined();
  });
});

describe('plan approval gate (samskara-e6z)', () => {
  // @mastra/factory 0.20 (#25329): boards/work-transition-policy.js rejects
  // Planning -> Building for every non-human actor unless plans auto-approve
  // or the transition carries planApproved. The approved-plan rule runs as a
  // system actor (rules/processor.js), and the processor stamps planApproved
  // only for an approved submit_plan result.
  const policy = requestsBoard.transitionPolicy;
  const planToBuild = (
    actor: FactoryRuleActor,
    flags: Partial<Pick<BoardTransitionPolicyContext, 'planApproved' | 'plansAutoApproved'>> = {},
  ): BoardTransitionPolicyContext => ({
    tenant: { orgId: 'org-1', projectId: 'proj-1' },
    actor,
    ingress: { type: 'rule', id: 'ing-1' },
    cause: 'test',
    causalChain: [],
    configVersion: 'test',
    board: 'work',
    fromStage: 'planning',
    toStage: 'execute',
    source: 'manual',
    initialEntry: false,
    reenter: false,
    itemRevision: 1,
    isHumanTransition: actor.type === 'human',
    plansAutoApproved: false,
    planApproved: false,
    ...flags,
    item: {
      id: 'wi-1',
      source: 'manual',
      sourceKey: null,
      parentWorkItemId: null,
      title: 'A request',
      url: null,
      stages: ['planning'],
      acceptedAt: new Date().toISOString(),
      metadata: null,
      triageType: 'bug',
    },
  });

  it('rejects the plan agent moving work into Building without an approved plan', async () => {
    const result = await policy?.(planToBuild({ type: 'agent', bindingId: 'b-1', role: 'plan' }));
    expect(result).toMatchObject({ type: 'reject', code: 'approval_required' });
  });

  it('rejects the tool-result rule when planApproved is not stamped', async () => {
    const result = await policy?.(planToBuild({ type: 'system', id: 'factory-tool-result-rule' }));
    expect(result).toMatchObject({ type: 'reject', code: 'approval_required' });
  });

  it('lets a maintainer move it', async () => {
    const result = await policy?.(planToBuild({ type: 'human', id: 'u1' }));
    expect(result?.type).toBe('allow');
  });

  it('advances via submit_plan once planApproved is stamped', async () => {
    const result = await policy?.(
      planToBuild({ type: 'system', id: 'factory-tool-result-rule' }, { planApproved: true }),
    );
    expect(result?.type).toBe('allow');
  });
});

describe('beads overview cards (samskara-l2t.2.1)', () => {
  // The board's transitionPolicy runs for every transition and every actor
  // before any phase rule (@mastra/factory 0.20.0 rules/transition-service.js:245-262).
  const policy = requestsBoard.transitionPolicy!;
  const human: FactoryRuleActor = { type: 'human', id: 'u1' };
  const agent: FactoryRuleActor = { type: 'agent', bindingId: 'b-1', role: 'work' };
  const system: FactoryRuleActor = { type: 'system', id: 'factory-tool-result-rule' };
  const move = (
    actor: FactoryRuleActor,
    fromStage: string,
    toStage: string,
    metadata: Record<string, unknown> | null,
    flags: Partial<Pick<BoardTransitionPolicyContext, 'planApproved' | 'plansAutoApproved'>> = {},
  ): BoardTransitionPolicyContext => ({
    tenant: { orgId: 'org-1', projectId: 'proj-1' },
    actor,
    ingress: { type: 'rule', id: 'ing-1' },
    cause: 'test',
    causalChain: [],
    configVersion: 'test',
    board: 'work',
    fromStage,
    toStage,
    source: 'manual',
    initialEntry: false,
    reenter: false,
    itemRevision: 1,
    isHumanTransition: actor.type === 'human',
    plansAutoApproved: false,
    planApproved: false,
    ...flags,
    item: {
      id: 'wi-1',
      source: 'manual',
      sourceKey: null,
      parentWorkItemId: null,
      title: 'w-e: An epic',
      url: null,
      stages: [fromStage],
      acceptedAt: null,
      metadata,
      triageType: null,
    },
  });
  const overview = (openChildren: number) => ({ beadsId: 'w-e', beadsCardKind: 'overview', beadsOpenChildren: openChildren });

  it('derives the working phases from the board: triage, planning, execute, review', () => {
    const phases = board.phases as Record<string, { kind?: string }>;
    expect(Object.keys(phases).filter(id => phases[id]?.kind === 'working')).toEqual(['triage', 'planning', 'execute', 'review']);
  });

  for (const actor of [human, agent, system]) {
    for (const toStage of ['triage', 'planning', 'execute', 'review']) {
      it(`rejects a ${actor.type} moving an overview card into ${toStage}`, async () => {
        expect(await policy(move(actor, 'intake', toStage, overview(0), { planApproved: true, plansAutoApproved: true }))).toEqual({
          type: 'reject',
          code: 'forbidden',
          reason: 'An overview card closes when its last child closes',
        });
      });
    }
  }

  it('rejects Done while the overview card has open children, for every actor', async () => {
    for (const actor of [human, agent, system]) {
      expect(await policy(move(actor, 'intake', 'done', overview(2)))).toMatchObject({ type: 'reject', code: 'forbidden' });
    }
  });

  it('allows Done once no child is open, and Canceled at any time', async () => {
    expect((await policy(move(human, 'intake', 'done', overview(0))))?.type).toBe('allow');
    expect((await policy(move(system, 'intake', 'done', overview(0))))?.type).toBe('allow');
    expect((await policy(move(human, 'intake', 'canceled', overview(3))))?.type).toBe('allow');
  });

  it('leaves every other card to Work: the plan gate still holds, and work cards still move', async () => {
    const workCard = { beadsId: 'w-e.1' };
    expect(await policy(move(agent, 'planning', 'execute', workCard))).toMatchObject({ type: 'reject', code: 'approval_required' });
    expect(await policy(move(agent, 'planning', 'execute', null))).toMatchObject({ type: 'reject', code: 'approval_required' });
    expect((await policy(move(human, 'intake', 'triage', workCard)))?.type).toBe('allow');
    expect((await policy(move(human, 'intake', 'done', { ...workCard, beadsOpenChildren: 5 })))?.type).toBe('allow');
    // Same answers as Work's own policy.
    for (const context of [move(agent, 'planning', 'execute', workCard), move(human, 'intake', 'execute', workCard)]) {
      expect(await policy(context)).toEqual(await workBoard.transitionPolicy!(context));
    }
  });
});

describe('approved plan advances on THIS board', () => {
  const onResult = board.tools?.submit_plan?.onResult;
  const approved = {
    result: { status: 'success', value: 'Plan approved. Building next.' },
    item: { stages: ['planning'] },
    actor: { type: 'agent', role: 'plan' },
    ingress: { id: 'ing-1' },
  };

  it('targets this board (id "work"), which the SDK rule hardcodes', () => {
    // The SDK rule hardcodes board "work" and the transition service rejects
    // cross-board moves; sharing Work's id is what lets it fire here unwrapped.
    expect(onResult?.(approved)).toMatchObject({ type: 'transition', board: 'work', stage: 'execute' });
  });

  it('does nothing for a plan that was not approved', () => {
    expect(onResult?.({ ...approved, result: { status: 'success', value: 'Needs changes.' } })).toBeUndefined();
  });
});
