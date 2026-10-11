/**
 * Test harness: an in-memory stand-in for the slice of Factory the integration
 * touches (work items, boards, source-control storage, auth), a real local git
 * repository as the clone source, and the scripted fake bd.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { IntegrationContext } from '@mastra/factory/integrations/base';
import { SourceControlConnectionNotFoundError } from '@mastra/factory/storage/domains/source-control/base';
import { applyStageTransition, validateParentRelation, WorkItemClaimConflictError } from '@mastra/factory/storage/domains/work-items/base';
import type {
  CommitFactoryRuleEvaluationInput,
  CommitFactoryRuleEvaluationResult,
  CreateWorkItemInput,
  ExternalWorkItemSource,
  FactoryRunBindingRecord,
  WorkItemRow,
} from '@mastra/factory/storage/domains/work-items/base';
import type { BoardTransitionPolicy } from '@mastra/factory/boards';

import { requestsBoard } from '../../../src/mastra/boards/requests-board';
import { BdRunner, BeadsIntegration } from '../src/index';
import type { BeadsIntegrationOptions } from '../src/index';

export const FAKE_BD = fileURLToPath(new URL('./fixtures/fake-bd.mjs', import.meta.url));
export const TOKEN = 'ghs_testInstallationToken0123456789';
export const ORG = 'org_1';
export const PROJECT = 'proj_1';
export const SLUG = 'acme/widgets';

export interface FakeBead {
  id: string;
  title: string;
  status?: string;
  priority?: number;
  issue_type?: string;
  /** A gate bead's condition type (bd's `await_type`). */
  await_type?: string;
  /** A deferred bead's wake time (bd's `defer_until`). */
  deferUntil?: string;
  description?: string;
  blockedBy?: string[];
  /** bd refuses to close a bead held by anyone but the closing actor. */
  assignee?: string;
  closeReason?: string | null;
  /** Only this repository's copy lists the bead (slug). Unset: every linked repository does. */
  repo?: string;
  /** The parent bead (a parent-child edge), as bd's `parent` field. */
  parent?: string;
  labels?: string[];
  /** bd list's `comment_count`. */
  commentCount?: number;
  /** `bd comments add` writes here; its length is `comment_count` (fake-bd.mjs). */
  comments?: Array<{ id: string; issue_id: string; author: string; text: string; created_at: string }>;
  /** bd's `updated_at`; the fake sets it on close and update. Default 2026-01-01. */
  updatedAt?: string;
  /** `bd supersede <id> --with <new>`: a `supersedes` edge to the replacement. */
  supersededBy?: string;
  /** `bd duplicate <id> --of <canonical>`: a `duplicates` edge to the canonical bead. */
  duplicateOf?: string;
}

export interface FakeState {
  beads: FakeBead[];
  syncExits: number[];
  pullExits: number[];
  closeFail: string[];
  /** A writable `bd ready` (the snooze wake) commits its wake, then exits 1. */
  wakeFail?: boolean;
  /** Bead ids whose `--if-assignee` reassign fails as if the holder changed (exit 13). */
  casFail?: string[];
  /** The refresh read (`bd list` without --parent) fails: always (true), or this many more times. */
  listFail?: boolean | number;
  calls: Array<{
    argv: string[];
    cwd: string;
    env: {
      token: string | null;
      remoteInfoBranch: string | null;
      /** [BD_DISABLE_METRICS, BD_DISABLE_EVENT_FLUSH] as the fake bd saw them. */
      metrics: [string | null, string | null];
      gitConfig: Record<string, string>;
      serverSecret: string | null;
    };
  }>;
}

/** One committed rule evaluation, and the dispatcher's record of each of its decisions (by index). */
export interface RecordedEvaluation {
  input: CommitFactoryRuleEvaluationInput;
  result: Record<string, unknown> & { status: 'accepted' | 'rejected'; itemId: string | null; code: string | null; decisions: Record<string, unknown>[] };
  dispatch: Record<number, { attempts: number; status: 'pending' | 'succeeded' | 'failed' }>;
}

/** The dispatcher's attempt limit for one decision (@mastra/factory 0.20.0 rules/dispatcher.js:19). */
export const MAX_DISPATCH_ATTEMPTS = 5;

