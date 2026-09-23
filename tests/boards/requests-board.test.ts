/**
 * The Requests board — a custom board built with defineBoard().
 *
 * defineBoard() does not validate onEnter keys (dist/boards/define-board.js),
 * so a misspelled or retired source key compiles and silently never fires.
 * These tests are the validation it does not do.
 */
import { describe, expect, it } from 'vitest';
import { FACTORY_RULE_SOURCES } from '@mastra/factory/rules/types';

import { requestsBoard } from '../../src/mastra/boards/requests-board';

type Board = {
  id: string;
  phases: Record<string, { onEnter?: Record<string, unknown> }>;
  transitionPolicy?: (context: unknown) => { type: string; code?: string } | undefined;
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
  const base = {
    item: { triageType: 'bug', acceptedAt: new Date() },
    requestedTriageType: undefined,
    fromStage: 'planning',
    toStage: 'execute',
  };

  it('stops the plan agent moving work into Building when auto-approve is off', () => {
    const result = board.transitionPolicy?.({
      ...base,
      actor: { type: 'agent', role: 'plan' },
      isHumanTransition: false,
      plansAutoApproved: false,
    });
    expect(result).toMatchObject({ type: 'reject', code: 'approval_required' });
  });

  it('lets a maintainer move it', () => {
    const result = board.transitionPolicy?.({
      ...base,
      actor: { type: 'user', id: 'u1' },
      isHumanTransition: true,
      plansAutoApproved: false,
    });
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
