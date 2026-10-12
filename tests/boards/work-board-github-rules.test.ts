/**
 * The DEFAULT GitHub rules drive Samskara's board once it replaces Work by id.
 *
 * `requestsBoard` is installed as board `work` with `includeDefaultBoards:
 * false` (upstream #25595), so the default rules' `context.board === "work"`
 * guards (integrations/github/default-rules.js:69, :113, :155, :207) and their
 * `board: "work"` transitions (:75, :119, :148) apply to it unchanged — no rule
 * overrides. These tests drive the stock `GithubIntegration` rules exactly as
 * the GitHub rule processor does (integrations/github/rules.js:402-412): read
 * the handler, call it with a frozen context, then run the decision through
 * `validateFactoryRuleDecisions` and `assertFactoryDecisionTarget` against the
 * board registry the app installs.
 */
import { describe, expect, it } from 'vitest';
import { reviewBoard } from '@mastra/factory';
import { createBoardRegistry, withBoardClosure } from '@mastra/factory/boards';
import { GithubIntegration } from '@mastra/factory/integrations/github/integration';
import type { GithubEventRules } from '@mastra/factory/integrations/github/default-rules';
import { assertFactoryDecisionTarget, validateFactoryRuleDecisions } from '@mastra/factory/rules/validation';
import type { FactoryGithubEventName, FactoryGithubRuleContext } from '@mastra/factory/rules/types';

import { requestsBoard } from '../../src/mastra/boards/requests-board';

// Same board set the app installs (src/mastra/index.ts).
const boards = createBoardRegistry({ includeDefaultBoards: false, boards: [requestsBoard, reviewBoard] });

// Stock rules: no `rules` option, exactly as the app now constructs it.
const rules: GithubEventRules = new GithubIntegration({
  appId: '1',
  privateKey: 'test-key',
  clientId: 'client',
  clientSecret: 'secret',
  slug: 'samskara-test',
}).rules;

const PR = 7;
type Source = 'manual' | 'github-issue';

function context(
  event: FactoryGithubEventName,
  board: string,
  { merged = false, source = 'manual', stage }: { merged?: boolean; source?: Source; stage?: string } = {},
): FactoryGithubRuleContext {
  return {
    tenant: { orgId: 'org-1', projectId: 'proj-1' },
    actor: { type: 'github', login: 'maintainer', trusted: true, factoryAuthored: false },
    ingress: { type: 'github', id: `delivery-${event}-${board}` },
    cause: `github.${event}`,
    causalChain: [],
    configVersion: 'test',
    item: {
      id: `wi-${board}`,
      source,
      sourceKey: null,
      parentWorkItemId: null,
      title: 'A request',
      url: source === 'github-issue' ? 'https://github.com/otaku/samskara/issues/3' : null,
      stages: [stage ?? (merged ? 'review' : 'execute')],
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

/**
 * One rule evaluation, as integrations/github/rules.js performs it: the card's
 * board closure is added to the context from the installed boards first
 * (@mastra/factory 0.21.0 boards/semantics.js withBoardClosure).
 */
async function evaluate(ctx: FactoryGithubRuleContext) {
  const rule = rules[ctx.event];
  const item = ctx.item ? { board: ctx.board ?? null, externalSource: null, stages: ctx.item.stages } : undefined;
  const full = item ? { ...ctx, ...withBoardClosure(boards, item as never) } : ctx;
  const decision = rule ? await rule(Object.freeze(full)) : undefined;
  if (!decision) return undefined;
  return validateFactoryRuleDecisions([decision]).map(entry => {
    assertFactoryDecisionTarget(entry, boards, ctx.board);
    return entry;
  })[0];
}

describe('the installed Work board is ours', () => {
  it('replaces the built-in by id and keeps Review', () => {
    expect([...boards.keys()]).toEqual(['work', 'review']);
    expect(boards.get('work')).toBe(requestsBoard);
  });

  it('still refuses a same-id board while the defaults are installed', () => {
    expect(() => createBoardRegistry({ boards: [requestsBoard] })).toThrow("duplicate board id 'work'");
  });
});

describe('chat (manual) cards follow their pull requests', () => {
  it('move from Building to Review when the PR opens', async () => {
    expect(await evaluate(context('pullRequestOpened', 'work'))).toMatchObject({
      type: 'transition',
      board: 'work',
      stage: 'review',
    });
  });

  it('move to Done when the PR merges', async () => {
    expect(await evaluate(context('pullRequestMerged', 'work', { merged: true }))).toMatchObject({
      type: 'transition',
      board: 'work',
      stage: 'done',
    });
  });

  it('still file the Review card on PR intake', async () => {
    const decision = await evaluate({ ...context('pullRequestOpened', 'work'), pullRequestIntake: true });
    expect(decision).toMatchObject({ type: 'upsertLinkedWorkItem', board: 'review', source: 'github-pr' });
  });
});

describe('rules that were Work-only before (samskara-4r5) now reach these cards', () => {
  it('tell the builder about a changes-requested review', async () => {
    const ctx = {
      ...context('pullRequestReviewSubmitted', 'work', { stage: 'review' }),
      review: { id: 1, state: 'CHANGES_REQUESTED', url: 'https://github.com/otaku/samskara/pull/7#r1' },
    };
    expect(await evaluate(ctx)).toMatchObject({ type: 'sendMessage', role: 'work', priority: 'high' });
  });

  it('tell the builder about a PR comment', async () => {
    const ctx = {
      ...context('pullRequestCommentCreated', 'work', { stage: 'review' }),
      issueComment: { id: 2, body: 'Please rename this.', author: 'client' },
    };
    expect(await evaluate(ctx)).toMatchObject({ type: 'sendMessage', role: 'work' });
  });

  it('close a GitHub-issue card when its issue closes', async () => {
    const ctx = {
      ...context('issueClosed', 'work', { source: 'github-issue', stage: 'triage' }),
      issue: { number: 3, title: 'Bug', url: 'https://github.com/otaku/samskara/issues/3', stateReason: 'completed' },
    };
    expect(await evaluate(ctx)).toMatchObject({ type: 'transition', board: 'work', stage: 'done' });
  });
});

describe('Review cards are unchanged', () => {
  it('move to Done when the PR merges', async () => {
    expect(await evaluate(context('pullRequestMerged', 'review', { merged: true }))).toMatchObject({
      type: 'transition',
      board: 'review',
      stage: 'done',
    });
  });
});
