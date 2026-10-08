/**
 * GitHub rule overrides that let Requests-board cards follow their pull requests.
 *
 * WHY THIS EXISTS
 * The default GitHub rules in @mastra/factory 0.20.0 only move cards on the
 * built-in Work board:
 *
 *   pullRequestOpened  `if (context.board !== "work" ...) return;`  -> no move
 *                      (integrations/github/default-rules.js:113)
 *   pullRequestMerged  `board: "work", stage: "done"`  for any non-Review card
 *                      (integrations/github/default-rules.js:145-150)
 *
 * and a transition may not change a card's board
 * (rules/validation.js:76, `Factory transition cannot change the item board.`).
 * So a Requests card stayed in Building when its PR opened, and its merge
 * transition was rejected as a rule error.
 *
 * HOW
 * `GithubIntegration` takes `rules` overrides and merges them over the defaults
 * with `resolveGithubRules` (integrations/github/default-rules.js:279-288,
 * called at integrations/github/integration.js:264). The two overrides below
 * DELEGATE to the SDK's own handlers rather than copying them: for a Requests
 * card the default rule is evaluated as if the card were on Work (the stage
 * names it uses — `execute`, `review`, `done` — are the same on both boards),
 * and only a resulting Work transition is retargeted to the card's own board.
 * Every other card, including every Work card, gets the default rule's decision
 * untouched, so upstream changes to the PR rules still flow through.
 */

import type { GithubRuleOverrides } from '@mastra/factory';
import { defaultGithubRules } from '@mastra/factory/integrations/github/default-rules';
import type { FactoryGithubRuleContext, FactoryRuleDecision, FactoryRuleHandler } from '@mastra/factory/rules/types';

import { requestsBoard } from './requests-board';

type GithubRule = FactoryRuleHandler<FactoryGithubRuleContext>;

const WORK_BOARD = 'work';
const REQUESTS_BOARD: string = requestsBoard.id;

function retarget(decision: FactoryRuleDecision | void): FactoryRuleDecision | void {
  if (decision?.type === 'transition' && decision.board === WORK_BOARD) return { ...decision, board: REQUESTS_BOARD };
  return decision;
}

/** Runs a Work-only default rule for Requests cards too, keeping the card on its own board. */
export function onRequestsBoardToo(rule: GithubRule): GithubRule {
  return context => {
    if (context.board !== REQUESTS_BOARD) return rule(context);
    const decision = rule(Object.freeze({ ...context, board: WORK_BOARD }));
    return decision instanceof Promise ? decision.then(retarget) : retarget(decision);
  };
}

export const requestsGithubRules = {
  pullRequestOpened: onRequestsBoardToo(defaultGithubRules.pullRequestOpened),
  pullRequestMerged: onRequestsBoardToo(defaultGithubRules.pullRequestMerged),
} satisfies GithubRuleOverrides;
