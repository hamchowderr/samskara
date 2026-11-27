/**
 * The Beads board (beads-board.ts) and its transition policy (board-rules.ts),
 * on @mastra/factory 0.31: Work's phases, plus one phase per beads skill, and
 * a policy that keeps each card kind in the phases meant for it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workBoard } from '@mastra/factory';
import { createBoardRegistry } from '@mastra/factory/boards';
import type { BoardTransitionPolicyContext } from '@mastra/factory/boards/transition-policy';
import type { FactoryRuleActor } from '@mastra/factory/rules/types';

import {
  BEADS_BOARD_ID,
  BEADS_ONLY_PHASE_REASON,
  BEADS_PHASES,
  beadsBoard,
  DECISION_SKILL,
  EPIC_SKILL,
  GATE_APPROVAL_REASON,
  GATE_WORKING_REASON,
  OVERVIEW_OPEN_CHILDREN_REASON,
  OVERVIEW_WORKING_REASON,
  PLAN_APPROVAL_REASON,
  PLAN_DONE_REASON,
  PLAN_WORKING_REASON,
  RESEARCH_APPROVAL_REASON,
  RESEARCH_WORKING_REASON,
} from '../src';

const human: FactoryRuleActor = { type: 'human', id: 'u1' };
const agent: FactoryRuleActor = { type: 'agent', bindingId: 'b-1', role: 'work' };
const system: FactoryRuleActor = { type: 'system', id: 'factory-rule-dispatcher' };
const machines = [agent, system];

const policy = beadsBoard.transitionPolicy!;

function move(actor: FactoryRuleActor, fromStage: string, toStage: string, metadata: Record<string, unknown> | null) {
  const context = {
    tenant: { orgId: 'org-1', projectId: 'proj-1' },
    actor,
    ingress: { type: 'rule', id: 'ing-1' },
    cause: 'test',
    causalChain: [],
    board: BEADS_BOARD_ID,
    fromStage,
    toStage,
    source: 'manual',
    initialEntry: false,
    reenter: false,
    itemRevision: 1,
    isHumanTransition: actor.type === 'human',
    plansAutoApproved: true,
    planApproved: true,
    item: {
      id: 'wi-1',
      source: 'manual',
      sourceKey: null,
      parentWorkItemId: null,
      title: 'w-1: A bead',
      url: null,
      stages: [fromStage],
      acceptedAt: null,
      metadata,
      triageType: null,
    },
  } as unknown as BoardTransitionPolicyContext;
  return policy(context);
}

const workingPhases = Object.entries(beadsBoard.phases)
  .filter(([, phase]) => phase.kind === 'working')
  .map(([id]) => id);

describe('Beads board definition', () => {
  it('installs beside Work under its own key', () => {
    const registry = createBoardRegistry({ boards: [beadsBoard] });
    expect(registry.get(BEADS_BOARD_ID)).toBeDefined();
    expect(registry.get('work')).toBeDefined();
  });

  it("keeps Work's phases as Work declares them, and its source-closed mapping", () => {
    for (const id of Object.keys(workBoard.phases) as (keyof typeof workBoard.phases)[]) {
      const ours = beadsBoard.phases[id as keyof typeof beadsBoard.phases];
      expect(ours.kind).toBe(workBoard.phases[id].kind);
      if (ours.kind === 'working' && workBoard.phases[id].kind === 'working') {
        expect(ours.runner).toEqual(workBoard.phases[id].runner);
      }
      for (const next of workBoard.phases[id].nextPhases) expect(ours.nextPhases).toContain(next);
    }
    expect(beadsBoard.initialPhase).toBe('intake');
    expect(beadsBoard.sourceClosed).toEqual(workBoard.sourceClosed);
  });

  it('runs the decision skill in Researching and the epic skill in Proposing and Filing', () => {
    const phase = (id: string) => beadsBoard.phases[id as keyof typeof beadsBoard.phases];
    const runner = (id: string) => {
      const p = phase(id);
      return p.kind === 'working' ? p.runner : undefined;
    };
    expect(runner(BEADS_PHASES.research)).toMatchObject({ skill: DECISION_SKILL });
    expect(runner(BEADS_PHASES.epicPlan)).toMatchObject({ skill: EPIC_SKILL, instructions: 'Mode: propose' });
    expect(runner(BEADS_PHASES.epicFile)).toMatchObject({ skill: EPIC_SKILL, instructions: 'Mode: file' });
  });

  it('ships both skills where Factory loads app skills, with frontmatter naming them', () => {
    for (const skill of [DECISION_SKILL, EPIC_SKILL]) {
      const path = join(__dirname, '../../../src/mastra/public/factory-skills', skill, 'SKILL.md');
      expect(existsSync(path), path).toBe(true);
      expect(readFileSync(path, 'utf8')).toMatch(new RegExp(`^---\\nname: ${skill}\\n`));
    }
  });
});

describe('Beads board policy', () => {
  it('keeps an ordinary bead out of the beads-only phases, for every actor', () => {
    for (const actor of [human, ...machines]) {
      for (const phase of Object.values(BEADS_PHASES)) {
        expect(move(actor, 'intake', phase, { beadsId: 'w-1' })).toMatchObject({ type: 'reject', reason: BEADS_ONLY_PHASE_REASON });
      }
      expect(move(actor, 'intake', 'planning', { beadsId: 'w-1' })).toBeUndefined();
    }
  });

  describe('overview cards', () => {
    const overview = (openChildren: number) => ({ beadsId: 'w-e', beadsCardKind: 'overview', beadsOpenChildren: openChildren });
    it('enter no working phase, whoever moves them', () => {
      for (const actor of [human, ...machines]) {
        for (const phase of workingPhases) {
          expect(move(actor, 'intake', phase, overview(0))).toMatchObject({ type: 'reject', reason: OVERVIEW_WORKING_REASON });
        }
      }
    });
    it('reach Done only with no open children', () => {
      expect(move(human, 'intake', 'done', overview(2))).toMatchObject({ type: 'reject', reason: OVERVIEW_OPEN_CHILDREN_REASON });
      expect(move(system, 'intake', 'done', overview(0))).toBeUndefined();
    });
  });

  describe('research cards', () => {
    const research = { beadsId: 'w-d', beadsCardKind: 'research' };
    it('enter Researching and no other working phase', () => {
      expect(move(human, 'intake', BEADS_PHASES.research, research)).toBeUndefined();
      for (const phase of workingPhases.filter(p => p !== BEADS_PHASES.research)) {
        expect(move(human, 'intake', phase, research)).toMatchObject({ type: 'reject', reason: RESEARCH_WORKING_REASON });
      }
    });
    it('reach Done only by a person, or when the bead was closed in bd', () => {
      for (const actor of machines) {
        expect(move(actor, BEADS_PHASES.research, 'done', research)).toMatchObject({
          type: 'reject',
          code: 'approval_required',
          reason: RESEARCH_APPROVAL_REASON,
        });
      }
      expect(move(human, BEADS_PHASES.research, 'done', research)).toBeUndefined();
      expect(move(system, BEADS_PHASES.research, 'done', { ...research, beadsClosedOutside: 'done' })).toBeUndefined();
    });
  });

  describe('plan cards', () => {
    const plan = { beadsId: 'w-e', beadsCardKind: 'plan' };
    it('enter Proposing and Filing only', () => {
      expect(move(human, 'intake', BEADS_PHASES.epicPlan, plan)).toBeUndefined();
      for (const phase of ['planning', 'execute', 'pr-review', BEADS_PHASES.research]) {
        expect(move(human, 'intake', phase, plan)).toMatchObject({ type: 'reject', reason: PLAN_WORKING_REASON });
      }
    });
    it('enter Filing only by a person: that move is the approval', () => {
      for (const actor of machines) {
        expect(move(actor, BEADS_PHASES.epicPlan, BEADS_PHASES.epicFile, plan)).toMatchObject({
          code: 'approval_required',
          reason: PLAN_APPROVAL_REASON,
        });
      }
      expect(move(human, BEADS_PHASES.epicPlan, BEADS_PHASES.epicFile, plan)).toBeUndefined();
    });
    it('let the file run hand the card back to Intake', () => {
      expect(move(agent, BEADS_PHASES.epicFile, 'intake', plan)).toBeUndefined();
    });
    it('reach Done only by a person', () => {
      expect(move(agent, BEADS_PHASES.epicPlan, 'done', plan)).toMatchObject({ reason: PLAN_DONE_REASON });
      expect(move(human, BEADS_PHASES.epicPlan, 'done', plan)).toBeUndefined();
    });
  });

  describe('gate cards', () => {
    const gate = { beadsId: 'w-g', beadsCardKind: 'gate' };
    it('enter no working phase and reach Done only by a person or a close in bd', () => {
      for (const phase of workingPhases) {
        expect(move(human, 'intake', phase, gate)).toMatchObject({ reason: GATE_WORKING_REASON });
      }
      expect(move(system, 'intake', 'done', gate)).toMatchObject({ reason: GATE_APPROVAL_REASON });
      expect(move(system, 'intake', 'done', { ...gate, beadsClosedOutside: 'done' })).toBeUndefined();
      expect(move(human, 'intake', 'done', gate)).toBeUndefined();
    });
  });

  it('starts no work on a held bead, but lets a seated run finish its moves', () => {
    const held = { beadsId: 'w-1', beadsHeld: 'blocked' };
    expect(move(human, 'intake', 'planning', held)).toMatchObject({ type: 'reject', code: 'forbidden' });
    expect(move(agent, 'planning', 'execute', held)).toBeUndefined();
  });
});