/** What one dispatcher pass did with one transition decision. */
export type AppliedTransition =
  | { workItemId: string; stage: string; outcome: 'moved' | 'inert' }
  | {
      workItemId: string;
      stage: string;
      outcome: 'rejected';
      code: string;
      reason: string;
      /** This decision's attempt number, 1-based. */
      attempt: number;
      /** The stored result of an earlier attempt, not a fresh evaluation. */
      replayed: boolean;
      /** The last attempt: the decision failed for good. */
      failed: boolean;
    };

type TransitionResult = { status: 'accepted'; moved: boolean } | { status: 'rejected'; code: string; reason: string };

type PhaseHandler = (context: never) => unknown;

/** The slice of a BoardDefinition the stand-in dispatcher reads. */
export interface HarnessBoard {
  id: string;
  phases: Record<string, { kind?: string; onEnter?: Record<string, PhaseHandler | undefined>; onExit?: Record<string, PhaseHandler | undefined> }>;
  transitionPolicy?: BoardTransitionPolicy;
  allowsTransition(from: string, to: string): boolean;
}

export interface ApplyOptions {
  /** Default: the Requests board this project installs. */
  board?: HarnessBoard;
  /** The project's auto-approve-plans setting, as the policy snapshot carries it. Default false. */
  plansAutoApproved?: boolean;
}

/** A minimal WorkItemsStorage: the calls the integration makes, with the real semantics it relies on. */
export class MemoryWorkItems {
  items: WorkItemRow[] = [];
  #seq = 0;

  async list({ orgId, factoryProjectId }: { orgId: string; factoryProjectId: string }) {
    return this.items.filter(i => i.orgId === orgId && i.factoryProjectId === factoryProjectId).map(i => structuredClone(i));
  }

  async getByProjectSource({ orgId, factoryProjectId, source }: { orgId: string; factoryProjectId: string; source: ExternalWorkItemSource }) {
    const hit = this.items.find(
      i =>
        i.orgId === orgId &&
        i.factoryProjectId === factoryProjectId &&
        i.externalSource?.integrationId === source.integrationId &&
        i.externalSource?.type === source.type &&
        i.externalSource?.externalId === source.externalId,
    );
    return hit ? structuredClone(hit) : null;
  }

  async upsert({ orgId, userId, factoryProjectId, input }: { orgId: string; userId: string; factoryProjectId: string; input: CreateWorkItemInput }) {
    const existing = input.externalSource
      ? await this.getByProjectSource({ orgId, factoryProjectId, source: input.externalSource })
      : null;
    if (existing) return { item: existing, created: false, previous: { stages: existing.stages, sessionRoles: [] } };
    const claimant = input.claimKey ? this.items.find(i => i.orgId === orgId && i.claimKey === input.claimKey) : undefined;
    if (claimant) throw new WorkItemClaimConflictError(claimant);
    // Factory's own check: the parent must be a card in the same project (work-items/base.js:318-332, :2484).
    validateParentRelation(
      this.items.filter(i => i.orgId === orgId && i.factoryProjectId === factoryProjectId),
      undefined,
      input.parentWorkItemId ?? null,
    );
    const now = new Date();
    const item = {
      id: `card_${++this.#seq}`,
      orgId,
      factoryProjectId,
      board: input.board ?? 'work',
      externalSource: input.externalSource ?? null,
      claimKey: input.claimKey ?? null,
      parentWorkItemId: input.parentWorkItemId ?? null,
      title: input.title,
      stages: input.stages ?? ['intake'],
      // As Factory stamps it on create (work-items/base.js:2291).
      stageHistory: applyStageTransition([], [], input.stages ?? ['intake'], userId, now),
      sessions: {},
      metadata: input.metadata ?? null,
      triageType: null,
      autonomyArmedAt: null,
      plansPreapprovedAt: null,
      acceptedAt: null,
      commentCount: 0,
      feedActivityAt: null,
      revision: 1,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    } as unknown as WorkItemRow;
    this.items.push(item);
    return { item: structuredClone(item), created: true, previous: { stages: [], sessionRoles: [] } };
  }

