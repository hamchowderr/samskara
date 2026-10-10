/**
 * `BeadsIntegration`: ready beads become Factory cards; a card reaching the
 * done phase closes its bead and publishes it to `refs/dolt/data`.
 *
 * beads owns the graph, Factory owns the lane: order comes from `bd ready`
 * (a bead blocked by another is not ready, so it is carded only after its
 * blocker closes), and Factory never reasons about dependencies.
 *
 * Factory extension points used (@mastra/factory 0.20.0, dist/):
 *   - FactoryIntegration.workers / routes / diagnostics   integrations/base.d.ts:180-270
 *   - IntegrationContext.runtime.{workItems, boards}      integrations/base.d.ts:137-143
 *   - IntegrationContext.feed.createComment               integrations/base.d.ts:94-95
 *       (idempotent on externalSource, storage/domains/comments/base.js:180-191)
 *   - IntegrationContext.storage.{sourceControls, projects} integrations/base.d.ts:109-111
 *   - VersionControl.getRepositoryAccess                  capabilities/version-control.d.ts:231
 *       (GitHub: plain https cloneUrl + installation token, integrations/github/integration.js:199-213)
 *   - WorkItemsStorage.getByProjectSource / upsert / update / list
 *                                                         storage/domains/work-items/base.d.ts:544,562,746,759
 *   - update merges metadata                              storage/domains/work-items/base.js:379-382
 *   - claimKey: org-wide, released on a terminal phase    work-items/base.d.ts:395-400; base.js:912-919
 *   - WorkItemsStorage.getByClaimKey                      work-items/base.d.ts:589; base.js:1220-1226
 *   - parentWorkItemId on upsert, setParentWorkItemIfMissing
 *       (the parent card must be in the same project)     work-items/base.js:318-332,2484,2512-2530
 *
 * Why cards are created with `workItems.upsert` and not a rule decision:
 * `upsertLinkedWorkItem.source` is a closed union (rules/types.d.ts:2) and a
 * `manual` source is stored as integration `factory`, so a decision cannot
 * carry `integrationId: 'beads'`. `upsert` is the call
 * POST /web/factory/projects/:id/work-items makes (routes/work-items.js:386),
 * and it accepts any externalSource. Such a card classifies as `manual` on the
 * board (rules/types.d.ts:12, workItemSource), so `manual` rules apply to it.
 */
import { registerApiRoute } from '@mastra/core/server';
import type { ApiRoute } from '@mastra/core/server';
import type { LeaseProvider } from '@mastra/core/events';
import type { RequestContext } from '@mastra/core/request-context';
import type { MastraWorker } from '@mastra/core/worker';
import type { VersionControl } from '@mastra/factory/capabilities/version-control';
import type { FactoryIntegration, IntegrationContext, IntegrationTools } from '@mastra/factory/integrations/base';
import { validateFactoryRuleDecisions } from '@mastra/factory/rules/validation';
import { WorkItemClaimConflictError, WorkItemRelationError } from '@mastra/factory/storage/domains/work-items/base';
import type { ExternalWorkItemSource, WorkItemRow } from '@mastra/factory/storage/domains/work-items/base';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBeadsTools, resolveToolProject } from './agent-tools';
import type { ToolScope } from './agent-tools';
import { registerLive } from './done-rule';
import { BdRepo, cacheDirFor, OVERVIEW_TYPES, resultTail } from './repo';
import type { BeadDetails } from './repo';
import { BdRunner } from './runner';
import type { BdResult, RepoCredentials } from './runner';
import { BeadsToolOps } from './tool-ops';
import { BeadsSyncWorker } from './worker';
import type { TickOutcome, WithLeaseOptions } from './worker';

export const BEADS_INTEGRATION_ID = 'beads';

/** Card metadata keys this integration owns. */
export const BEADS_META = {
  id: 'beadsId',
  repo: 'beadsRepo',
  type: 'beadsType',
  priority: 'beadsPriority',
  writeback: 'beadsWriteback',
  syncedAt: 'beadsSyncedAt',
  syncExit: 'beadsSyncExit',
  diagnostic: 'beadsDiagnostic',
  closeAttempts: 'beadsCloseAttempts',
  /** `overview` on a container's card; absent on a work card. */
  cardKind: 'beadsCardKind',
  /** Overview cards: how many of the container's direct children are not closed. */
  openChildren: 'beadsOpenChildren',
  /**
   * Overview cards parked `close-failed` in Done: when the write-back was
   * re-armed after the last child closed. Set once; a card is re-armed once.
   */
  closeRearmedAt: 'beadsCloseRearmedAt',
} as const;

/** `BEADS_META.cardKind` of an epic's, milestone's or molecule root's card. */
export const OVERVIEW_CARD_KIND = 'overview';

/**
 * The card metadata key Factory reads to pick a card's repository: the
 * linked repository's slug (`owner/name`). Factory's own key, not ours.
 *
 * resolveWorkItemRepository (@mastra/factory 0.20.0
 * session/work-item-repository.js:31,36-46) tries `metadata.repository` first
 * and matches it with `===` against the slug of every repository linked to the
 * card's project (:16-27), the same source-control `repositories` rows
 * #linkedRepos reads, so the slug written here always matches. Without it, a
 * project with two or more linked repositories resolves to `ambiguous` (:83-86)
 * and the card stops with "Choose a repository for this work item"
 * (rules/start-coordinator.js:88; routes/surface.js:189).
 *
 * Not `githubRepositoryId`: GitHub's rules key on it (integrations/github/rules.js:100,
 * acceptance-labels.js:12) and would treat a beads card as a GitHub issue.
 */
export const FACTORY_REPOSITORY_META = 'repository';

export type WritebackState ='synced' | 'conflict' | 'close-failed' | 'reset-requested';

/** The source-control integration whose App tokens read and write each repo. */
export interface BeadsSourceControl {
  readonly id: string;
  readonly versionControl?: VersionControl;
}

