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
import { validateParentRelation, WorkItemClaimConflictError } from '@mastra/factory/storage/domains/work-items/base';
import type {
  CommitFactoryRuleEvaluationInput,
  CommitFactoryRuleEvaluationResult,
  CreateWorkItemInput,
  ExternalWorkItemSource,
  WorkItemRow,
} from '@mastra/factory/storage/domains/work-items/base';
import type { BoardTransitionPolicy } from '@mastra/factory/boards';

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
  description?: string;
  blockedBy?: string[];
  /** bd refuses to close a bead held by anyone but the closing actor. */
  assignee?: string;
  closeReason?: string | null;
  /** Only this repository's copy lists the bead (slug). Unset: every linked repository does. */
  repo?: string;
  /** The parent bead (a parent-child edge), as bd's `parent` field. */
  parent?: string;
}

export interface FakeState {
  beads: FakeBead[];
  syncExits: number[];
  pullExits: number[];
  closeFail: string[];
  /** Bead ids whose `--if-assignee` reassign fails as if the holder changed (exit 13). */
  casFail?: string[];
  /** Parent ids whose `bd list --parent` fails. */
  listParentFail?: string[];
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

/** One committed rule evaluation, and which of its decisions `applyDecisions` has applied (by index). */
export interface RecordedEvaluation {
  input: CommitFactoryRuleEvaluationInput;
  result: Record<string, unknown> & { status: 'accepted' | 'rejected'; itemId: string | null; code: string | null; decisions: Record<string, unknown>[] };
  applied: number[];
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
      stageHistory: [],
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

  async update({ orgId, id, patch }: { orgId: string; id: string; userId: string; patch: { stages?: string[]; metadata?: Record<string, unknown> | null } }) {
    const item = this.items.find(i => i.orgId === orgId && i.id === id);
    if (!item) return null;
    // Same merge as WorkItemsStorage.applyUpdate (work-items/base.js:379-382).
    if (patch.metadata !== undefined) item.metadata = patch.metadata === null ? null : { ...(item.metadata ?? {}), ...patch.metadata };
    if (patch.stages) item.stages = patch.stages;
    item.revision++;
    return { item: structuredClone(item), previous: { stages: [], sessionRoles: [] } };
  }

  async getByClaimKey({ orgId, claimKey }: { orgId: string; claimKey: string }) {
    const hit = this.items.find(i => i.orgId === orgId && i.claimKey === claimKey);
    return hit ? structuredClone(hit) : null;
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
    this.evaluations.push({ input: structuredClone(input), result, applied: [] });
    return { status: 'committed', result: structuredClone(result) };
  }

  /**
   * Stands in for Factory's dispatcher (rules/dispatcher.js:507-534): applies
   * each accepted, not yet applied `transition` decision to the card as it is
   * now, as actor system, after asking `policy` (the board's transitionPolicy)
   * as the transition service does (rules/transition-service.js:245-262). A
   * move to the card's current stage is inert. Returns what each did.
   */
  async applyDecisions(policy?: BoardTransitionPolicy): Promise<Array<{ workItemId: string; stage: string; outcome: 'moved' | 'inert' | 'rejected'; reason?: string }>> {
    const out: Array<{ workItemId: string; stage: string; outcome: 'moved' | 'inert' | 'rejected'; reason?: string }> = [];
    for (const evaluation of this.evaluations) {
      for (const [index, decision] of (evaluation.result.decisions as Array<Record<string, unknown>>).entries()) {
        if (decision.type !== 'transition' || evaluation.applied.includes(index)) continue;
        evaluation.applied.push(index);
        const item = this.items.find(i => i.id === evaluation.result.itemId)!;
        const stage = String(decision.stage);
        if (item.stages.length === 1 && item.stages[0] === stage) {
          out.push({ workItemId: item.id, stage, outcome: 'inert' });
          continue;
        }
        const verdict = await policy?.({
          board: String(decision.board),
          fromStage: item.stages[0]!,
          toStage: stage,
          actor: { type: 'system', id: 'factory-rule-dispatcher' },
          isHumanTransition: false,
          item: { id: item.id, stages: item.stages, metadata: item.metadata },
        } as unknown as Parameters<BoardTransitionPolicy>[0]);
        if (verdict && 'type' in verdict && verdict.type === 'reject') {
          out.push({ workItemId: item.id, stage, outcome: 'rejected', reason: verdict.reason });
          continue;
        }
        item.stages = [stage];
        item.revision++;
        out.push({ workItemId: item.id, stage, outcome: 'moved' });
      }
    }
    return out;
  }

  /** Simulates the board moving a card (the transition API's job, not ours). */
  move(id: string, phase: string) {
    const item = this.items.find(i => i.id === id)!;
    item.stages = [phase];
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
  occurredAt: Date;
}

/**
 * The `feed` slice integrations get (`Pick<CommentsDomain, 'createComment'>`),
 * with the semantics the integration relies on (@mastra/factory 0.20.0):
 * body policy (comments/base.js:37-40), unknown work item
 * (comments/domain.js:49-53), and the externalSource replay that returns the
 * existing row as `created` (comments/base.js:180-191, domain.js:94-99).
 */
export class MemoryFeed {
  comments: FeedComment[] = [];
  calls = 0;
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
            c.externalSource !== null &&
            key(c.externalSource) === key(input.externalSource!),
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
      occurredAt: input.occurredAt ?? new Date(),
    };
    this.comments.push(comment);
    return { status: 'created' as const, comment: structuredClone(comment), workItem, mirrored: Promise.resolve() };
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

export interface Harness {
  dir: string;
  remote: string;
  cacheDir: string;
  statePath: string;
  workItems: MemoryWorkItems;
  feed: MemoryFeed;
  sourceControl: FakeSourceControl;
  ctx: IntegrationContext;
  state(): FakeState;
  setState(update: (s: FakeState) => void): void;
  /** Add or delete refs/dolt/data on the remote. */
  setBeadsData(present: boolean): void;
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
  const board = {
    id: 'work',
    initialPhase: 'intake',
    phaseKind: (p: string) => (['intake', 'triage', 'planning', 'execute', 'review'].includes(p) ? 'working' : p === 'done' || p === 'canceled' ? 'terminal' : undefined),
  };
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
  const ctx = {
    auth: { enabled: () => true, ensureUser: async () => undefined, tenant: () => ({ orgId: ORG, userId: 'u1' }), isOrganizationAdmin: async () => true },
    storage: {
      sourceControls: [sourceControlHandle],
      projects: { listAll: async () => sourceControl.projects.map(p => ({ ...p })) },
    },
    runtime: { configVersion: 'test', workItems, boards: new Map([['work', board]]) },
    feed,
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