  async update({ orgId, id, patch }: { orgId: string; id: string; userId: string; patch: { stages?: string[]; title?: string; metadata?: Record<string, unknown> | null } }) {
    const item = this.items.find(i => i.orgId === orgId && i.id === id);
    if (!item) return null;
    // Same merge as WorkItemsStorage.applyUpdate (work-items/base.js:379-382).
    if (patch.title !== undefined) item.title = patch.title;
    if (patch.metadata !== undefined) item.metadata = patch.metadata === null ? null : { ...(item.metadata ?? {}), ...patch.metadata };
    if (patch.stages) {
      item.stageHistory = applyStageTransition(item.stageHistory, item.stages, patch.stages, 'test', new Date());
      item.stages = patch.stages;
    }
    item.revision++;
    return { item: structuredClone(item), previous: { stages: [], sessionRoles: [] } };
  }

  async getByClaimKey({ orgId, claimKey }: { orgId: string; claimKey: string }) {
    const hit = this.items.find(i => i.orgId === orgId && i.claimKey === claimKey);
    return hit ? structuredClone(hit) : null;
  }

  /**
   * As WorkItemsStorage.claimWorkItem (work-items/base.js:1232-1256): the card
   * takes the claim unless another card in the org holds it or the card
   * carries a different one; null then. Taking it bumps no revision here.
   */
  async claimWorkItem({ orgId, id, claimKey }: { orgId: string; id: string; claimKey: string }) {
    const holder = this.items.find(i => i.orgId === orgId && i.claimKey === claimKey);
    if (holder && holder.id !== id) return null;
    const item = this.items.find(i => i.orgId === orgId && i.id === id);
    if (!item) return null;
    if (item.claimKey !== null && item.claimKey !== claimKey) return null;
    item.claimKey = claimKey;
    return structuredClone(item);
  }

  /** Cards whose claim Factory dropped: a move into a terminal phase releases it (work-items/base.js:911-920). */
  releaseClaimIfTerminal(item: WorkItemRow, board: HarnessBoard) {
    if (board.phases[item.stages[0]!]?.kind === 'terminal' && item.stages.length === 1) item.claimKey = null;
  }

  /** As WorkItemsStorage.setParentWorkItemIfMissing (work-items/base.js:2512-2530): a set parent is kept. */
  async setParentWorkItemIfMissing({ orgId, id, parentWorkItemId }: { orgId: string; id: string; userId: string; parentWorkItemId: string }) {
    const item = this.items.find(i => i.orgId === orgId && i.id === id);
    if (!item) return null;
    if (item.parentWorkItemId !== null) return structuredClone(item);
    validateParentRelation(
      this.items.filter(i => i.orgId === orgId && i.factoryProjectId === item.factoryProjectId),
      item.id,
      parentWorkItemId,
    );
    item.parentWorkItemId = parentWorkItemId;
    item.revision++;
    return structuredClone(item);
  }

  /**
   * Every rule evaluation committed, as WorkItemsStorage.commitRuleEvaluation
   * stores it (@mastra/factory 0.20.0 storage/domains/work-items/base.js:1424-1537):
   * a seen identity replays, a missing card is `missing`, and an expected
   * revision that is not the card's is stored as rejected (`stale`) with no
   * decisions.
   */
  evaluations: RecordedEvaluation[] = [];

  async commitRuleEvaluation(input: CommitFactoryRuleEvaluationInput): Promise<CommitFactoryRuleEvaluationResult> {
    const prior = this.evaluations.find(
      e => e.input.orgId === input.orgId && e.input.factoryProjectId === input.factoryProjectId && e.input.ingress.identity === input.ingress.identity,
    );
    if (prior) return { status: 'replayed', result: structuredClone(prior.result) };
    const item = input.workItemId
      ? this.items.find(i => i.id === input.workItemId && i.orgId === input.orgId && i.factoryProjectId === input.factoryProjectId)
      : undefined;
    if (input.workItemId !== null && !item) return { status: 'missing' };
    const stale = item !== undefined && item.revision !== input.expectedRevision;
    const status = stale ? 'rejected' : input.outcome.status;
    const result = {
      status,
      itemId: item?.id ?? null,
      revision: item?.revision ?? null,
      code: stale ? 'stale' : (input.outcome.code ?? null),
      reason: stale ? 'The work item changed before this rule evaluation committed.' : (input.outcome.reason ?? null),
      decisions: status === 'accepted' ? structuredClone(input.decisions) : [],
    };
    this.evaluations.push({ input: structuredClone(input), result, dispatch: {} });
    return { status: 'committed', result: structuredClone(result) };
  }

