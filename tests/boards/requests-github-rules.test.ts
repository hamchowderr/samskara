/**
 * Requests-board cards follow their pull requests (samskara-1ov).
 *
 * The default GitHub rules only move Work cards (integrations/github/
 * default-rules.js:113 and :145-150), and a transition may not change a card's
 * board (rules/validation.js:76). These tests drive the rules exactly as the
 * GitHub rule processor does (integrations/github/rules.js:402-412): read the
 * handler from `GithubIntegration.rules`, call it with a frozen context, then
 * run the decision through `validateFactoryRuleDecisions` and
 * `assertFactoryDecisionTarget` against the installed board registry.
 */
import { describe, expect, it } from 'vitest';
import { createBoardRegistry } from '@mastra/factory/boards';
import { GithubIntegration } from '@mastra/factory/integrations/github/integration';
import type { GithubEventRules } from '@mastra/factory/integrations/github/default-rules';
import { assertFactoryDecisionTarget, validateFactoryRuleDecisions } from '@mastra/factory/rules/validation';
import type { FactoryGithubEventName, FactoryGithubRuleContext } from '@mastra/factory/rules/types';

import { requestsBoard } from '../../src/mastra/boards/requests-board';
import { requestsGithubRules } from '../../src/mastra/boards/requests-github-rules';

// Same board set the app installs: defaults (Work, Review) plus Requests.
const boards = createBoardRegistry({ boards: [requestsBoard] });

function integration(rules?: typeof requestsGithubRules) {
  return new GithubIntegration({
    appId: '1',
    privateKey: 'test-key',
    clientId: 'client',
    clientSecret: 'secret',
    slug: 'samskara-test',
    ...(rules ? { rules } : {}),
  });
}

const PR = 7;

function context(event: FactoryGithubEventName, board: string, merged: boolean): FactoryGithubRuleContext {
  return {
    tenant: { orgId: 'org-1', projectId: 'proj-1' },
    actor: { type: 'github', login: 'maintainer', trusted: true, factoryAuthored: false },
    ingress: { type: 'github', id: `delivery-${event}-${board}` },
    cause: `github.${event}`,
    causalChain: [],
    configVersion: 'test',
    item: {
      id: `wi-${board}`,
      source: board === 'requests' ? 'manual' : 'github-issue',
      sourceKey: null,
      parentWorkItemId: null,
      title: 'A request',
      url: null,
      stages: [merged ? 'review' : 'execute'],
      acceptedAt: new Date(),
      metadata: null,
    },
    board,
    itemRevision: 1,
    event,
    deliveryId: `delivery-${event}`,
    factory: { createdAt: '2026-01-01T00:00:00.000Z' },
    repository: { id: 42, fullName: 'otaku/samskara', installationId: 9 },
    pullRequest: {
      number: PR,
      title: 'Fix it',
      url: `https://github.com/otaku/samskara/pull/${PR}`,
      state: merged ? 'closed' : 'open',
      draft: false,
      merged,
      factoryAuthored: true,
      headBranch: 'fix/it',
      baseBranch: 'main',
    },
  };
}

/** One rule evaluation, as integrations/github/rules.js:402-412 performs it. */
async function evaluate(rules: GithubEventRules, ctx: FactoryGithubRuleContext) {
  const rule = rules[ctx.event];
  const decision = rule ? await rule(Object.freeze(ctx)) : undefined;
  if (!decision) return undefined;
  return validateFactoryRuleDecisions([decision]).map(entry => {
    assertFactoryDecisionTarget(entry, boards, ctx.board);
    return entry;
  })[0];
}

const opened = (board: string) => context('pullRequestOpened', board, false);
const merged = (board: string) => context('pullRequestMerged', board, true);

describe('Requests cards follow their pull requests', () => {
  const rules = integration(requestsGithubRules).rules;

  it('moves a Requests card from Building to Review when its PR opens', async () => {
    expect(await evaluate(rules, opened('requests'))).toMatchObject({
      type: 'transition',
      board: 'requests',
      stage: 'review',
    });
  });

  it('moves a Requests card to Done when its PR merges', async () => {
    expect(await evaluate(rules, merged('requests'))).toMatchObject({
      type: 'transition',
      board: 'requests',
      stage: 'done',
    });
  });

  it('still files the Review card on PR intake for a Requests card', async () => {
    // Intake is board-agnostic upstream; the override must not retarget it.
    const decision = await evaluate(rules, { ...opened('requests'), pullRequestIntake: true });
    expect(decision).toMatchObject({ type: 'upsertLinkedWorkItem', board: 'review', source: 'github-pr' });
  });
});

describe('Work cards are unchanged', () => {
  const overridden = integration(requestsGithubRules).rules;
  const defaults = integration().rules;

  it('moves a Work card to Review when its PR opens', async () => {
    const decision = await evaluate(overridden, opened('work'));
    expect(decision).toMatchObject({ type: 'transition', board: 'work', stage: 'review' });
    expect(decision).toEqual(await evaluate(defaults, opened('work')));
  });

  it('moves a Work card to Done when its PR merges', async () => {
    const decision = await evaluate(overridden, merged('work'));
    expect(decision).toMatchObject({ type: 'transition', board: 'work', stage: 'done' });
    expect(decision).toEqual(await evaluate(defaults, merged('work')));
  });

  it('leaves Review cards to the default rule', async () => {
    const decision = await evaluate(overridden, merged('review'));
    expect(decision).toMatchObject({ type: 'transition', board: 'review', stage: 'done' });
    expect(decision).toEqual(await evaluate(defaults, merged('review')));
  });
});

describe('the defaults alone (why the override exists)', () => {
  const defaults = integration().rules;

  it('ignore a Requests card when its PR opens', async () => {
    expect(await evaluate(defaults, opened('requests'))).toBeUndefined();
  });

  it('reject the merge transition for a Requests card as a board change', async () => {
    await expect(evaluate(defaults, merged('requests'))).rejects.toThrow('cannot change the item board');
  });
});
