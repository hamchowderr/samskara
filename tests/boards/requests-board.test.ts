/**
 * The Requests board — a custom board built with defineBoard().
 *
 * defineBoard() does not validate onEnter keys (dist/boards/define-board.js),
 * so a misspelled or retired source key compiles and silently never fires.
 * These tests are the validation it does not do.
 */
import { describe, expect, it } from 'vitest';
import { FACTORY_RULE_SOURCES } from '@mastra/factory/rules/types';
import type { FactoryRuleActor } from '@mastra/factory/rules/types';
import type { BoardTransitionPolicyContext } from '@mastra/factory/boards/transition-policy';

import { requestsBoard } from '../../src/mastra/boards/requests-board';

type Board = {
  id: string;
  phases: Record<string, { onEnter?: Record<string, unknown> }>;
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
    expect(board.phases.intake?.onEnter).toHaveProperty('manual');
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
    board: 'requests',
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

describe('approved plan advances on THIS board', () => {
  const onResult = board.tools?.submit_plan?.onResult;
  const approved = {
    result: { status: 'success', value: 'Plan approved. Building next.' },
    item: { stages: ['planning'] },
    actor: { type: 'agent', role: 'plan' },
    ingress: { id: 'ing-1' },
  };

  it('targets the requests board, not the SDK default "work"', () => {
    // The SDK rule hardcodes board "work"; the transition service rejects
    // cross-board moves, so without the override an approved plan never moves.
    expect(onResult?.(approved)).toMatchObject({ type: 'transition', board: 'requests', stage: 'execute' });
  });

  it('does nothing for a plan that was not approved', () => {
    expect(onResult?.({ ...approved, result: { status: 'success', value: 'Needs changes.' } })).toBeUndefined();
  });
});