  /**
   * Factory's dispatcher and transition service as far as a committed
   * `transition` decision goes (@mastra/factory 0.20.0). Each call is one
   * dispatcher pass over every decision not yet settled:
   *
   *   - The decision is one transition request with ingress identity
   *     `decision:<idempotencyKey>`, actor system (rules/dispatcher.js:507-534).
   *   - A request whose identity has a stored result gets that result back,
   *     not a fresh evaluation (transition-service.js:129-130): a refused
   *     move stays refused on every retry, whatever changed since.
   *   - Otherwise it is evaluated as the transition service does: the card
   *     must exist and sit in one phase, the board must allow the move
   *     (`allowsTransition`, transition-service.js:198-202), then the board's
   *     `transitionPolicy` decides (:245-262), with Factory's snapshot
   *     fields. On acceptance the phases' `onExit`/`onEnter` handlers for the
   *     card's source run (rules/resolve.js:2-19: none for a move to the
   *     current phase, which is inert) and the card moves.
   *   - A refusal fails the decision; it is retried up to MAX_ATTEMPTS (5)
   *     times, then fails for good (dispatcher.js:19,39-41,429-440).
   *
   * Beads cards classify as `manual` (integration.ts header), so `manual`
   * handlers are the ones run. The default board is the Requests board this
   * project installs (src/mastra/boards/requests-board.ts): Work's own policy
   * wrapped by createBeadsTransitionPolicy, and its Done handler, which wakes
   * every live beads integration.
   */
  async applyDecisions(options: ApplyOptions = {}): Promise<AppliedTransition[]> {
    const board = options.board ?? (requestsBoard as unknown as HarnessBoard);
    const out: AppliedTransition[] = [];
    for (const evaluation of this.evaluations) {
      for (const [index, decision] of (evaluation.result.decisions as Array<Record<string, unknown>>).entries()) {
        if (decision.type !== 'transition') continue;
        const state = (evaluation.dispatch[index] ??= { attempts: 0, status: 'pending' });
        if (state.status !== 'pending') continue;
        state.attempts++;
        const identity = `decision:${String(decision.idempotencyKey)}`;
        const stage = String(decision.stage);
        const prior = this.transitionResults.get(identity);
        const result = prior ?? (await this.#transition(board, String(evaluation.result.itemId), stage, identity, options));
        if (!prior) this.transitionResults.set(identity, result);
        const base = { workItemId: String(evaluation.result.itemId), stage };
        if (result.status === 'accepted') {
          state.status = 'succeeded';
          out.push({ ...base, outcome: result.moved ? 'moved' : 'inert' });
          continue;
        }
        if (state.attempts >= MAX_DISPATCH_ATTEMPTS) state.status = 'failed';
        out.push({
          ...base,
          outcome: 'rejected',
          code: result.code,
          reason: result.reason,
          attempt: state.attempts,
          replayed: prior !== undefined,
          failed: state.status === 'failed',
        });
      }
    }
    return out;
  }

  /** Stored transition results by ingress identity, as getTransitionResultByIngress reads them. */
  transitionResults = new Map<string, TransitionResult>();

  async #transition(board: HarnessBoard, itemId: string, stage: string, identity: string, options: ApplyOptions): Promise<TransitionResult> {
    const item = this.items.find(i => i.id === itemId);
    if (!item) return { status: 'rejected', code: 'invalid_transition', reason: 'Work item not found.' };
    const fromStage = item.stages.length === 1 ? item.stages[0]! : undefined;
    if (!fromStage || !(fromStage in board.phases)) {
      return { status: 'rejected', code: 'invalid_transition', reason: 'The work item does not have one canonical phase on the requested board.' };
    }
    if (!(stage in board.phases) || !board.allowsTransition(fromStage, stage)) {
      return { status: 'rejected', code: 'invalid_transition', reason: `The board does not allow moving from ${fromStage} to ${stage}.` };
    }
    const snapshot = {
      tenant: { orgId: item.orgId, projectId: item.factoryProjectId },
      actor: { type: 'system', id: 'factory-rule-dispatcher' },
      ingress: { type: 'rule', id: identity },
      cause: 'rule_decision',
      causalChain: [],
      configVersion: 'test',
      board: board.id,
      fromStage,
      toStage: stage,
      source: 'manual',
      initialEntry: false,
      reenter: false,
      itemRevision: item.revision,
      isHumanTransition: false,
      plansAutoApproved: options.plansAutoApproved ?? false,
      planApproved: false,
      item: {
        id: item.id,
        source: 'manual',
        sourceKey: null,
        parentWorkItemId: item.parentWorkItemId,
        title: item.title,
        url: null,
        stages: [...item.stages],
        acceptedAt: item.acceptedAt,
        metadata: structuredClone(item.metadata),
        triageType: item.triageType,
      },
    };
    const policy = await board.transitionPolicy?.(snapshot as unknown as Parameters<BoardTransitionPolicy>[0]);
    if (policy?.type === 'reject') return { status: 'rejected', code: policy.code, reason: policy.reason };
    if (fromStage === stage) return { status: 'accepted', moved: false };
    for (const handler of [board.phases[fromStage]?.onExit?.manual, board.phases[stage]?.onEnter?.manual]) {
      const decision = (await handler?.({ ...snapshot, stage } as never)) as { type?: string; code?: string; reason?: string } | undefined;
      if (decision?.type === 'reject') return { status: 'rejected', code: String(decision.code), reason: String(decision.reason) };
    }
    item.stageHistory = applyStageTransition(item.stageHistory, item.stages, [stage], 'factory-rule-dispatcher', new Date());
    item.stages = [stage];
    item.revision++;
    this.releaseClaimIfTerminal(item, board);
    return { status: 'accepted', moved: true };
  }

