/**
 * The Requests board — Work's definition plus manual triage, installed as `work`.
 *
 * defineBoard() does not validate onEnter keys (dist/boards/define-board.js),
 * so a misspelled or retired source key compiles and silently never fires.
 * These tests are the validation it does not do.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workBoard } from '@mastra/factory';
import { validateFactoryRuleDecision } from '@mastra/factory/rules/validation';
import {
  DECISION_SKILL,
  EPIC_SKILL,
  PLAN_APPROVAL_REASON,
  PLAN_DONE_REASON,
  PLAN_WORKING_REASON,
  RESEARCH_APPROVAL_REASON,
  RESEARCH_WORKING_REASON,
} from '@samskara/factory-beads';
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

describe('beads research cards (samskara-l2t.2.3)', () => {
  const policy = requestsBoard.transitionPolicy!;
  const human: FactoryRuleActor = { type: 'human', id: 'u1' };
  const planAgent: FactoryRuleActor = { type: 'agent', bindingId: 'b-1', role: 'plan' };
  const workAgent: FactoryRuleActor = { type: 'agent', bindingId: 'b-2', role: 'work' };
  const system: FactoryRuleActor = { type: 'system', id: 'factory-tool-result-rule' };
  const research = { beadsId: 'w-d', beadsRepo: 'acme/widgets', beadsType: 'decision', beadsCardKind: 'research' };
  const autoApprove = { plansAutoApproved: true, planApproved: true };
  const label = (actor: FactoryRuleActor) => (actor.type === 'agent' ? `agent (${actor.role})` : actor.type);
  const move = (
    actor: FactoryRuleActor,
    fromStage: string,
    toStage: string,
    metadata: Record<string, unknown> | null = research,
    flags: Partial<Pick<BoardTransitionPolicyContext, 'planApproved' | 'plansAutoApproved'>> = {},
  ): BoardTransitionPolicyContext => ({
    tenant: { orgId: 'org-1', projectId: 'proj-1' },
    actor,
    ingress: { type: actor.type === 'human' ? 'human' : 'rule', id: 'ing-1' },
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
      sourceKey: 'beads:issue:w-d',
      parentWorkItemId: null,
      title: 'w-d: Which queue?',
      url: null,
      stages: [fromStage],
      acceptedAt: null,
      metadata,
      triageType: null,
    },
  });

  for (const actor of [human, planAgent, workAgent, system]) {
    for (const toStage of ['triage', 'execute', 'review']) {
      it(`rejects a ${label(actor)} moving a research card into ${toStage}, even with plans auto-approved`, async () => {
        for (const fromStage of ['intake', 'planning']) {
          expect(await policy(move(actor, fromStage, toStage, research, autoApprove))).toEqual({
            type: 'reject',
            code: 'forbidden',
            reason: RESEARCH_WORKING_REASON,
          });
        }
      });
    }
  }

  for (const actor of [planAgent, workAgent, system]) {
    it(`rejects a ${label(actor)} moving a research card to Done with approval_required, even with plans auto-approved`, async () => {
      for (const flags of [{}, autoApprove, { plansAutoApproved: true }]) {
        for (const fromStage of ['planning', 'intake']) {
          expect(await policy(move(actor, fromStage, 'done', research, flags))).toEqual({
            type: 'reject',
            code: 'approval_required',
            reason: RESEARCH_APPROVAL_REASON,
          });
        }
      }
    });
  }

  it('lets a person approve (Done) or cancel a research card, from Planning or Intake', async () => {
    for (const [from, to] of [['planning', 'done'], ['intake', 'done'], ['planning', 'canceled'], ['intake', 'canceled']] as const) {
      expect((await policy(move(human, from, to)))?.type, `${from} -> ${to}`).toBe('allow');
    }
  });

  it('lets a person move a research card into Planning, accepting it as Work does', async () => {
    const context = move(human, 'intake', 'planning');
    expect(await policy(context)).toEqual({ type: 'allow', accept: true });
    expect(await policy(context)).toEqual(await workBoard.transitionPolicy!(context));
  });

  it('leaves a decision card without the research kind to Work', async () => {
    const legacy = { beadsId: 'w-d', beadsType: 'decision' };
    for (const context of [move(planAgent, 'planning', 'execute', legacy), move(human, 'intake', 'triage', legacy), move(system, 'planning', 'done', legacy)]) {
      expect(await policy(context)).toEqual(await workBoard.transitionPolicy!(context));
    }
  });

  describe('Planning entry rule', () => {
    type Rule = (context: unknown) => unknown;
    const planning = board.phases.planning?.onEnter ?? {};
    const workPlanning = (workBoard as unknown as Board).phases.planning?.onEnter ?? {};
    const entry = (metadata: Record<string, unknown> | null, title = 'w-d: Which queue?') => ({
      ...move(human, 'intake', 'planning', metadata),
      stage: 'planning',
      ingress: { type: 'human', id: 'ing-7' },
      item: { id: 'wi-1', source: 'manual', sourceKey: null, parentWorkItemId: null, title, url: null, stages: ['intake'], acceptedAt: null, metadata },
    });

    it("keeps Work's planning rule for every other source", () => {
      for (const [source, handler] of Object.entries(workPlanning)) {
        if (source !== 'manual') expect(planning[source], source).toBe(handler);
      }
    });

    it('starts the factory-beads-decision skill on the plan seat for a research card', () => {
      const decision = (planning.manual as Rule)(entry(research));
      expect(decision).toEqual({
        type: 'invokeSkill',
        idempotencyKey: `ing-7:${DECISION_SKILL}`,
        role: 'plan',
        skillName: 'factory-beads-decision',
        arguments: 'Decision bead w-d in repository acme/widgets',
      });
      // Factory's own validation accepts it, as the transition service runs it.
      expect(() => validateFactoryRuleDecision(decision, 0)).not.toThrow();
    });

    it("returns Work's own planning decision for every other manual card", () => {
      for (const metadata of [null, { beadsId: 'w-1', beadsType: 'task' }, { beadsId: 'w-d', beadsType: 'decision' }]) {
        const context = entry(metadata, 'A request');
        expect((planning.manual as Rule)(context)).toEqual((workPlanning.manual as Rule)(context));
      }
      expect((planning.manual as Rule)(entry(null, 'A request'))).toMatchObject({ skillName: 'factory-plan', role: 'plan' });
    });

    it('runs the decision skill for any research-kind card, the same test the policy uses', () => {
      // The policy refuses a research card's move to execute, so factory-plan
      // would strand it; the kind alone decides, even without a bead id.
      expect((planning.manual as Rule)(entry({ beadsCardKind: 'research' }, 'A request'))).toMatchObject({
        skillName: DECISION_SKILL,
        role: 'plan',
      });
    });

    it('ships the skill where Factory loads project skills (dist/workspace.js:31), with parseable frontmatter', () => {
      const file = join(process.cwd(), 'src', 'mastra', 'public', 'factory-skills', DECISION_SKILL, 'SKILL.md');
      const text = readFileSync(file, 'utf8');
      const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
      expect(front).toMatch(new RegExp(`^name: ${DECISION_SKILL}$`, 'm'));
      const description = /^description: (.+)$/m.exec(front)?.[1] ?? '';
      expect(description.length).toBeGreaterThan(20);
      // An unquoted [...] value is a YAML flow sequence, not a string.
      expect(description.startsWith('[')).toBe(false);
    });
  });
});

describe('beads plan cards (samskara-l2t.2.4)', () => {
  const policy = requestsBoard.transitionPolicy!;
  const human: FactoryRuleActor = { type: 'human', id: 'u1' };
  const planAgent: FactoryRuleActor = { type: 'agent', bindingId: 'b-1', role: 'plan' };
  const workAgent: FactoryRuleActor = { type: 'agent', bindingId: 'b-2', role: 'work' };
  const system: FactoryRuleActor = { type: 'system', id: 'factory-tool-result-rule' };
  const plan = { beadsId: 'w-e', beadsRepo: 'acme/widgets', beadsType: 'epic', beadsCardKind: 'plan' };
  const autoApprove = { plansAutoApproved: true, planApproved: true };
  const label = (actor: FactoryRuleActor) => (actor.type === 'agent' ? `agent (${actor.role})` : actor.type);
  const move = (
    actor: FactoryRuleActor,
    fromStage: string,
    toStage: string,
    metadata: Record<string, unknown> | null = plan,
    flags: Partial<Pick<BoardTransitionPolicyContext, 'planApproved' | 'plansAutoApproved'>> = {},
  ): BoardTransitionPolicyContext => ({
    tenant: { orgId: 'org-1', projectId: 'proj-1' },
    actor,
    ingress: { type: actor.type === 'human' ? 'human' : 'rule', id: 'ing-1' },
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
      sourceKey: 'beads:issue:w-e',
      parentWorkItemId: null,
      title: 'w-e: An epic',
      url: null,
      stages: [fromStage],
      acceptedAt: null,
      metadata,
      triageType: null,
    },
  });

  for (const actor of [human, planAgent, workAgent, system]) {
    for (const toStage of ['triage', 'review']) {
      it(`rejects a ${label(actor)} moving a plan card into ${toStage}, even with plans auto-approved`, async () => {
        for (const fromStage of ['intake', 'planning', 'execute']) {
          expect(await policy(move(actor, fromStage, toStage, plan, autoApprove))).toEqual({
            type: 'reject',
            code: 'forbidden',
            reason: PLAN_WORKING_REASON,
          });
        }
      });
    }
  }

  for (const actor of [planAgent, workAgent, system]) {
    it(`rejects a ${label(actor)} moving a plan card into Building without a person's plan approval`, async () => {
      // planApproved with auto-approve on proves nothing: the dispatcher
      // answered submit_plan itself (rules/dispatcher.js:107-112).
      for (const flags of [{}, autoApprove, { plansAutoApproved: true }]) {
        for (const fromStage of ['planning', 'intake']) {
          expect(await policy(move(actor, fromStage, 'execute', plan, flags)), JSON.stringify({ fromStage, flags })).toEqual({
            type: 'reject',
            code: 'approval_required',
            reason: PLAN_APPROVAL_REASON,
          });
        }
      }
    });

    it(`rejects a ${label(actor)} moving a plan card into Building with planApproved from anywhere but Planning`, async () => {
      for (const fromStage of ['intake', 'execute']) {
        expect(await policy(move(actor, fromStage, 'execute', plan, { planApproved: true }))).toEqual({
          type: 'reject',
          code: 'approval_required',
          reason: PLAN_APPROVAL_REASON,
        });
      }
    });
  }

  it('lets the approved-plan move from Planning into Building through when plans are not auto-approved, as Work does', async () => {
    // A person pressed Approve: the processor stamps planApproved on the
    // system move Work's tool rule asked for (rules/processor.js:381-402).
    const context = move(system, 'planning', 'execute', plan, { planApproved: true });
    expect((await policy(context))?.type).toBe('allow');
    expect(await policy(context)).toEqual(await workBoard.transitionPolicy!(context));
  });

  it("follows the approved submit_plan path: Work's tool rule asks for Building, the policy allows it only with auto-approve off", async () => {
    // Work's tool rule turns an approved result into a move to Building
    // (work-tool-rules.js:8-16), and the processor stamps it planApproved as
    // actor system (rules/processor.js:381-402).
    const decision = board.tools?.submit_plan?.onResult({
      result: { status: 'success', value: 'Plan approved. Proceed with implementation following the approved plan.' },
      item: { stages: ['planning'], metadata: plan },
      actor: { type: 'agent', role: 'plan' },
      ingress: { id: 'ing-1' },
    }) as { stage: string } | undefined;
    expect(decision).toMatchObject({ type: 'transition', board: 'work', stage: 'execute' });
    // Auto-approve off: a person approved, so the move goes through.
    expect((await policy(move(system, 'planning', decision!.stage, plan, { planApproved: true })))?.type).toBe('allow');
    // Auto-approve on: the dispatcher approved it itself, so it is refused.
    expect(await policy(move(system, 'planning', decision!.stage, plan, { planApproved: true, plansAutoApproved: true }))).toEqual({
      type: 'reject',
      code: 'approval_required',
      reason: PLAN_APPROVAL_REASON,
    });
    // The same move of a work card passes either way, as before.
    for (const flags of [{ planApproved: true }, autoApprove]) {
      expect((await policy(move(system, 'planning', 'execute', { beadsId: 'w-1' }, flags)))?.type).toBe('allow');
    }
  });

  it('lets a person approve by moving a plan card into Building, accepting it as Work does', async () => {
    for (const fromStage of ['planning', 'intake']) {
      const context = move(human, fromStage, 'execute');
      expect(await policy(context)).toEqual({ type: 'allow', accept: true });
      expect(await policy(context)).toEqual(await workBoard.transitionPolicy!(context));
    }
  });

  it('lets the file run move its card from Building back to Intake', async () => {
    const context = move(workAgent, 'execute', 'intake');
    expect((await policy(context))?.type).toBe('allow');
    expect(await policy(context)).toEqual(await workBoard.transitionPolicy!(context));
  });

  it('lets a person move a plan card into Planning; Work decides that move for everyone', async () => {
    for (const actor of [human, planAgent]) {
      const context = move(actor, 'intake', 'planning');
      expect(await policy(context)).toEqual(await workBoard.transitionPolicy!(context));
    }
    expect((await policy(move(human, 'intake', 'planning')))?.type).toBe('allow');
  });

  for (const actor of [planAgent, workAgent, system]) {
    it(`rejects a ${label(actor)} moving a plan card to Done`, async () => {
      for (const fromStage of ['planning', 'execute', 'intake']) {
        expect(await policy(move(actor, fromStage, 'done', plan, autoApprove))).toEqual({
          type: 'reject',
          code: 'approval_required',
          reason: PLAN_DONE_REASON,
        });
      }
    });
  }

  it('lets a person move a plan card to Done or Canceled', async () => {
    for (const to of ['done', 'canceled']) expect((await policy(move(human, 'planning', to)))?.type, to).toBe('allow');
  });

  describe('phase entry rules', () => {
    type Rule = (context: unknown) => unknown;
    const planning = board.phases.planning?.onEnter ?? {};
    const execute = board.phases.execute?.onEnter ?? {};
    const work = workBoard as unknown as Board;
    const workPlanning = work.phases.planning?.onEnter ?? {};
    const workExecute = work.phases.execute?.onEnter ?? {};
    const entry = (stage: string, fromStage: string, metadata: Record<string, unknown> | null, title = 'w-e: An epic') => ({
      ...move(human, fromStage, stage, metadata),
      stage,
      ingress: { type: 'human', id: 'ing-9' },
      item: { id: 'wi-1', source: 'manual', sourceKey: null, parentWorkItemId: null, title, url: null, stages: [fromStage], acceptedAt: null, metadata },
    });

    it("keeps Work's planning and building rules for every other source", () => {
      for (const [phase, ours, theirs] of [
        ['planning', planning, workPlanning],
        ['execute', execute, workExecute],
      ] as const) {
        for (const [source, handler] of Object.entries(theirs)) {
          if (source !== 'manual') expect(ours[source], `${phase}.${source}`).toBe(handler);
        }
      }
    });

    it('starts the factory-beads-epic skill in propose mode on the plan seat when a plan card enters Planning', () => {
      const decision = (planning.manual as Rule)(entry('planning', 'intake', plan));
      expect(decision).toEqual({
        type: 'invokeSkill',
        idempotencyKey: `ing-9:${EPIC_SKILL}:propose`,
        role: 'plan',
        skillName: 'factory-beads-epic',
        arguments: 'Mode: propose. The epic bead w-e in repository acme/widgets',
      });
      expect(() => validateFactoryRuleDecision(decision, 0)).not.toThrow();
    });

    it('starts the factory-beads-epic skill in file mode on the work seat when a plan card enters Building', () => {
      const decision = (execute.manual as Rule)(entry('execute', 'planning', plan));
      expect(decision).toEqual({
        type: 'invokeSkill',
        idempotencyKey: `ing-9:${EPIC_SKILL}:file`,
        role: 'work',
        skillName: 'factory-beads-epic',
        arguments: 'Mode: file. The epic bead w-e in repository acme/widgets',
      });
      expect(() => validateFactoryRuleDecision(decision, 0)).not.toThrow();
    });

    it('leaves research cards to the decision skill and every other card to Work', () => {
      const research = { beadsId: 'w-d', beadsRepo: 'acme/widgets', beadsCardKind: 'research' };
      expect((planning.manual as Rule)(entry('planning', 'intake', research))).toMatchObject({ skillName: DECISION_SKILL, role: 'plan' });
      for (const metadata of [null, { beadsId: 'w-1', beadsType: 'task' }, { beadsId: 'w-e', beadsType: 'epic', beadsCardKind: 'overview' }]) {
        for (const [stage, ours, theirs] of [
          ['planning', planning, workPlanning],
          ['execute', execute, workExecute],
        ] as const) {
          const context = entry(stage, 'planning', metadata, 'A request');
          expect((ours.manual as Rule)(context), `${stage} ${JSON.stringify(metadata)}`).toEqual((theirs.manual as Rule)(context));
        }
      }
      expect((execute.manual as Rule)(entry('execute', 'planning', null, 'A request'))).toMatchObject({ role: 'work', idempotencyKey: 'ing-9:build' });
    });

    it('ships the skill where Factory loads project skills (dist/workspace.js:31), with parseable frontmatter', () => {
      const file = join(process.cwd(), 'src', 'mastra', 'public', 'factory-skills', EPIC_SKILL, 'SKILL.md');
      const text = readFileSync(file, 'utf8');
      const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
      expect(front).toMatch(new RegExp(`^name: ${EPIC_SKILL}$`, 'm'));
      const description = /^description: (.+)$/m.exec(front)?.[1] ?? '';
      expect(description.length).toBeGreaterThan(20);
      expect(description.startsWith('[')).toBe(false);
      // Both modes, and the rule that read content is data, not instructions.
      expect(text).toMatch(/## Propose mode/);
      expect(text).toMatch(/## File mode/);
      expect(text).toMatch(/untrusted data/);
      // Approval is Factory's native plan approval: propose mode submits a
      // plan file the Factory UI can load (an `.artifacts/` path).
      const propose = /## Propose mode([\s\S]*?)## File mode/.exec(text)?.[1] ?? '';
      expect(propose).toMatch(/`submit_plan`/);
      expect(propose).toMatch(/`\.artifacts\/plans\/<epic id>\.md`/);
    });
  });
});