export interface BeadsIntegrationOptions {
  sourceControl: BeadsSourceControl;
  /** Board the cards land on. Pass the installed board's id from its definition. Default `work`. */
  board?: string;
  /** Phase whose arrival closes the bead. Default `done`. */
  donePhase?: string;
  /** Poll interval. Default 60 s. */
  pollIntervalMs?: number;
  /** Where the per-repo bd copies live. Default `<tmpdir>/factory-beads`. Must survive between ticks, not restarts. */
  cacheDir?: string;
  /** `bd` executable. Default `bd` on PATH. */
  bdPath?: string;
  /** `git` executable. Default `git` on PATH. */
  gitPath?: string;
  /** Actor recorded on bead writes. Default `factory-beads`. */
  actor?: string;
  /** Overrides the lease taken from the server's pubsub. */
  leaseProvider?: LeaseProvider;
  /** `bd sync` exit 3 (push race) retries inside one tick. Default 2 retries, 2 s base, doubling. */
  syncRetry?: { retries?: number; baseDelayMs?: number };
  /** Close attempts per card before it is parked as `close-failed`. Default 3. */
  maxCloseAttempts?: number;
  /** Text for `bd close --reason`. Default names the card id and phase. */
  closeReason?: (item: WorkItemRow) => string;
  /** Extra environment for bd/git, e.g. PATH in tests. Never a token. */
  env?: NodeJS.ProcessEnv;
  /** A preconfigured runner; overrides bdPath, gitPath, actor and env. */
  runner?: BdRunner;
  /**
   * How long a repository without `refs/dolt/data` on origin waits before the
   * next look. Default 15 min. Such a repository is not using beads yet; it is
   * reported as `no-beads-data`, not as an error.
   */
  remoteCheckIntervalMs?: number;
  /**
   * How long an agent tool waits for the writer lease while another process
   * holds it. Default 120 s, polled every 1 s.
   */
  toolLeaseWait?: WithLeaseOptions;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

/**
 * One linked repository's state after a sweep.
 *
 * - `ok`: synced.
 * - `no-beads-data`: origin has no `refs/dolt/data`, so the repository does not
 *   use beads (yet). Not an error: nothing is cloned or bootstrapped, and the
 *   remote is looked at again every `remoteCheckIntervalMs`.
 * - `error`: this sweep failed for the repository; `diagnostic` says why. The
 *   next sweep tries again.
 * - `parked`: a write-back conflict needs an operator; nothing runs for the
 *   repository until `POST /web/beads/reset`.
 */
export type RepoState = 'ok' | 'no-beads-data' | 'error' | 'parked';

export interface RepoSyncReport {
  orgId: string;
  projectId: string;
  repo: string;
  created: number;
  existing: number;
  closed: number;
  state: RepoState;
  diagnostic?: string;
  /** When the repository was last checked: its sync, or for `no-beads-data` the last look at origin. */
  checkedAt: string;
  /** `no-beads-data` only: when origin is looked at again. */
  nextCheckAt?: string;
}

export interface SweepSummary {
  at: string;
  durationMs: number;
  repos: RepoSyncReport[];
  error?: string;
  /** Set when a startup precondition failed; the integration does nothing until restarted. */
  idle?: string;
}

const DEFAULT_REMOTE_CHECK_INTERVAL_MS = 15 * 60_000;

/** The ref beads publishes its Dolt data to (bd's git remote). */
export const BEADS_DATA_REF = 'refs/dolt/data';

interface LinkedRepo {
  orgId: string;
  projectId: string;
  repositoryId: string;
  slug: string;
}

/** One repository's intake within one sweep. */
interface IntakeScope {
  orgId: string;
  projectId: string;
  slug: string;
  repo: BdRepo;
  initialPhase: string;
  report: RepoSyncReport;
  /** Overview cards resolved this sweep, by container bead id; undefined = none. */
  overviews: Map<string, Promise<WorkItemRow | undefined>>;
  /**
   * Overview cards whose open-children count was read and written this sweep,
   * by container bead id: `open` children not closed, `total` children.
   */
  counted: Map<string, { open: number; total: number }>;
}

/** What committing a rule-evaluated transition came to. */
export type TransitionCommit =
  /** Stored; Factory's dispatcher applies the move. */
  | 'committed'
  /** This evaluation (same card revision) was stored before; nothing new. */
  | 'replayed'
  /** Stored as rejected: the card changed after it was read (`stale`). */
  | 'rejected'
  /** The card is gone. */
  | 'missing';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class BeadsIntegration implements FactoryIntegration {
  readonly id = BEADS_INTEGRATION_ID;
  readonly board: string;
  readonly donePhase: string;
  readonly #options: BeadsIntegrationOptions;
  readonly #runner: BdRunner;
  readonly #cacheRoot: string;
  readonly #repos = new Map<string, BdRepo>();
  readonly #log: Pick<Console, 'info' | 'warn' | 'error'>;
  #ctx: IntegrationContext | undefined;
  #worker: BeadsSyncWorker<SweepSummary> | undefined;
  #last: SweepSummary | undefined;
  /** Orphaned connection ids already logged, so each is reported once per process. */
  readonly #orphansLogged = new Set<string>();
  /** Card ids whose description comment is confirmed in this process. */
  readonly #described = new Set<string>();
  /** Keys of warnings already logged, so each repeats once per process, not once per sweep. */
  readonly #warned = new Set<string>();
  #feedMissingLogged = false;
  /** Startup preconditions, checked once (first sweep): undefined = ok, else the idle reason. */
  #preflight: Promise<string | undefined> | undefined;
  #idle: string | undefined;
  /** Repositories last seen without refs/dolt/data, by slug: when origin was checked. */
  readonly #noData = new Map<string, number>();
  /** Repositories (slug) with an agent-tool write committed on the host copy but not yet on origin. */
  readonly #unpublished = new Set<string>();
  #toolOps: BeadsToolOps | undefined;
  /** Linked repositories per project for agentTools, which Factory resolves on every request. */
  readonly #scopeCache = new Map<string, { at: number; repos: ToolScope['repos'] }>();
  #toolsFailureLogged = false;
  /** Repositories parked by an agent-write conflict whose reset was requested (POST /web/beads/reset). */
  readonly #resetRepos = new Set<string>();

  constructor(options: BeadsIntegrationOptions) {
    this.#options = options;
    this.board = options.board ?? 'work';
    this.donePhase = options.donePhase ?? 'done';
    this.#cacheRoot = options.cacheDir ?? join(tmpdir(), 'factory-beads');
    this.#log = options.logger ?? console;
    this.#runner =
      options.runner ??
      new BdRunner({
        bdPath: options.bdPath,
        gitPath: options.gitPath,
        actor: options.actor,
        env: options.env,
      });
    registerLive(this);
  }

  diagnostics(): Record<string, unknown> {
    return {
      board: this.board,
      donePhase: this.donePhase,
      sourceControl: this.#options.sourceControl.id,
      lease: this.#worker?.leaseSource ?? 'not-started',
      state: this.#idle ? 'idle' : 'running',
      ...(this.#idle ? { idleReason: this.#idle } : {}),
      remoteCheckIntervalMs: this.#remoteCheckIntervalMs,
    };
  }

  get #remoteCheckIntervalMs(): number {
    return this.#options.remoteCheckIntervalMs ?? DEFAULT_REMOTE_CHECK_INTERVAL_MS;
  }

  /**
   * Preconditions that cannot change while the server runs. Each failure logs
   * ONE line and leaves the integration idle, instead of an error per sweep.
   */
  #checkPreconditions(): Promise<string | undefined> {
    this.#preflight ??= (async () => {
      let reason: string | undefined;
      if (!this.#options.sourceControl.versionControl) {
        reason = `source control "${this.#options.sourceControl.id}" has no versionControl capability (is the GitHub App configured?)`;
      } else {
        const probe = await this.#runner.bd(['--version'], { cwd: tmpdir(), timeoutMs: 30_000 });
        // 127: the runner's code for a binary that could not be started (ENOENT).
        if (probe.code === 127) {
          reason = `bd binary not found ("${this.#runner.bdPath}"; set BEADS_BD_PATH or put bd on PATH): ${resultTail(probe, 200)}`;
        }
      }
      this.#idle = reason;
      if (reason) this.#log.warn(`[factory-beads] integration idle: ${reason}. Nothing is synced; restart after fixing it.`);
      return reason;
    })();
    return this.#preflight;
  }

  workers(ctx: IntegrationContext): MastraWorker[] {
    this.#ctx = ctx;
    if (!ctx.runtime) return [];
    this.#worker = new BeadsSyncWorker<SweepSummary>({
      name: `${BEADS_INTEGRATION_ID}-sync`,
      leaseKey: `${BEADS_INTEGRATION_ID}:writer`,
      intervalMs: this.#options.pollIntervalMs ?? 60_000,
      leaseProvider: this.#options.leaseProvider,
      sweep: () => this.#sweep(),
    });
    return [this.#worker];
  }

  /** Wake the worker (from the Done rule). The tick runs under the writer lease. */
  kick(): void {
    this.#worker?.kick();
  }

  /** Run one tick now, under the writer lease. */
  syncNow(): Promise<TickOutcome<SweepSummary>> {
    return this.#worker?.runNow() ?? Promise.resolve({ ran: false, reason: 'not-running' });
  }

  get lastSweep(): SweepSummary | undefined {
    return this.#last;
  }

  /**
   * Beads tools for the requesting session's project (samskara-e64): read,
   * create, update, link, init and pour, run on the host copy under the
   * writer lease. See agent-tools.ts. Nothing for a request that is not a
   * Factory session, a project with no linked repository, or before the
   * worker exists. `beads_init` only for the supervisor (owner decision).
   *
   * Never throws. Factory merges every integration's tools into one
   * `extraTools` provider (@mastra/factory 0.20.0 dist/factory.js:588-595) and
   * the SDK awaits it without a catch (@mastra/code-sdk
   * dist/agents/tools.js:120-122), so an error here would take every tool
   * away from every session. A failure logs once and offers no beads tools.
   */
  async agentTools({ requestContext }: { requestContext: RequestContext }): Promise<IntegrationTools> {
    try {
      const ctx = this.#ctx;
      if (!ctx?.runtime || !this.#worker) return {};
      const project = await resolveToolProject(requestContext, ctx.storage.projects);
      if (!project) return {};
      const key = `${project.orgId}:${project.projectId}`;
      let cached = this.#scopeCache.get(key);
      if (!cached || Date.now() - cached.at > 30_000) {
        const repos = (await this.#linkedRepos(ctx, project.projectId)).map(r => ({ repositoryId: r.repositoryId, slug: r.slug }));
        cached = { at: Date.now(), repos };
        this.#scopeCache.set(key, cached);
      }
      this.#toolsFailureLogged = false;
      return createBeadsTools(this.#tools(), {
        orgId: project.orgId,
        projectId: project.projectId,
        supervisor: project.supervisor,
        repos: cached.repos,
      });
    } catch (error) {
      if (!this.#toolsFailureLogged) {
        this.#toolsFailureLogged = true;
        this.#log.warn(
          `[factory-beads] agent tools unavailable for this request: ${error instanceof Error ? error.message : String(error)}. Other tools are unaffected; logged once until it recovers.`,
        );
      }
      return {};
    }
  }

  #tools(): BeadsToolOps {
    const worker = this.#worker;
    this.#toolOps ??= new BeadsToolOps({
      runner: this.#runner,
      versionControl: this.#options.sourceControl.versionControl,
      withLease: worker ? (fn, options) => worker.withLease(fn, options) : undefined,
      repoFor: (slug, cloneUrl) => this.#repo(slug, cloneUrl),
      forget: async slug => {
        // The directory may predate this process, so drop it by path.
        await (this.#repos.get(slug) ?? new BdRepo(slug, cacheDirFor(this.#cacheRoot, slug), '', this.#runner)).discard();
        this.#repos.delete(slug);
        this.#noData.delete(slug);
      },
      hasBeadsData: (cloneUrl, credentials) => this.#hasBeadsData(cloneUrl, credentials),
      repoState: (orgId, slug) => this.#last?.repos.find(r => r.orgId === orgId && r.repo === slug)?.state,
      idleReason: () => this.#checkPreconditions(),
      markUnpublished: (slug, unpublished) => {
        if (unpublished) this.#unpublished.add(slug);
        else this.#unpublished.delete(slug);
      },
      kick: () => this.kick(),
      syncRetry: this.#options.syncRetry,
      leaseWait: this.#options.toolLeaseWait,
    });
    return this.#toolOps;
  }

  /** Every linked repository, or only `projectId`'s. */
  async #linkedRepos(ctx: IntegrationContext, projectId?: string): Promise<LinkedRepo[]> {
    const handle = ctx.storage.sourceControls.find(h => h.integrationId === this.#options.sourceControl.id);
    if (!handle) return [];
    const out: LinkedRepo[] = [];
    const projects = projectId
      ? [await ctx.storage.projects.getById({ id: projectId })].filter(p => p !== null && p !== undefined)
      : await ctx.storage.projects.listAll();
    for (const project of projects) {
      for (const connection of await handle.connections.list({ orgId: project.orgId, factoryProjectId: project.id })) {
        // connections.list only checks the project's org, so it also returns a
        // connection whose installation is gone (pruned: samskara-1ra).
        // projectRepositories.list then throws SourceControlConnectionNotFoundError
        // (@mastra/factory 0.20.0 storage/domains/source-control/base.js:306-309,
        // :510-515). connections.get applies the same check and returns null
        // instead, so skip the orphan and keep sweeping the valid links.
        if (!(await handle.connections.get({ orgId: project.orgId, id: connection.id }))) {
          if (!this.#orphansLogged.has(connection.id)) {
            this.#orphansLogged.add(connection.id);
            this.#log.warn(
              `[factory-beads] skipping orphaned source-control connection ${connection.id} on project ${project.id}: its installation no longer exists (samskara-1ra)`,
            );
          }
          continue;
        }
        for (const link of await handle.projectRepositories.list({ orgId: project.orgId, connectionId: connection.id })) {
          const repository = await handle.repositories.get({ orgId: project.orgId, id: link.repositoryId });
          if (repository) {
            out.push({ orgId: project.orgId, projectId: project.id, repositoryId: repository.id, slug: repository.slug });
          }
        }
      }
    }
    return out;
  }

  async #sweep(): Promise<SweepSummary> {
    const started = Date.now();
    const summary: SweepSummary = { at: new Date().toISOString(), durationMs: 0, repos: [] };
    const ctx = this.#ctx;
    const runtime = ctx?.runtime;
    const vc = this.#options.sourceControl.versionControl;
    const idle = await this.#checkPreconditions();
    if (idle) {
      // Logged once by the precondition check; an idle sweep is silent.
      summary.idle = idle;
      summary.durationMs = Date.now() - started;
      this.#last = summary;
      return summary;
    }
    try {
      if (!ctx || !runtime) throw new Error('work-item runtime is not available');
      if (!vc) throw new Error(`source control "${this.#options.sourceControl.id}" has no versionControl capability`);
      const board = runtime.boards.get(this.board);
      if (!board) throw new Error(`board "${this.board}" is not installed`);
      if (!board.phaseKind(this.donePhase)) throw new Error(`board "${this.board}" has no phase "${this.donePhase}"`);
      for (const linked of await this.#linkedRepos(ctx)) {
        const report: RepoSyncReport = {
          orgId: linked.orgId,
          projectId: linked.projectId,
          repo: linked.slug,
          created: 0,
          existing: 0,
          closed: 0,
          state: 'ok',
          checkedAt: new Date().toISOString(),
        };
        summary.repos.push(report);
        // Seen without beads data recently: report it again without touching
        // GitHub, until the slower re-check is due.
        const lastNoData = this.#noData.get(linked.slug);
        if (lastNoData !== undefined && Date.now() - lastNoData < this.#remoteCheckIntervalMs) {
          this.#reportNoData(report, lastNoData);
          continue;
        }
        try {
          const access = await vc.getRepositoryAccess({ orgId: linked.orgId, repositoryId: linked.repositoryId });
          const credentials: RepoCredentials | undefined = access.authorization
            ? { token: access.authorization.token, username: access.authorization.username }
            : undefined;
          await this.#syncRepo(linked, access.cloneUrl, credentials, board.initialPhase, phase => board.phaseKind(phase), report);
        } catch (error) {
          report.state = 'error';
          report.diagnostic = error instanceof Error ? error.message : String(error);
        }
      }
    } catch (error) {
      summary.error = error instanceof Error ? error.message : String(error);
    }
    summary.durationMs = Date.now() - started;
    this.#last = summary;
    // Only real problems: a repository without beads data is a state, not an error.
    const problems = summary.repos.filter(r => r.state === 'error' || r.state === 'parked');
    if (summary.error || problems.length > 0) {
      this.#log.warn('[factory-beads] sweep finished with problems', JSON.stringify({ error: summary.error, problems }));
    }
    return summary;
  }

  #reportNoData(report: RepoSyncReport, checkedAt: number): void {
    report.state = 'no-beads-data';
    report.checkedAt = new Date(checkedAt).toISOString();
    report.nextCheckAt = new Date(checkedAt + this.#remoteCheckIntervalMs).toISOString();
    report.diagnostic = `origin has no ${BEADS_DATA_REF}: this repository does not publish beads data`;
  }

  /**
   * Whether origin carries beads data. `git ls-remote --exit-code` exits 2
   * when no ref matches (git ls-remote --help), so 0 = yes, 2 = no, and
   * anything else (auth, network) is an error for this sweep.
   */
  async #hasBeadsData(cloneUrl: string, credentials: RepoCredentials | undefined): Promise<boolean> {
    const res = await this.#runner.git(['ls-remote', '--exit-code', cloneUrl, BEADS_DATA_REF], {
      cwd: tmpdir(),
      credentials,
      timeoutMs: 60_000,
    });
    if (res.code === 0) return true;
    if (res.code === 2) return false;
    throw new Error(`git ls-remote exit ${res.code}: ${resultTail(res, 300)}`);
  }

  #repo(slug: string, cloneUrl: string): BdRepo {
    let repo = this.#repos.get(slug);
    if (!repo || repo.cloneUrl !== cloneUrl) {
      repo = new BdRepo(slug, cacheDirFor(this.#cacheRoot, slug), cloneUrl, this.#runner);
      this.#repos.set(slug, repo);
    }
    return repo;
  }

  async #syncRepo(
    linked: LinkedRepo,
    cloneUrl: string,
    credentials: RepoCredentials | undefined,
    initialPhase: string,
    phaseKind: (phase: string) => string | undefined,
    report: RepoSyncReport,
  ): Promise<void> {
    const runtime = this.#ctx!.runtime!;
    const { orgId, projectId, slug } = linked;
    const cards = (await runtime.workItems.list({ orgId, factoryProjectId: projectId })).filter(
      item => item.externalSource?.integrationId === BEADS_INTEGRATION_ID && item.metadata?.[BEADS_META.repo] === slug,
    );

    // An operator asked for a reset (POST /web/beads/reset): drop the local
    // copy, which the next step re-bootstraps from the remote — that holds only
    // what was published — and release the parked cards for write-back again.
    // Done here, under the writer lease, not in the route. A repository parked
    // by an agent-tool write (no card involved) is reset the same way.
    const resetRepo = this.#resetRepos.delete(slug);
    if (resetRepo || cards.some(item => item.metadata?.[BEADS_META.writeback] === 'reset-requested')) {
      await this.#repo(slug, cloneUrl).discard();
      this.#repos.delete(slug);
      this.#unpublished.delete(slug);
      for (const [index, item] of cards.entries()) {
        if (item.metadata?.[BEADS_META.writeback] !== 'reset-requested') continue;
        cards[index] = await this.#mark(orgId, item, {
          [BEADS_META.writeback]: null,
          [BEADS_META.syncExit]: null,
          [BEADS_META.closeAttempts]: 0,
        });
      }
    }

    // Back-fill: name the repository on cards made before the integration set
    // it, so Factory resolves them without a manual pick in a multi-repo
    // project. The integration owns the field on its cards: a bead belongs to
    // its repository, and write-back closes it there. update merges metadata
    // (storage/domains/work-items/base.js:379-382), so nothing else changes.
    for (const [index, item] of cards.entries()) {
      if (item.metadata?.[FACTORY_REPOSITORY_META] === slug) continue;
      cards[index] = await this.#mark(orgId, item, { [FACTORY_REPOSITORY_META]: slug });
    }

    // A conflicted write-back parks the whole repo: no pull, no intake, no
    // further writes until an operator resolves it and resets the copy.
    const conflicted = cards.filter(item => item.metadata?.[BEADS_META.writeback] === 'conflict');
    if (conflicted.length > 0) {
      report.state = 'parked';
      report.diagnostic = `bd sync conflict on ${conflicted.map(c => c.metadata?.[BEADS_META.id]).join(', ')}; resolve it, then POST /web/beads/reset`;
      return;
    }
    // Same for a conflict after an agent-tool write: the copy carries the marker.
    const parkedReason = this.#repo(slug, cloneUrl).parkedReason();
    if (parkedReason) {
      report.state = 'parked';
      report.diagnostic = `${parkedReason}; resolve it, then POST /web/beads/reset`;
      return;
    }

    // A repository that does not publish beads data is not bootstrapped:
    // bootstrap would build an empty database with no remote, and every later
    // `bd dolt pull` would fail with "no remote". Checked every sweep, so a
    // copy left from before (or a ref deleted on origin) is caught too.
    const checkedAt = Date.now();
    if (!(await this.#hasBeadsData(cloneUrl, credentials))) {
      if (!this.#noData.has(slug)) {
        this.#log.info(
          `[factory-beads] ${slug}: origin has no ${BEADS_DATA_REF}, so it is not a beads repository yet; state no-beads-data, re-checked every ${Math.round(this.#remoteCheckIntervalMs / 60_000)} min`,
        );
      }
      this.#noData.set(slug, checkedAt);
      // Drop a copy bootstrapped without beads data: it has no remote to pull.
      await this.#repo(slug, cloneUrl).discard();
      this.#repos.delete(slug);
      this.#reportNoData(report, checkedAt);
      return;
    }
    if (this.#noData.delete(slug)) this.#log.info(`[factory-beads] ${slug}: ${BEADS_DATA_REF} found on origin; syncing`);

    const repo = this.#repo(slug, cloneUrl);
    const boot = await repo.ensure(credentials);
    if (boot) this.#log.info(`[factory-beads] bootstrapped ${slug}: clone ${boot.cloneMs}ms, bootstrap ${boot.bootstrapMs}ms`);

    // 1. Write-back: cards durably in the done phase whose bead is not yet published.
    const maxAttempts = this.#options.maxCloseAttempts ?? 3;
    const pending = cards.filter(
      item =>
        item.board === this.board &&
        item.stages.length === 1 &&
        item.stages[0] === this.donePhase &&
        !item.metadata?.[BEADS_META.syncedAt] &&
        item.metadata?.[BEADS_META.writeback] !== 'close-failed' &&
        Number(item.metadata?.[BEADS_META.closeAttempts] ?? 0) < maxAttempts,
    );
    if (pending.length > 0) {
      const closed: WorkItemRow[] = [];
      for (const item of pending) {
        const beadId = String(item.metadata?.[BEADS_META.id]);
        const bead = await repo.show(beadId);
        if (bead?.status === 'closed') {
          closed.push(item);
          continue;
        }
        const res = await repo.close(beadId, this.#closeReason(item), bead?.assignee);
        if (res.code === 0) {
          closed.push(item);
          continue;
        }
        const attempts = Number(item.metadata?.[BEADS_META.closeAttempts] ?? 0) + 1;
        await this.#mark(orgId, item, {
          [BEADS_META.closeAttempts]: attempts,
          [BEADS_META.diagnostic]: `write-back exit ${res.code}: ${resultTail(res, 300)}`,
          ...(attempts >= maxAttempts ? { [BEADS_META.writeback]: 'close-failed' satisfies WritebackState } : {}),
        });
        report.state = 'error';
        report.diagnostic = `write-back of ${beadId} exit ${res.code}`;
      }
      if (closed.length > 0) {
        const sync = await this.#syncWithRetry(repo, credentials);
        if (sync.code === 0) {
          // The same sync published any agent-tool write waiting here.
          this.#unpublished.delete(slug);
          for (const item of closed) {
            await this.#mark(orgId, item, {
              [BEADS_META.writeback]: 'synced' satisfies WritebackState,
              [BEADS_META.syncedAt]: new Date().toISOString(),
              [BEADS_META.diagnostic]: null,
            });
            report.closed++;
          }
        } else if (sync.code === 2 || sync.code === 4) {
          // 2 = merge conflict, 4 = stuck working set (bd sync --help). Never
          // retried: retrying cannot fix either, and only an operator can.
          const diagnostic = `bd sync exit ${sync.code}: ${resultTail(sync, 600)}`;
          for (const item of closed) {
            await this.#mark(orgId, item, {
              [BEADS_META.writeback]: 'conflict' satisfies WritebackState,
              [BEADS_META.syncExit]: sync.code,
              [BEADS_META.diagnostic]: diagnostic,
            });
          }
          report.state = 'parked';
          report.diagnostic = diagnostic;
          return;
        } else {
          // 1 (transport/auth) or 3 after our retries: the close is committed
          // locally and the cards stay pending, so the next tick syncs again.
          report.state = 'error';
          report.diagnostic = `bd sync exit ${sync.code}: ${resultTail(sync, 300)}`;
        }
      }
    } else if (this.#unpublished.has(slug)) {
      // An agent-tool write is committed here but its own `bd sync` failed:
      // publish it now. A pull alone would never push it.
      const sync = await this.#syncWithRetry(repo, credentials);
      if (sync.code === 0) this.#unpublished.delete(slug);
      else if (sync.code === 2 || sync.code === 4) {
        // Never retried, as for write-back: park until an operator resets.
        const diagnostic = `bd sync exit ${sync.code} publishing an agent write: ${resultTail(sync, 600)}`;
        await repo.park(diagnostic);
        this.#unpublished.delete(slug);
        report.state = 'parked';
        report.diagnostic = `${diagnostic}; resolve it, then POST /web/beads/reset`;
        return;
      } else {
        report.state = 'error';
        report.diagnostic = `bd sync exit ${sync.code} (publishing an agent write): ${resultTail(sync, 300)}`;
      }
    } else {
      const pull = await repo.pull(credentials);
      if (pull.code !== 0) {
        report.state = 'error';
        report.diagnostic = `bd dolt pull exit ${pull.code}: ${resultTail(pull, 300)}`;
      }
    }

    // 2. Intake: one card per ready bead, idempotently, and its description
    //    on the card's feed (back-filled for cards that predate it). A bead
    //    with a parent container is linked under the container's overview
    //    card, which is made first.
    const scope: IntakeScope = { orgId, projectId, slug, repo, initialPhase, report, overviews: new Map(), counted: new Map() };
    for (const bead of await repo.ready()) {
      // No `workspaceId` in the source: POST /web/factory/projects/:id/work-items
      // drops it (routes/contracts.js externalSourceSchema), so a key carrying
      // it would never match a card made through that route. The repo is in claimKey.
      const existing = await runtime.workItems.getByProjectSource({ orgId, factoryProjectId: projectId, source: beadSource(bead.id) });
      if (!existing) {
        // Another project in the org already carries this bead. Its container's
        // overview card belongs there too, so none is made here.
        const claimant = await runtime.workItems.getByClaimKey({ orgId, claimKey: beadsClaimKey(slug, bead.id) });
        if (claimant && claimant.factoryProjectId !== projectId) {
          report.existing++;
          if (bead.parent) {
            this.#warnOnce(
              `claimed:${projectId}:${slug}:${bead.id}`,
              `[factory-beads] ${slug}: ${bead.id} is carded in project ${claimant.factoryProjectId}, so its parent ${bead.parent} gets no overview card in project ${projectId}`,
            );
          }
          continue;
        }
      }
      const parent = bead.parent ? await this.#overview(scope, bead.parent, new Set()) : undefined;
      if (existing) {
        report.existing++;
        if (parent) await this.#linkParent(scope, existing, parent);
        await this.#postDescription(existing, bead);
        continue;
      }
      const card = await this.#createCard(scope, bead, parent, {});
      if (card) await this.#postDescription(card, bead);
    }

    // 3. Open-children counts on the overview cards intake did not count this
    //    sweep: none of their children is ready, or the container itself is
    //    closed. #resolveOverview stops at a closed container before counting,
    //    so skipping every container intake touched froze a force-closed
    //    container's count while one of its children was still ready.
    //    The board policy reads the count to refuse Done while a child is
    //    open, and a policy may not read storage itself
    //    (configure-factory-rules/SKILL.md:63).
    for (const card of cards) {
      const beadId = card.metadata?.[BEADS_META.id];
      if (card.metadata?.[BEADS_META.cardKind] !== OVERVIEW_CARD_KIND || typeof beadId !== 'string') continue;
      if (scope.counted.has(beadId) || card.stages.some(stage => phaseKind(stage) === 'terminal')) continue;
      try {
        const children = await repo.children(beadId);
        const open = children.filter(child => child.status !== 'closed').length;
        if (card.metadata?.[BEADS_META.openChildren] !== open) await this.#mark(orgId, card, { [BEADS_META.openChildren]: open });
        scope.counted.set(beadId, { open, total: children.length });
      } catch (error) {
        this.#log.warn(`[factory-beads] ${slug}: children of ${beadId} not read: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 4. Overview cards whose last child closed move to Done. The move is a
    //    rule decision, so Factory's own transition applies it and the Done
    //    rule wakes this worker; the next sweep's write-back (step 1) then
    //    closes the container as this integration's actor and syncs it, or,
    //    when bd already closed it (a molecule root closes with its last
    //    step), only marks the card synced. Not `bd epic close-eligible`: it
    //    closes every eligible epic in the repository, as actor system (owner
    //    decision, samskara-l2t.2).
    await this.#closeSettledOverviews(scope, phaseKind);

    // 5. Overview cards parked `close-failed` in Done whose children have all
    //    closed since: bd refused the close while a child was open.
    await this.#rearmOverviewCloses(scope, cards);
  }

  /**
   * Step 4 of a sweep. A card moves only when its count was read this sweep,
   * is 0, and is the count on the card, so the board policy (board-rules.ts:
   * Done is refused while `beadsOpenChildren` is above 0) accepts the move. A
   * container with no children at all moves only when its bead is closed: a
   * childless epic is not finished work (samskara-l2t.2.4).
   *
   * The dispatcher applies the move after this sweep (it polls every second,
   * rules/dispatcher.js:17,295), and the policy reads the card as it is then.
   * A child added after the count was read is caught by bd instead, which
   * refuses the container's close; step 5 re-arms that close once the child
   * closes.
   */
  async #closeSettledOverviews(scope: IntakeScope, phaseKind: (phase: string) => string | undefined): Promise<void> {
    const settled = [...scope.counted].filter(([, count]) => count.open === 0);
    if (settled.length === 0) return;
    const { orgId, projectId, slug, repo } = scope;
    // Re-read: revisions moved during this sweep, and a commit naming any but
    // the card's current revision is stored as rejected.
    const cards = await this.#ctx!.runtime!.workItems.list({ orgId, factoryProjectId: projectId });
    for (const [beadId, count] of settled) {
      const card = cards.find(
        item =>
          item.externalSource?.integrationId === BEADS_INTEGRATION_ID &&
          item.metadata?.[BEADS_META.repo] === slug &&
          item.metadata?.[BEADS_META.id] === beadId,
      );
      if (!card || card.board !== this.board || card.metadata?.[BEADS_META.cardKind] !== OVERVIEW_CARD_KIND) continue;
      if (card.stages.some(stage => phaseKind(stage) === 'terminal')) continue;
      if (card.metadata?.[BEADS_META.openChildren] !== 0) continue;
      try {
        if (count.total === 0 && (await repo.status(beadId)) !== 'closed') continue;
        const outcome = await this.#commitTransition(orgId, card, this.donePhase, 'overview-done');
        if (outcome === 'committed') {
          this.#log.info(`[factory-beads] ${slug}: every child of ${beadId} is closed; its card moves to ${this.donePhase}`);
        }
      } catch (error) {
        this.#log.warn(
          `[factory-beads] ${slug}: card of ${beadId} not moved to ${this.donePhase}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Step 5 of a sweep. bd refuses to close a container while a child is open,
   * so an overview card that reached Done early (moved by hand, or a child was
   * added after the count was read) is parked `close-failed` after
   * `maxCloseAttempts`, and write-back never tries it again. Once every child
   * is closed that refusal no longer holds: the attempts and the write-back
   * state are reset so the close is retried. Once per card
   * (`beadsCloseRearmedAt`): a close that then fails for another reason stays
   * parked for an operator. The card stays in Done. Cards made before overview
   * cards existed carry only `beadsType`, and are re-armed too.
   */
  async #rearmOverviewCloses(scope: IntakeScope, cards: WorkItemRow[]): Promise<void> {
    const { orgId, slug, repo } = scope;
    let rearmed = 0;
    for (const card of cards) {
      const beadId = card.metadata?.[BEADS_META.id];
      if (typeof beadId !== 'string' || card.board !== this.board) continue;
      if (card.stages.length !== 1 || card.stages[0] !== this.donePhase) continue;
      if (card.metadata?.[BEADS_META.writeback] !== 'close-failed' || card.metadata?.[BEADS_META.closeRearmedAt]) continue;
      const container =
        card.metadata?.[BEADS_META.cardKind] === OVERVIEW_CARD_KIND ||
        (OVERVIEW_TYPES as readonly string[]).includes(String(card.metadata?.[BEADS_META.type] ?? ''));
      if (!container) continue;
      try {
        const children = await repo.children(beadId);
        if (children.length === 0 || children.some(child => child.status !== 'closed')) continue;
        await this.#mark(orgId, card, {
          [BEADS_META.writeback]: null,
          [BEADS_META.closeAttempts]: 0,
          [BEADS_META.closeRearmedAt]: new Date().toISOString(),
        });
        rearmed++;
        this.#log.info(`[factory-beads] ${slug}: every child of ${beadId} is closed; its close is retried`);
      } catch (error) {
        this.#log.warn(`[factory-beads] ${slug}: children of ${beadId} not read: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Write-back ran before this step; the next tick retries the close.
    if (rearmed > 0) this.kick();
  }

  /**
   * Move `card` to `stage` on this integration's board the way Factory's own
   * integrations do: commit a rule evaluation carrying a `transition`
   * decision, as Linear's issue-closed rule does (@mastra/factory 0.20.0
   * dist/integrations/linear/default-rules.js:35-49, committed at
   * integrations/linear/rules.js:131-158). Factory's dispatcher applies it
   * through the transition service as actor system, so the board policy and
   * the phase's rules run as for any move (rules/dispatcher.js:507-534). A
   * refused move fails the decision; its retries reuse the same ingress
   * (:526), so the transition service replays the rejection
   * (transition-service.js:129-130) and the decision ends in attention. Only
   * a new evaluation at a new revision can move the card.
   *
   * `key` names the reason, e.g. `overview-done`. The ingress identity
   * carries the card's revision: commitRuleEvaluation replays any identity it
   * has seen, and stores an evaluation whose expected revision is not the
   * card's as rejected with code `stale`
   * (storage/domains/work-items/base.js:1424-1473). Without the revision a
   * stale evaluation would be replayed, rejected, forever; with it, the
   * card's next revision gets a fresh evaluation, and a repeat at the same
   * revision is a harmless replay.
   */
  async #commitTransition(orgId: string, card: WorkItemRow, stage: string, key: string): Promise<TransitionCommit> {
    const runtime = this.#ctx!.runtime!;
    const identity = `${BEADS_INTEGRATION_ID}:${key}:${card.id}@${card.revision}`;
    // Factory's own validation, as the Linear rules run it (linear/rules.js:131-134).
    const decisions = validateFactoryRuleDecisions([
      { type: 'transition', idempotencyKey: `${identity}:transition`, board: this.board, stage },
    ]).map(decision => ({ ...decision }) as Record<string, unknown>);
    const result = await runtime.workItems.commitRuleEvaluation({
      orgId,
      factoryProjectId: card.factoryProjectId,
      workItemId: card.id,
      ingress: { identity, triggerType: `${BEADS_INTEGRATION_ID}.${key}` },
      configVersion: runtime.configVersion,
      expectedRevision: card.revision,
      // System, not an external actor: the dispatcher asks no consent for it (rules/dispatcher.js:193-201).
      actor: { type: 'system', id: `integration:${BEADS_INTEGRATION_ID}` },
      outcome: { status: 'accepted' },
      decisions,
      causalChain: [],
      now: new Date(),
    });
    if (result.status === 'missing' || result.status === 'replayed') return result.status;
    return result.result.status === 'accepted' ? 'committed' : 'rejected';
  }

  /**
   * The overview card of container bead `id`, made on first need: an epic,
   * milestone or molecule root with at least one child. Its own container is
   * resolved first, so a card is always made after its parent's: Factory
   * validates `parentWorkItemId` against the cards already in the project
   * (storage/domains/work-items/base.js:318-332, called on create at :2484).
   *
   * Resolved once per container per sweep. `trail` holds the ids being
   * resolved below this one, so a parent cycle ends instead of waiting on itself.
   *
   * Undefined when there is no card to link under: the bead is not a
   * container, is closed, cannot be read, has no children (owner decision
   * 2026-10-09: a childless container gets no overview card), or is carded in
   * another project. Never throws.
   */
  #overview(scope: IntakeScope, id: string, trail: Set<string>): Promise<WorkItemRow | undefined> {
    if (trail.has(id)) return Promise.resolve(undefined);
    let pending = scope.overviews.get(id);
    if (!pending) {
      pending = this.#resolveOverview(scope, id, new Set([...trail, id])).catch(error => {
        this.#log.warn(`[factory-beads] ${scope.slug}: no overview card for ${id}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      });
      scope.overviews.set(id, pending);
    }
    return pending;
  }

  async #resolveOverview(scope: IntakeScope, id: string, trail: Set<string>): Promise<WorkItemRow | undefined> {
    const runtime = this.#ctx!.runtime!;
    const bead = await scope.repo.show(id);
    if (!bead) {
      this.#warnOnce(
        `unreadable:${scope.slug}:${id}`,
        `[factory-beads] ${scope.slug}: parent ${id} cannot be read with bd show; its children are carded without an overview card`,
      );
      return undefined;
    }
    if (!(OVERVIEW_TYPES as readonly string[]).includes(bead.issue_type ?? '') || bead.status === 'closed') return undefined;
    const children = await scope.repo.children(id);
    if (children.length === 0) return undefined;
    const open = children.filter(child => child.status !== 'closed').length;
    scope.counted.set(id, { open, total: children.length });
    const parent = bead.parent ? await this.#overview(scope, bead.parent, trail) : undefined;

    let card: WorkItemRow | undefined =
      (await runtime.workItems.getByProjectSource({ orgId: scope.orgId, factoryProjectId: scope.projectId, source: beadSource(id) })) ??
      undefined;
    if (card) {
      scope.report.existing++;
      // Only on change: every metadata write bumps the card's revision.
      if (card.metadata?.[BEADS_META.cardKind] !== OVERVIEW_CARD_KIND || card.metadata?.[BEADS_META.openChildren] !== open) {
        card = await this.#mark(scope.orgId, card, { [BEADS_META.cardKind]: OVERVIEW_CARD_KIND, [BEADS_META.openChildren]: open });
      }
      if (parent) card = await this.#linkParent(scope, card, parent);
    } else {
      card = await this.#createCard(scope, bead, parent, { [BEADS_META.cardKind]: OVERVIEW_CARD_KIND, [BEADS_META.openChildren]: open });
      if (!card) {
        this.#warnOnce(
          `claimed:${scope.projectId}:${scope.slug}:${id}`,
          `[factory-beads] ${scope.slug}: ${id} is carded in another project, so its children in project ${scope.projectId} are carded without an overview card`,
        );
        return undefined;
      }
    }
    await this.#postDescription(card, bead);
    return card;
  }

  /** A new card for `bead`, under `parent` when given. Undefined when another project in the org holds its claim. */
  async #createCard(
    scope: IntakeScope,
    bead: Pick<BeadDetails, 'id' | 'title' | 'issue_type' | 'priority'>,
    parent: WorkItemRow | undefined,
    metadata: Record<string, unknown>,
  ): Promise<WorkItemRow | undefined> {
    const { orgId, projectId, slug } = scope;
    try {
      const result = await this.#ctx!.runtime!.workItems.upsert({
        orgId,
        userId: `integration:${BEADS_INTEGRATION_ID}`,
        factoryProjectId: projectId,
        reuseMode: 'preserve',
        input: {
          board: this.board,
          externalSource: beadSource(bead.id),
          claimKey: beadsClaimKey(slug, bead.id),
          title: `${bead.id}: ${bead.title ?? ''}`,
          stages: [scope.initialPhase],
          ...(parent ? { parentWorkItemId: parent.id } : {}),
          metadata: {
            [BEADS_META.id]: bead.id,
            [BEADS_META.repo]: slug,
            [FACTORY_REPOSITORY_META]: slug,
            [BEADS_META.type]: bead.issue_type ?? null,
            [BEADS_META.priority]: bead.priority ?? null,
            ...metadata,
          },
        },
      });
      if (result.created) scope.report.created++;
      else scope.report.existing++;
      return result.item;
    } catch (error) {
      // Another project in the org already carries this bead.
      if (error instanceof WorkItemClaimConflictError) {
        scope.report.existing++;
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Put a card made before its container's overview card under it. Only a
   * card with no parent is touched, and setParentWorkItemIfMissing itself
   * leaves a set parent alone (storage/domains/work-items/base.js:2512-2530),
   * so a link a person made by hand stays. A relation Factory refuses is
   * logged once, not thrown.
   */
  async #linkParent(scope: IntakeScope, card: WorkItemRow, parent: WorkItemRow): Promise<WorkItemRow> {
    if (card.parentWorkItemId) return card;
    try {
      const linked = await this.#ctx!.runtime!.workItems.setParentWorkItemIfMissing({
        orgId: scope.orgId,
        id: card.id,
        userId: `integration:${BEADS_INTEGRATION_ID}`,
        parentWorkItemId: parent.id,
      });
      return linked ?? card;
    } catch (error) {
      if (!(error instanceof WorkItemRelationError)) throw error;
      this.#warnOnce(`relation:${card.id}:${parent.id}`, `[factory-beads] ${scope.slug}: card ${card.id} not linked under ${parent.id}: ${error.message}`);
      return card;
    }
  }

  #warnOnce(key: string, message: string): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.#log.warn(message);
  }

  async #syncWithRetry(repo: BdRepo, credentials: RepoCredentials | undefined): Promise<BdResult> {
    const retries = this.#options.syncRetry?.retries ?? 2;
    const base = this.#options.syncRetry?.baseDelayMs ?? 2_000;
    let result = await repo.sync(credentials);
    for (let attempt = 0; result.code === 3 && attempt < retries; attempt++) {
      await sleep(base * 2 ** attempt);
      result = await repo.sync(credentials);
    }
    return result;
  }

  /**
   * Put the bead's description on the card's feed as one integration-authored
   * comment. Every invokeSkill kickoff (triage, plan, build) appends the
   * card's recent feed as a `<work-item-feed>` block (rules/dispatcher.js:635-639,
   * storage/domains/comments/feed-context.js), so this is how the agent sees it.
   *
   * Idempotent on `externalSource`: the store returns the existing row for a
   * repeated source key (storage/domains/comments/base.js:180-191). The
   * in-memory set only saves the repeat call (and its feed refresh) within one
   * process; after a restart each card is replayed once, harmlessly.
   *
   * The first description posted is kept. Integrations get only
   * `feed.createComment` (integrations/base.d.ts:94-95), not `editComment`, so
   * a later edit to the bead is not mirrored; see docs/operations/beads.md.
   *
   * Never throws: a feed failure must not stop intake or write-back.
   */
  async #postDescription(card: WorkItemRow, bead: Pick<BeadDetails, 'id' | 'description'>): Promise<void> {
    const description = typeof bead.description === 'string' ? bead.description : '';
    if (!description.trim() || this.#described.has(card.id)) return;
    const feed = this.#ctx?.feed;
    if (!feed) {
      if (!this.#feedMissingLogged) {
        this.#feedMissingLogged = true;
        this.#log.warn('[factory-beads] the Factory feed is not available; bead descriptions are not posted to cards');
      }
      return;
    }
    try {
      const result = await feed.createComment({
        orgId: card.orgId,
        workItemId: card.id,
        author: BEADS_COMMENT_AUTHOR,
        body: descriptionBody(description),
        externalSource: { integrationId: BEADS_INTEGRATION_ID, type: 'description', externalId: bead.id },
        // Placed at the card's creation, like an issue body: it reads first in
        // the feed, and back-filling an old card does not bump its activity.
        occurredAt: new Date(card.createdAt),
      });
      if (result.status === 'created') this.#described.add(card.id);
      else this.#log.warn(`[factory-beads] description for ${bead.id} not posted to card ${card.id}: ${result.status}`);
    } catch (error) {
      this.#log.warn(
        `[factory-beads] description for ${bead.id} not posted to card ${card.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #closeReason(item: WorkItemRow): string {
    return this.#options.closeReason?.(item) ?? `Factory card ${item.id} reached ${this.donePhase}`;
  }

  async #mark(orgId: string, item: WorkItemRow, metadata: Record<string, unknown>): Promise<WorkItemRow> {
    const updated = await this.#ctx!.runtime!.workItems.update({
      orgId,
      id: item.id,
      userId: `integration:${BEADS_INTEGRATION_ID}`,
      patch: { metadata },
    });
    return updated?.item ?? item;
  }

  /**
   * Ask for a parked repo to be reset. Only flags its parked cards; the worker
   * holding the writer lease drops the local copy on its next tick, so this is
   * safe from any process.
   */
  async requestReset(orgId: string, slug: string): Promise<{ flagged: number }> {
    const runtime = this.#ctx?.runtime;
    if (!runtime) return { flagged: 0 };
    let flagged = 0;
    const linked = (await this.#linkedRepos(this.#ctx!)).filter(r => r.orgId === orgId && r.slug === slug);
    // Parked by an agent-tool write: the marker is in the copy, not on a card.
    // Counted as one; the worker drops the copy (and the marker) under the lease.
    if (linked.length > 0 && new BdRepo(slug, cacheDirFor(this.#cacheRoot, slug), '', this.#runner).parkedReason()) {
      this.#resetRepos.add(slug);
      flagged++;
    }
    for (const project of linked) {
      for (const item of await runtime.workItems.list({ orgId, factoryProjectId: project.projectId })) {
        const state = item.metadata?.[BEADS_META.writeback];
        if (item.metadata?.[BEADS_META.repo] !== slug || (state !== 'conflict' && state !== 'close-failed')) continue;
        await this.#mark(orgId, item, { [BEADS_META.writeback]: 'reset-requested' satisfies WritebackState });
        flagged++;
      }
    }
    if (flagged > 0) this.kick();
    return { flagged };
  }
  routes(ctx: IntegrationContext): ApiRoute[] {
    const auth = ctx.auth;
    type Ctx = Parameters<typeof auth.ensureUser>[0];
    const tenantOf = async (c: unknown) => {
      if (!auth.enabled()) return undefined;
      await auth.ensureUser(c as Ctx);
      return auth.tenant(c as Ctx) ?? undefined;
    };
    const forOrg = (summary: SweepSummary | undefined, orgId: string) =>
      summary ? { ...summary, repos: summary.repos.filter(r => r.orgId === orgId) } : null;
    return [
      registerApiRoute('/web/beads/status', {
        method: 'GET',
        requiresAuth: false,
        handler: async c => {
          const tenant = await tenantOf(c);
          if (!tenant?.orgId) return c.json({ error: 'unauthorized' }, 401);
          const lastSweep = forOrg(this.#last, tenant.orgId);
          return c.json({
            diagnostics: this.diagnostics(),
            // One row per linked repository: ok | no-beads-data | error | parked.
            repos: (lastSweep?.repos ?? []).map(r => ({
              repo: r.repo,
              projectId: r.projectId,
              state: r.state,
              ...(r.diagnostic ? { reason: r.diagnostic } : {}),
              checkedAt: r.checkedAt,
              ...(r.nextCheckAt ? { nextCheckAt: r.nextCheckAt } : {}),
            })),
            lastSweep,
          });
        },
      }),
      registerApiRoute('/web/beads/sync', {
        method: 'POST',
        requiresAuth: false,
        handler: async c => {
          const tenant = await tenantOf(c);
          if (!tenant?.orgId) return c.json({ error: 'unauthorized' }, 401);
          if (!(await auth.isOrganizationAdmin(c as Ctx, tenant.orgId))) return c.json({ error: 'forbidden' }, 403);
          const outcome = await this.syncNow();
          return c.json(outcome.ran ? { ran: true, sweep: forOrg(outcome.result, tenant.orgId) } : outcome);
        },
      }),
      registerApiRoute('/web/beads/reset', {
        method: 'POST',
        requiresAuth: false,
        handler: async c => {
          const tenant = await tenantOf(c);
          if (!tenant?.orgId) return c.json({ error: 'unauthorized' }, 401);
          if (!(await auth.isOrganizationAdmin(c as Ctx, tenant.orgId))) return c.json({ error: 'forbidden' }, 403);
          const body = (await c.req.json().catch(() => ({}))) as { repo?: unknown };
          if (typeof body.repo !== 'string' || !body.repo) return c.json({ error: 'repo_required' }, 400);
          return c.json(await this.requestReset(tenant.orgId, body.repo));
        },
      }),
    ];
  }
}

/** Author of the description comment. Ids with a `:` are never mentionable (comments/actor.d.ts). */
export const BEADS_COMMENT_AUTHOR = { kind: 'integration', id: `integration:${BEADS_INTEGRATION_ID}`, displayName: 'beads' } as const;

/** Factory rejects a comment body over this many UTF-16 code units (storage/domains/comments/base.js:33,37-40). */
export const MAX_COMMENT_BODY = 16_000;

/** The comment body for a description, cut to fit the body limit with a note when it is too long. */
export function descriptionBody(description: string): string {
  if (description.length <= MAX_COMMENT_BODY) return description;
  const note = `\n\n[Truncated: the bead's description is ${description.length} characters; the full text is in beads.]`;
  let cut = MAX_COMMENT_BODY - note.length;
  // Never split a surrogate pair.
  const code = description.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return description.slice(0, cut) + note;
}

/** A bead card's external source. The same for a work card and an overview card. */
function beadSource(beadId: string): ExternalWorkItemSource {
  return { integrationId: BEADS_INTEGRATION_ID, type: 'issue', externalId: beadId };
}

/** The org-wide claim for one bead: a repo's bead is carded by one project at a time. */
export function beadsClaimKey(repo: string, beadId: string): string {
  return `beads:${repo}:${beadId}`;
}