  /**
   * Run bindings, as WorkItemsStorage.listRunBindings returns them
   * (storage/domains/work-items/base.d.ts:730, base.js): a test adds rows.
   */
  runBindings: FactoryRunBindingRecord[] = [];

  async listRunBindings(orgId: string, factoryProjectId: string, workItemId?: string) {
    return this.runBindings
      .filter(b => b.orgId === orgId && b.factoryProjectId === factoryProjectId && (workItemId === undefined || b.workItemId === workItemId))
      .map(b => structuredClone(b));
  }

  /**
   * Deferred decisions the dispatcher holds, as listDeferredDecisionPage
   * returns them (storage/domains/work-items/base.js:1581-1595): newest
   * first, filtered by status, one page. A test adds rows.
   */
  deferredDecisions: Array<{ id: string; workItemId: string | null; status: string; decision: Record<string, unknown>; createdAt: Date }> = [];

  async listDeferredDecisionPage(input: { orgId: string; factoryProjectId: string; statuses?: string[]; limit: number }) {
    const rows = this.deferredDecisions
      .filter(d => !input.statuses || input.statuses.includes(d.status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return { decisions: rows.slice(0, input.limit).map(d => structuredClone(d)), hasMore: rows.length > input.limit };
  }

  /** Simulates the board moving a card (the transition API's job, not ours). */
  move(id: string, phase: string) {
    const item = this.items.find(i => i.id === id)!;
    // Stage history as Factory keeps it (work-items/base.js:338-356): one entry per phase entered.
    item.stageHistory = applyStageTransition(item.stageHistory, item.stages, [phase], 'user_test', new Date());
    item.stages = [phase];
    this.releaseClaimIfTerminal(item, requestsBoard as unknown as HarnessBoard);
  }

  beadCards() {
    return this.items.filter(i => i.externalSource?.integrationId === 'beads');
  }
}

export interface FeedComment {
  id: string;
  orgId: string;
  factoryProjectId: string;
  workItemId: string;
  author: { kind: string; id: string; displayName?: string };
  body: string;
  externalSource: ExternalWorkItemSource | null;
  /** Set at create from the ingest source and never changed by a publish (comments/base.js:441-452). */
  sourceKey: string | null;
  occurredAt: Date;
  deletedAt: Date | null;
  createdAt: Date;
}

/** Factory's outbound seam (`WorkItemFeedPublisher`), as the fake feed calls it. */
export interface FakePublisher {
  id: string;
  publish(comment: FeedComment, workItem: WorkItemRow): Promise<{ source: ExternalWorkItemSource } | null>;
}

/**
 * The `feed` slice integrations get (`Pick<CommentsDomain, 'createComment'>`),
 * with the semantics the integration relies on (@mastra/factory 0.20.0):
 * body policy (comments/base.js:37-40), unknown work item
 * (comments/domain.js:49-53), and the externalSource replay that returns the
 * existing row as `created` (comments/base.js:180-191, domain.js:94-99).
 * The replay matches the source key set at create, which a publish never
 * changes: a published web comment keeps no key of its platform
 * (base.js:434-452). `publishers` are offered every new comment except on
 * its own platform, and a published source is attached (domain.js:108-131).
 */
export class MemoryFeed {
  comments: FeedComment[] = [];
  calls = 0;
  publishers: FakePublisher[] = [];
  #seq = 0;
  constructor(private readonly workItems: MemoryWorkItems) {}

  async createComment(input: {
    orgId: string;
    workItemId: string;
    author: FeedComment['author'];
    body: string;
    externalSource?: ExternalWorkItemSource;
    occurredAt?: Date;
  }) {
    this.calls++;
    if (!input.body.trim()) return { status: 'invalid' as const, message: 'Comment body must not be empty.' };
    if (input.body.length > 16_000) return { status: 'invalid' as const, message: 'Comment body must be at most 16000 characters.' };
    const workItem = this.workItems.items.find(i => i.orgId === input.orgId && i.id === input.workItemId);
    if (!workItem) return { status: 'work_item_not_found' as const };
    const key = (s: ExternalWorkItemSource) => `${s.integrationId}:${s.type}:${s.externalId}`;
    const replay = input.externalSource
      ? this.comments.find(
          c =>
            c.orgId === input.orgId &&
            c.factoryProjectId === workItem.factoryProjectId &&
            c.sourceKey === key(input.externalSource!),
        )
      : undefined;
    if (replay) return { status: 'created' as const, comment: structuredClone(replay), workItem, mirrored: Promise.resolve() };
    const comment: FeedComment = {
      id: `comment_${++this.#seq}`,
      orgId: input.orgId,
      factoryProjectId: workItem.factoryProjectId,
      workItemId: input.workItemId,
      author: input.author,
      body: input.body,
      externalSource: input.externalSource ?? null,
      sourceKey: input.externalSource ? key(input.externalSource) : null,
      occurredAt: input.occurredAt ?? new Date(),
      deletedAt: null,
      createdAt: new Date(),
    };
    this.comments.push(comment);
    return { status: 'created' as const, comment: structuredClone(comment), workItem, mirrored: this.#mirror(comment, workItem) };
  }

  async #mirror(comment: FeedComment, workItem: WorkItemRow): Promise<void> {
    for (const publisher of this.publishers) {
      if (comment.externalSource?.integrationId === publisher.id) continue;
      try {
        const published = await publisher.publish(structuredClone(comment), workItem);
        // First platform wins (comments/base.js:441).
        if (published && !comment.externalSource) comment.externalSource = published.source;
      } catch {
        // Factory logs a failed publish and never fails the create.
      }
    }
  }

  /** `attachExternalSource`: the first platform wins and the source key never changes (comments/base.js:434-452). */
  async attachExternalSource(input: { orgId: string; commentId: string; source: ExternalWorkItemSource }) {
    const row = this.comments.find(c => c.orgId === input.orgId && c.id === input.commentId);
    if (!row) return null;
    if (!row.externalSource) row.externalSource = input.source;
    return structuredClone(row);
  }

  /** Page size of `list`; Factory's is at most 100 (comments/base.js:42). */
  pageSize = 100;

  /** `WorkItemCommentsStorage.list`: every row, deleted ones included, newest first, paged by `before`. */
  async list(input: { orgId: string; workItemId: string; limit?: number; before?: string }) {
    const all = this.comments
      .filter(c => c.orgId === input.orgId && c.workItemId === input.workItemId)
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || (a.id < b.id ? 1 : -1));
    const start = input.before ? all.findIndex(c => c.id === input.before) + 1 : 0;
    const size = Math.min(input.limit ?? this.pageSize, this.pageSize);
    const page = all.slice(start, start + size);
    return {
      comments: page.map(c => structuredClone(c)),
      ...(start + size < all.length ? { nextCursor: page.at(-1)!.id } : {}),
    };
  }

  on(workItemId: string) {
    return this.comments.filter(c => c.workItemId === workItemId);
  }
}

/** Source-control rows the fake handle serves; tests mutate it to add projects and links. */
export interface FakeSourceControl {
  projects: Array<{ id: string; orgId: string }>;
  installations: Set<string>;
  connections: Array<{ id: string; factoryProjectId: string; installationId: string; repositoryIds: string[] }>;
  repositories: Map<string, string>;
}

/**
 * The slice of Factory's agent controller that LiveSessions listens to
 * (@mastra/factory 0.20.0 dist/session/live-sessions.js): session created and
 * deleted notifications. A test materializes a session and sets whether it
 * runs a turn or is parked on a tool.
 */
export class FakeController {
  #created = new Set<(session: unknown) => void>();
  #deleted = new Set<(session: unknown) => void>();
  onSessionCreated(listener: (session: unknown) => void) {
    this.#created.add(listener);
    return () => this.#created.delete(listener);
  }
  onSessionDeleted(listener: (session: unknown) => void) {
    this.#deleted.add(listener);
    return () => this.#deleted.delete(listener);
  }
  /** Materialize a session; the returned handle sets its state. */
  session(id: string) {
    const state = { running: false, parkedOn: undefined as string | undefined };
    const session = {
      identity: { getId: () => id },
      run: { isRunning: () => state.running },
      state: { get: () => ({ factoryOrgId: ORG, factoryProjectId: PROJECT }) },
      displayState: {
        get: () => ({ pendingSuspensions: new Map(state.parkedOn ? [['call_1', { toolName: state.parkedOn }]] : []) }),
      },
      subscribe: () => () => undefined,
    };
    for (const listener of this.#created) listener(session);
    return {
      state,
      delete: () => {
        for (const listener of this.#deleted) listener(session);
      },
    };
  }
}

export interface Harness {
  dir: string;
  remote: string;
  cacheDir: string;
  statePath: string;
  workItems: MemoryWorkItems;
  feed: MemoryFeed;
  sourceControl: FakeSourceControl;
  controller: FakeController;
  ctx: IntegrationContext;
  state(): FakeState;
  setState(update: (s: FakeState) => void): void;
  /** Add or delete refs/dolt/data on the remote. */
  setBeadsData(present: boolean): void;
  /** Run the fake bd as a person would, outside the Factory (e.g. `supersede x --with y`). Throws on a non-zero exit. */
  bd(...args: string[]): void;
  integration(options?: Partial<BeadsIntegrationOptions>): BeadsIntegration;
  cleanup(): void;
}

export function createHarness(beads: FakeBead[]): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'factory-beads-test-'));
  const remote = join(dir, 'remote');
  execFileSync('git', ['init', '-q', '-b', 'main', remote]);
  writeFileSync(join(remote, 'README.md'), 'fixture\n');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', remote, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  // A beads repository publishes its Dolt data here; the integration checks it with git ls-remote.
  git('update-ref', 'refs/dolt/data', 'HEAD');

  const statePath = join(dir, 'fake-bd-state.json');
  const initial: FakeState = { beads, syncExits: [], pullExits: [], closeFail: [], calls: [] };
  writeFileSync(statePath, JSON.stringify(initial));

  const workItems = new MemoryWorkItems();
  const feed = new MemoryFeed(workItems);
  // The board this project installs as `work`: Work's phases, kinds and roles.
  const board = requestsBoard;
  const sourceControl: FakeSourceControl = {
    projects: [{ id: PROJECT, orgId: ORG }],
    installations: new Set(['inst_1']),
    connections: [{ id: 'conn_1', factoryProjectId: PROJECT, installationId: 'inst_1', repositoryIds: ['repo_1'] }],
    repositories: new Map([['repo_1', SLUG]]),
  };
  // Mirrors SourceControlStorage.forIntegration (@mastra/factory 0.20.0
  // storage/domains/source-control/base.js): connections.list does not check the
  // installation, connections.get returns null without it, and
  // projectRepositories.list throws SourceControlConnectionNotFoundError.
  // Rows carry the fields Factory's own resolveWorkItemRepository reads
  // (session/work-item-repository.js:11-27): a connection's integrationId, a
  // link's id, a repository's externalId and slug.
  const liveConnection = (id: string) => {
    const c = sourceControl.connections.find(x => x.id === id);
    return c && sourceControl.installations.has(c.installationId) ? c : null;
  };
  const sourceControlHandle = {
    integrationId: 'github',
    connections: {
      list: async ({ factoryProjectId }: { factoryProjectId: string }) =>
        sourceControl.connections
          .filter(c => c.factoryProjectId === factoryProjectId)
          .map(c => ({ id: c.id, integrationId: 'github' })),
      get: async ({ id }: { id: string }) => {
        const c = liveConnection(id);
        return c ? { id: c.id } : null;
      },
    },
    projectRepositories: {
      list: async ({ connectionId }: { connectionId: string }) => {
        const c = liveConnection(connectionId);
        if (!c) throw new SourceControlConnectionNotFoundError();
        return c.repositoryIds.map(repositoryId => ({ id: `${c.id}:${repositoryId}`, repositoryId }));
      },
    },
    repositories: {
      get: async ({ id }: { id: string }) => {
        const slug = sourceControl.repositories.get(id);
        return slug ? { id, slug, externalId: `gh_${id}` } : null;
      },
    },
  };
  const controller = new FakeController();
  const ctx = {
    controller,
    auth: { enabled: () => true, ensureUser: async () => undefined, tenant: () => ({ orgId: ORG, userId: 'u1' }), isOrganizationAdmin: async () => true },
    storage: {
      sourceControls: [sourceControlHandle],
      projects: {
        listAll: async () => sourceControl.projects.map(p => ({ ...p })),
        getById: async ({ id }: { id: string }) => {
          const project = sourceControl.projects.find(p => p.id === id);
          return project ? { ...project } : null;
        },
      },
    },
    runtime: { configVersion: 'test', workItems, boards: new Map([['work', board]]) },
    feed,
    factoryStorage: {
      getDomain: (name: string) => {
        if (name !== 'work-item-comments') throw new Error(`fake factory storage has no domain ${name}`);
        return feed;
      },
    },
  } as unknown as IntegrationContext;

  const cacheDir = join(dir, 'cache');
  const harness: Harness = {
    dir,
    remote,
    cacheDir,
    statePath,
    workItems,
    feed,
    sourceControl,
    controller,
    ctx,
    state: () => JSON.parse(readFileSync(statePath, 'utf8')) as FakeState,
    setState(update) {
      const s = harness.state();
      update(s);
      writeFileSync(statePath, JSON.stringify(s));
    },
    setBeadsData(present) {
      if (present) git('update-ref', 'refs/dolt/data', 'HEAD');
      else git('update-ref', '-d', 'refs/dolt/data');
    },
    bd(...args) {
      execFileSync(process.execPath, [FAKE_BD, ...args], { cwd: dir, env: { ...process.env, FAKE_BD_STATE: statePath }, stdio: 'pipe' });
    },
    integration(options = {}) {
      const integration = new BeadsIntegration({
        sourceControl: {
          id: 'github',
          versionControl: {
            getRepositoryAccess: async () => ({ cloneUrl: remote, authorization: { scheme: 'bearer', token: TOKEN } }),
          } as never,
        },
        cacheDir,
        pollIntervalMs: 3_600_000,
        syncRetry: { retries: 2, baseDelayMs: 1 },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        runner: new BdRunner({
          bdPath: process.execPath,
          bdArgs: [FAKE_BD],
          env: { FAKE_BD_STATE: statePath },
        }),
        ...options,
      });
      integration.workers(ctx);
      return integration;
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return harness;
}

/** Run one sweep under the (no-op) lease and return it. */
export async function sweep(integration: BeadsIntegration) {
  const outcome = await integration.syncNow();
  if (!outcome.ran) throw new Error(`sweep did not run: ${outcome.reason}`);
  return outcome.result;
}
