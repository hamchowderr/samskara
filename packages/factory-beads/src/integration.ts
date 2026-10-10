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
import { LiveSessions } from '@mastra/factory/session/live-sessions';
import { WorkItemClaimConflictError, WorkItemRelationError } from '@mastra/factory/storage/domains/work-items/base';
import type { ExternalWorkItemSource, WorkItemRow } from '@mastra/factory/storage/domains/work-items/base';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBeadsTools, resolveToolProject } from './agent-tools';
import type { ToolScope } from './agent-tools';
import { registerLive } from './done-rule';
import { BdRepo, cacheDirFor, OVERVIEW_TYPES, resultTail } from './repo';
import type { BeadDetails, BeadRow, BeadSnapshot } from './repo';
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
  /**
   * `overview` on a container's card, `research` on an open decision's card,
   * `plan` on a childless open epic's card; absent on a work card.
   */
  cardKind: 'beadsCardKind',
  /** Overview cards: how many of the container's direct children are not closed. */
  openChildren: 'beadsOpenChildren',
  /**
   * Overview cards parked `close-failed` in Done: when the write-back was
   * re-armed after the last child closed. Set once; a card is re-armed once.
   */
  closeRearmedAt: 'beadsCloseRearmedAt',
  /**
   * The phase a card is being moved to because its bead was closed outside
   * the Factory (samskara-l2t.3): the done phase, or the canceled phase for
   * a superseded, duplicate or dismissed bead. Set before the move is
   * committed, cleared once the bead is open again. Write-back reads it to
   * mark such a card synced without closing or syncing anything when it is
   * the done phase, and the board policy reads it to let any system move to
   * that phase through (board-rules.ts, `isClosedOutsideMove`). A canceled
   * phase here never stands for a close to skip: a person's later move of
   * the card to Done is written back as usual.
   */
  closedOutside: 'beadsClosedOutside',
  /**
   * How many stage-history entries the card had when `closedOutside` was
   * set. An entry for the marked phase at or after that index is the card's
   * arrival there.
   */
  closedOutsideMoves: 'beadsClosedOutsideMoves',
  /**
   * When the card was found to have reached the phase `closedOutside`
   * names. From then on, while its bead stays closed, the closed-outside
   * path never moves the card again: a person who moves it out of Canceled
   * (or Done) keeps that move, as `syncedAt` already does for Done.
   */
  closedOutsideAt: 'beadsClosedOutsideAt',
  /**
   * A reopen move is committed and waits for the dispatcher: the card's
   * stage-history length when it was committed. While the card has not
   * moved since (same length), write-back leaves it alone; once it has, the
   * marker is stale and cleared, so a person's later Done closes the bead.
   */
  reopenPending: 'beadsReopenPending',
  /**
   * When write-back closed the bead in the local copy and the `bd sync`
   * that publishes it failed (exit 1, or 3 after retries). Such a card stays
   * pending for sync wherever it is, so a person moving it out of Done does
   * not strand the close unpublished, and the closed-outside path never
   * takes it for a bead closed in bd. Cleared when it is marked synced.
   */
  localClose: 'beadsLocalClose',
  /**
   * Status sync (samskara-l2t.4): the bead's status as the sweep last wrote
   * or read it. A bead whose status differs from this was changed in bd.
   */
  status: 'beadsStatus',
  /**
   * Status sync: the card's phase when `status` was recorded. A card in
   * another phase was moved since, and its move is written to the bead.
   */
  statusStage: 'beadsStatusStage',
  /**
   * Status sync: the bead's status while it is one no work starts on
   * (blocked, deferred, pinned, hooked or a custom status); unset otherwise.
   * The board policy reads it to refuse starting work on the card
   * (board-rules.ts), and the sweep moves such a card out of a working phase
   * to Intake once no run on it is in flight.
   */
  held: 'beadsHeld',
  /**
   * The bead title the card's title was last set from (samskara-l2t.8). A
   * bead whose title differs from it was retitled in bd, and the card follows.
   */
  title: 'beadsTitle',
} as const;

/**
 * The bead statuses status sync writes and work starts on (samskara-l2t.4).
 * Every other status that is not `closed` holds the card: blocked, deferred,
 * pinned and hooked (bd statuses, v1.3.1) and any custom status.
 */
export const WORKABLE_STATUSES = ['open', 'in_progress'] as const;

/** The bead status a card in a phase of this kind asks for; undefined: none (the done phase is write-back's). */
function statusForPhase(kind: string | undefined, stage: string, donePhase: string): 'open' | 'in_progress' | undefined {
  if (kind === 'working') return 'in_progress';
  if (stage === donePhase) return undefined;
  return 'open';
}

/** How many phases the card has entered: Factory appends one stage-history entry per phase entered (work-items/base.js:338-356). */
function stageMoves(card: WorkItemRow): number {
  return Array.isArray(card.stageHistory) ? card.stageHistory.length : 0;
}

/** Whether a committed reopen move still waits: the card has not moved since it was committed. */
function isReopenPending(card: WorkItemRow): boolean {
  const recorded = card.metadata?.[BEADS_META.reopenPending];
  return typeof recorded === 'number' && recorded === stageMoves(card);
}

/** Whether a card marked `closedOutside` has reached the phase the marker names since it was set. */
function arrivedClosedOutside(card: WorkItemRow): boolean {
  const meta = card.metadata ?? {};
  if (meta[BEADS_META.closedOutsideAt]) return true;
  const target = meta[BEADS_META.closedOutside];
  const from = meta[BEADS_META.closedOutsideMoves];
  if (typeof target !== 'string' || typeof from !== 'number') return false;
  return (card.stageHistory ?? []).slice(from).some(entry => entry.stage === target);
}

/**
 * The patch that clears a card's recorded close: the write-back markers when
 * a close was recorded (`syncedAt`), and the closed-outside markers. Only
 * keys that are set, so a card with nothing to clear is not written.
 */
function clearedCloseMarkers(meta: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of [BEADS_META.closedOutside, BEADS_META.closedOutsideMoves, BEADS_META.closedOutsideAt]) {
    if (meta[key] !== undefined && meta[key] !== null) patch[key] = null;
  }
  if (meta[BEADS_META.syncedAt]) {
    Object.assign(patch, {
      [BEADS_META.syncedAt]: null,
      [BEADS_META.writeback]: null,
      [BEADS_META.closeAttempts]: 0,
      [BEADS_META.diagnostic]: null,
      [BEADS_META.closeRearmedAt]: null,
    });
  }
  return patch;
}

/** `BEADS_META.cardKind` of an epic's, milestone's or molecule root's card. */
export const OVERVIEW_CARD_KIND = 'overview';

/**
 * `BEADS_META.cardKind` of an open `decision` bead's card: a research card.
 * An agent researches the options and writes the decision into the bead; a
 * person approves it by moving the card to Done, which closes the bead
 * (owner decision, samskara-l2t.2). It never builds. A closed decision is a
 * record and is never ready, so it is never carded.
 */
export const RESEARCH_CARD_KIND = 'research';

/** The bd issue type whose open beads become research cards. */
export const DECISION_TYPE = 'decision';

/**
 * `BEADS_META.cardKind` of an open epic's card while the epic has no
 * children: a planning card (owner decision, samskara-l2t.2; built in
 * samskara-l2t.2.4). In Planning an agent proposes child beads into the
 * epic's notes and creates nothing. A person approves by moving the card to
 * Building, where a run files exactly the approved children and moves the
 * card back to Intake. The next sweep finds the children and makes it an
 * overview card. Only a person ever moves it to Building, whatever the
 * project's auto-approve-plans setting (board-rules.ts).
 */
export const PLAN_CARD_KIND = 'plan';

/** The bd issue type whose childless open beads become planning cards. */
export const EPIC_TYPE = 'epic';

/**
 * The card kind intake gives a ready bead that is not an epic: `research` for
 * a decision, none for work. Epics are sorted in the intake loop, and
 * overview kinds are set by #resolveOverview.
 */
function readyCardKind(bead: Pick<BeadDetails, 'issue_type'>): string | undefined {
  return bead.issue_type === DECISION_TYPE ? RESEARCH_CARD_KIND : undefined;
}

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
  /**
   * Terminal phase a card moves to when its bead is superseded, marked a
   * duplicate or dismissed outside the Factory (samskara-l2t.3). Default
   * `canceled`; when the board has no such terminal phase, the done phase.
   */
  canceledPhase?: string;
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

/** How a repository's diagnostic starts when the refresh read failed (#readSnapshot). */
const REFRESH_FAILED = 'refresh read failed';

/** The ref beads publishes its Dolt data to (bd's git remote). */
export const BEADS_DATA_REF = 'refs/dolt/data';

/** What a sweep reads from the installed board (BoardDefinition, boards/define-board.d.ts). */
interface BoardPhases {
  readonly initialPhase: string;
  phaseKind(phase: string): string | undefined;
  /** The seat a working phase's run takes; undefined for a resting or terminal phase. */
  roleForPhase(phase: string): string | undefined;
}

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
  /** Open containers whose children were read this sweep and that have none, by bead id. */
  childless: Set<string>;
  /**
   * The refresh read (samskara-l2t.15, BdRepo.refresh): every bead of the
   * copy and each one's children, read once after the copy's last change in
   * this sweep. Undefined when the read failed: every step that needs a
   * bead's state or its children is skipped for the repository this sweep.
   */
  snapshot: BeadSnapshot | undefined;
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
  readonly canceledPhase: string;
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
  /** Keys of warnings already logged, so each repeats once per process, not once per sweep. */
  readonly #warned = new Set<string>();
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
  /**
   * Which sessions run or are parked on a tool: Factory's own registry, the
   * one its work-item list route reads for the board's running and parked
   * sessions (@mastra/factory 0.20.0 dist/routes/work-items.js:249-250,
   * dist/session/live-sessions.js). Undefined without an agent controller.
   */
  #liveSessions: LiveSessions | undefined;
  /** Repositories parked by an agent-write conflict whose reset was requested (POST /web/beads/reset). */
  readonly #resetRepos = new Set<string>();
  /** Repositories (slug) whose refresh read is failing: warned once per failure streak. */
  readonly #refreshFailing = new Set<string>();

  constructor(options: BeadsIntegrationOptions) {
    this.#options = options;
    this.board = options.board ?? 'work';
    this.donePhase = options.donePhase ?? 'done';
    this.canceledPhase = options.canceledPhase ?? 'canceled';
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
    // The sessions this process runs, as Factory's own board reads them
    // (status sync, samskara-l2t.4). Built now, at boot, so it hears every
    // session the controller creates from here on.
    if (ctx.controller && !this.#liveSessions) this.#liveSessions = new LiveSessions(ctx.controller);
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
          await this.#syncRepo(linked, access.cloneUrl, credentials, board, report);
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
    board: BoardPhases,
    report: RepoSyncReport,
  ): Promise<void> {
    const runtime = this.#ctx!.runtime!;
    const initialPhase = board.initialPhase;
    const phaseKind = (phase: string) => board.phaseKind(phase);
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

    // 1. Write-back: cards durably in the done phase whose bead is not yet
    //    published, and cards whose bead write-back closed in the copy but
    //    whose sync failed (`beadsLocalClose`), wherever they are now. A card
    //    whose reopen move waits for the dispatcher is left alone: its bead
    //    is open again on purpose.
    const maxAttempts = this.#options.maxCloseAttempts ?? 3;
    const pending = cards.filter(item => {
      if (item.board !== this.board || item.stages.length !== 1 || item.metadata?.[BEADS_META.syncedAt]) return false;
      if (item.stages[0] !== this.donePhase) return Boolean(item.metadata?.[BEADS_META.localClose]);
      return (
        !isReopenPending(item) &&
        item.metadata?.[BEADS_META.writeback] !== 'close-failed' &&
        Number(item.metadata?.[BEADS_META.closeAttempts] ?? 0) < maxAttempts
      );
    });
    // Whether write-back closed, or tried to close, a bead this tick. When it
    // did not, the copy is pulled (or an agent write published) as on a tick
    // with nothing pending.
    let wroteBack = false;
    if (pending.length > 0) {
      // Each bead's status and holder come from one refresh read of the copy
      // as it is, before any pull, which is what the `bd show` per card it
      // replaces read, until the first close lands. A close can change other
      // beads: closing a molecule's last open step closes the root too (bd
      // v1.3.1 cmd/bd/close.go:700-735), and a root read before that still
      // shows its holder, so the handover would rewrite a closed bead's
      // assignee. From the first close on, each bead is read with `bd show`
      // right before its close, as before the refresh read. A failed read
      // falls back to `bd show` for every bead, so write-back never waits on
      // the refresh read.
      let before = await this.#readSnapshot(repo, report, 'write-back read each bead with bd show');
      const closed: WorkItemRow[] = [];
      for (const item of pending) {
        const beadId = String(item.metadata?.[BEADS_META.id]);
        // A bead the list leaves out (a gate, a wisp) is read with bd show, as before.
        const bead = before?.get(beadId) ?? (await repo.show(beadId));
        // Out of Done with a close made here that never reached the remote:
        // published with this tick's sync, never closed again. If the bead is
        // open in the copy now, there is nothing left to publish for it.
        if (item.stages[0] !== this.donePhase) {
          if (bead?.status === 'closed') {
            wroteBack = true;
            closed.push(item);
          } else {
            await this.#mark(orgId, item, { [BEADS_META.localClose]: null });
          }
          continue;
        }
        // Moved here because its bead was closed outside the Factory
        // (samskara-l2t.3, #followOutsideState): nothing to close and nothing
        // local to publish, so it is only marked synced. If the bead was
        // reopened since, it is not closed again: the reopen pass moves the
        // card back to Intake. Only a marker naming the done phase counts: a
        // card a person moved here from Canceled (marker `canceled`) is the
        // person's Done, and is closed and synced as usual.
        if (item.metadata?.[BEADS_META.closedOutside] === this.donePhase) {
          if (bead?.status === 'closed') {
            await this.#mark(orgId, item, {
              [BEADS_META.writeback]: 'synced' satisfies WritebackState,
              [BEADS_META.syncedAt]: new Date().toISOString(),
              [BEADS_META.diagnostic]: null,
            });
          }
          continue;
        }
        wroteBack = true;
        if (bead?.status === 'closed') {
          closed.push(item);
          continue;
        }
        // bd refuses to close a bead with an open child. Known from the
        // refresh read, the close is not tried at all: a refused close of a
        // claimed bead would hand it over and back, and the swap back leaves
        // the holder's claim without its lease (samskara-l2t.4). After the
        // first close there is no read to go by, and bd's own refusal decides.
        const openChildren = before?.children(beadId).filter(child => child.status !== 'closed').length ?? 0;
        const res =
          openChildren > 0
            ? { code: 1, stdout: '', stderr: `cannot close ${beadId}: ${openChildren} open child issue(s) (not tried)`, ms: 0, timedOut: false }
            : await repo.close(beadId, this.#closeReason(item), bead?.assignee);
        if (res.code === 0) {
          closed.push(item);
          before = undefined;
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
              ...(item.metadata?.[BEADS_META.localClose] ? { [BEADS_META.localClose]: null } : {}),
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
          // Marked, so they stay pending even if a person moves them out of
          // Done first, and step 7 never takes the local close for one made
          // in bd (which would mark them synced with nothing published).
          for (const item of closed) {
            if (!item.metadata?.[BEADS_META.localClose]) await this.#mark(orgId, item, { [BEADS_META.localClose]: new Date().toISOString() });
          }
          report.state = 'error';
          report.diagnostic = `bd sync exit ${sync.code}: ${resultTail(sync, 300)}`;
        }
      }
    }
    if (!wroteBack && this.#unpublished.has(slug)) {
      // A write is committed here (an agent tool's, or a status change) but
      // its own `bd sync` failed: publish it now. A pull alone would never push it.
      await this.#publish(repo, credentials, report, 'publishing an earlier write');
      if (report.state === 'parked') return;
    } else if (!wroteBack) {
      const pull = await repo.pull(credentials);
      if (pull.code !== 0) {
        report.state = 'error';
        report.diagnostic = `bd dolt pull exit ${pull.code}: ${resultTail(pull, 300)}`;
      }
    }

    // 2. Intake: one card per ready bead, idempotently, and its description
    //    on the card's feed (back-filled for cards that predate it). A bead
    //    with a parent container is linked under the container's overview
    //    card, which is made first. A bead whose parent is not a container (a
    //    task's subtask) is linked under the parent's card when it has one;
    //    ready parents are carded before their ready children, so that link
    //    is made in the same sweep.
    //    Every step from here reads bead state from one refresh read, taken
    //    now, after the copy's last change in this sweep (samskara-l2t.15).
    const scope: IntakeScope = {
      orgId,
      projectId,
      slug,
      repo,
      initialPhase,
      report,
      overviews: new Map(),
      counted: new Map(),
      childless: new Set(),
      // Read after write-back, never reused from before it: a close, a refused
      // close's handover and back, or the sync (which pulls) may have changed
      // the copy.
      snapshot: await this.#readSnapshot(repo, report, 'the overview steps skipped'),
    };
    const ready = parentsFirst(await repo.ready());
    // The beads intake handles this sweep: step 2b leaves their kind and parent to it.
    const readyIds = new Set(ready.map(bead => bead.id));
    for (const bead of ready) {
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
      let kind = readyCardKind(bead);
      // An open epic (bd ready lists one with open children too): with
      // children it is an overview card, made and counted by #overview; with
      // none, a planning card (samskara-l2t.2.4). Only a confirmed empty
      // children read makes a planning card: when the epic or its children
      // could not be read, or its card lives in another project, nothing is
      // carded or changed for it this sweep.
      if (bead.issue_type === EPIC_TYPE) {
        if (await this.#overview(scope, bead.id, new Set())) continue;
        if (!scope.childless.has(bead.id)) continue;
        kind = PLAN_CARD_KIND;
      }
      const parent = bead.parent ? await this.#parentCard(scope, bead.parent) : undefined;
      if (existing) {
        report.existing++;
        let card = existing;
        // The research and plan kinds follow the bead: set on a decision's or
        // a childless epic's card (one made before these kinds existed
        // included), cleared when the bead no longer qualifies. Only on
        // change: every metadata write bumps the card's revision. An overview
        // card's kind is left alone: an epic that lost its children is not
        // turned back into a planning card.
        const current = card.metadata?.[BEADS_META.cardKind];
        if (current !== OVERVIEW_CARD_KIND && (current ?? undefined) !== kind) {
          card = await this.#mark(orgId, card, { [BEADS_META.cardKind]: kind ?? null });
        }
        if (parent) card = await this.#linkParent(scope, card, parent);
        continue;
      }
      await this.#createCard(scope, bead, parent, kind ? { [BEADS_META.cardKind]: kind } : {});
    }

    // 2b. Bead edits on cards intake did not reach (samskara-l2t.8): every
    //     card's title follows its bead's, and a card whose bead is not ready
    //     (in_progress, blocked by a dependency, held) gets its kind and its
    //     parent link as intake gives a ready one.
    await this.#followBeadEdits(scope, readyIds);

    // 3. Open-children counts on the overview cards intake did not count this
    //    sweep: none of their children is ready, or the container itself is
    //    closed. #resolveOverview stops at a closed container before counting,
    //    so skipping every container intake touched froze a force-closed
    //    container's count while one of its children was still ready.
    //    The board policy reads the count to refuse Done while a child is
    //    open, and a policy may not read storage itself
    //    (configure-factory-rules/SKILL.md:63).
    //    A planning card intake did not reach (its epic is blocked, say) is
    //    resolved here too, so it becomes an overview card as soon as its
    //    epic has children, whether or not the epic is ready.
    //    Counts come from the refresh read, with no bd call per card. Without
    //    it (the read failed) no count is written, so step 4 moves nothing.
    const beads = scope.snapshot;
    for (const card of beads ? cards : []) {
      const beadId = card.metadata?.[BEADS_META.id];
      if (typeof beadId !== 'string' || card.stages.some(stage => phaseKind(stage) === 'terminal')) continue;
      if (card.metadata?.[BEADS_META.cardKind] === PLAN_CARD_KIND) {
        if (!scope.overviews.has(beadId)) await this.#overview(scope, beadId, new Set());
        continue;
      }
      if (card.metadata?.[BEADS_META.cardKind] !== OVERVIEW_CARD_KIND || scope.counted.has(beadId)) continue;
      try {
        const children = beads!.children(beadId);
        const open = children.filter(child => child.status !== 'closed').length;
        if (card.metadata?.[BEADS_META.openChildren] !== open) await this.#mark(orgId, card, { [BEADS_META.openChildren]: open });
        scope.counted.set(beadId, { open, total: children.length });
      } catch (error) {
        this.#log.warn(`[factory-beads] ${slug}: open-children count of ${beadId} not written: ${error instanceof Error ? error.message : String(error)}`);
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
    const moved = await this.#closeSettledOverviews(scope, phaseKind);

    // 5. Overview cards stranded in a working phase move to Intake: a
    //    planning card that became an overview card while it sat in Planning
    //    or Building, or a card made before overview cards existed.
    await this.#resetStrandedOverviews(scope, board, moved);

    // 6. Cards parked `close-failed` in Done whose children have all closed
    //    since: bd refuses to close any bead while a child is open.
    await this.#rearmParentCloses(scope, cards);

    // 7. Beads closed or reopened outside the Factory (samskara-l2t.3): a
    //    card whose bead was closed in bd moves to Done, or to Canceled when
    //    the bead was superseded, marked a duplicate or dismissed; a card in
    //    Done whose bead was reopened moves back to Intake.
    await this.#followOutsideState(scope, board);

    // 8. Status sync (samskara-l2t.4): a card's move sets its bead open or
    //    in_progress; a bead blocked, deferred or otherwise held in bd moves
    //    its card out of a working phase once no run on it is in flight.
    await this.#syncStatus(scope, board, credentials);
  }

  /**
   * Step 8 of a sweep (samskara-l2t.4). Reads bead state from the refresh
   * read only; without it nothing is written or moved this sweep. Each side
   * owns its own changes, so neither undoes the other:
   *
   * **Card to bead.** When the card's phase is not the one recorded with the
   * last sync (`beadsStatusStage`), the card moved, and its phase is written
   * to the bead: a working phase sets `in_progress`, Intake or Canceled sets
   * `open` (a canceled card leaves its bead open, owner decision). Done is
   * write-back's (step 1). The write is bd's compare-and-swap on the status
   * just read (BdRepo.setStatus), so a bead changed in bd meanwhile is left
   * alone and read again next sweep. Only `open` and `in_progress` are ever
   * replaced: a bead held in bd is never made workable by a card move. A bead
   * someone else holds `in_progress` (its assignee is not this integration's
   * actor) is never set back to `open`: the claim is theirs. Only the phase
   * change is written, never the phase itself on every sweep, so a person who
   * sets the bead `open` in bd while its card is in Building keeps that.
   *
   * **Bead to card.** A change in bd moves a card only when it holds the
   * bead (`beadsHeld`: blocked, deferred, pinned, hooked, or a custom
   * status). A held card in a working phase moves to Intake, but not while
   * a run on it is in flight (owner decision: it moves after the run
   * finishes): Factory keeps the run's `invokeSkill` decision leased until
   * the run settles (@mastra/factory 0.20.0 rules/dispatcher.js:420-422,
   * 687), so a card with a pending, leased or retrying `invokeSkill`
   * decision waits for a later sweep. The board policy refuses to start work
   * on a held card (board-rules.ts), so the card stays in Intake until the
   * bead is open or in_progress again; moves between working phases are
   * left alone, so a run that is still going is never refused. The move to
   * Intake is not written back: the bead is held.
   *
   * Overview cards are left out (their bead closes with its children), as
   * are a card whose bead is closed (write-back and step 7 own it) and one
   * whose reopen move waits for the dispatcher.
   */
  async #syncStatus(scope: IntakeScope, board: BoardPhases, credentials: RepoCredentials | undefined): Promise<void> {
    const { orgId, projectId, slug, repo, snapshot, initialPhase, report } = scope;
    if (!snapshot) return;
    const runtime = this.#ctx!.runtime!;
    const actor = this.#runner.actor;
    // Re-read: earlier steps moved revisions.
    const cards = await runtime.workItems.list({ orgId, factoryProjectId: projectId });
    let inFlight: Set<string> | undefined;
    let wrote = false;
    for (let card of cards) {
      if (card.externalSource?.integrationId !== BEADS_INTEGRATION_ID || card.metadata?.[BEADS_META.repo] !== slug) continue;
      const beadId = card.metadata?.[BEADS_META.id];
      if (typeof beadId !== 'string' || card.board !== this.board || card.stages.length !== 1) continue;
      const meta = card.metadata ?? {};
      if (isReopenPending(card)) continue;
      const bead = snapshot.get(beadId);
      if (!bead?.status) continue;
      // A closed bead's card is left until it reaches Done or Canceled, and an
      // overview card until it leaves its working phase: step 7 or step 5 may
      // have just committed its move, and a marker write here would bump the
      // revision that move names and have it committed again next sweep.
      if (bead.status === 'closed' && board.phaseKind(card.stages[0]!) !== 'terminal') continue;
      if (meta[BEADS_META.cardKind] === OVERVIEW_CARD_KIND && board.phaseKind(card.stages[0]!) === 'working') continue;
      if (bead.status === 'closed' || meta[BEADS_META.cardKind] === OVERVIEW_CARD_KIND) {
        try {
          if (await this.#leaveStatusSync(scope, board, card, bead, actor)) wrote = true;
        } catch (error) {
          this.#log.warn(`[factory-beads] ${slug}: status markers of ${beadId} not cleared: ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
      const stage = card.stages[0]!;
      const kind = board.phaseKind(stage);
      let status = bead.status;
      try {
        const patch: Record<string, unknown> = {};
        if (meta[BEADS_META.statusStage] !== stage) {
          const wanted = statusForPhase(kind, stage, this.donePhase);
          const theirs = Boolean(bead.assignee) && bead.assignee !== actor;
          const workable = (WORKABLE_STATUSES as readonly string[]).includes(status);
          if (wanted && wanted !== status && workable && !(wanted === 'open' && theirs)) {
            const res = await repo.setStatus(beadId, wanted, status);
            // 13: the status changed since the refresh read; read again next sweep.
            if (res.code === 13) continue;
            if (res.code !== 0) {
              this.#log.warn(`[factory-beads] ${slug}: status of ${beadId} not set to ${wanted}: exit ${res.code}: ${resultTail(res, 300)}`);
              continue;
            }
            this.#log.info(`[factory-beads] ${slug}: card of ${beadId} moved to ${stage}; its bead goes from ${status} to ${wanted}`);
            status = wanted;
            wrote = true;
          }
          patch[BEADS_META.statusStage] = stage;
        }
        if (meta[BEADS_META.status] !== status) patch[BEADS_META.status] = status;
        const held = (WORKABLE_STATUSES as readonly string[]).includes(status) ? null : status;
        if ((meta[BEADS_META.held] ?? null) !== held) patch[BEADS_META.held] = held;
        if (Object.keys(patch).length > 0) card = await this.#mark(orgId, card, patch);
        if (!held || kind !== 'working') continue;
        inFlight ??= await this.#inFlightRuns(orgId, projectId);
        if (inFlight.has(card.id) || this.#sessionLive(card)) continue;
        const result = await this.#commitTransition(orgId, card, initialPhase, 'held');
        if (result === 'committed') {
          this.#log.info(`[factory-beads] ${slug}: ${beadId} is ${held} in bd and no run on its card is in flight; the card moves from ${stage} to ${initialPhase}`);
        }
      } catch (error) {
        this.#log.warn(
          `[factory-beads] ${slug}: status of ${beadId} not synced: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (wrote) await this.#publish(repo, credentials, report, 'publishing a status change');
  }

  /**
   * A card status sync stops following: its bead is closed (write-back and
   * step 7 own it from here), or it became an overview card (its bead closes
   * with its children). The hold and the recorded pair are cleared, so a
   * person who later moves the card out of Done is not refused for a hold
   * the closed bead no longer has. An overview card whose epic this sync set
   * `in_progress` while it was a planning card in Planning or Building (the
   * pair recorded on the card says so) has its epic set back to `open`
   * first, unless someone else holds it: an
   * overview card rests in Intake (samskara-l2t.2.2). Returns whether it
   * wrote to the bead; the caller publishes.
   */
  async #leaveStatusSync(scope: IntakeScope, board: BoardPhases, card: WorkItemRow, bead: BeadRow, actor: string): Promise<boolean> {
    const meta = card.metadata ?? {};
    if (meta[BEADS_META.statusStage] == null && meta[BEADS_META.held] == null) return false;
    const beadId = String(meta[BEADS_META.id]);
    const theirs = Boolean(bead.assignee) && bead.assignee !== actor;
    let wrote = false;
    // Only an in_progress this sync wrote: the one recorded with a working phase.
    const ours = meta[BEADS_META.status] === 'in_progress' && board.phaseKind(String(meta[BEADS_META.statusStage])) === 'working';
    if (meta[BEADS_META.cardKind] === OVERVIEW_CARD_KIND && bead.status === 'in_progress' && ours && !theirs) {
      const res = await scope.repo.setStatus(beadId, 'open', 'in_progress');
      // 13: changed in bd since the read; theirs to keep, and nothing is left to undo.
      if (res.code !== 0 && res.code !== 13) throw new Error(`bd update exit ${res.code}: ${resultTail(res, 300)}`);
      wrote = res.code === 0;
      if (wrote) this.#log.info(`[factory-beads] ${scope.slug}: ${beadId} became an overview card; its bead goes from in_progress to open`);
    }
    await this.#mark(scope.orgId, card, { [BEADS_META.statusStage]: null, [BEADS_META.status]: null, [BEADS_META.held]: null });
    return wrote;
  }

  /**
   * Whether a session bound to the card runs a turn or is parked on a tool
   * (an `ask_user` question, a `submit_plan` awaiting approval), as Factory's
   * own board reads it. Such a run has not finished: a parked run's decision
   * has already completed (its turn ended with `agent_end` reason
   * `suspended`, which `watchRun.settle` does not fail, rules/dispatcher.js:
   * 105-123), and a run a stage message started (Review, which has no
   * `onEnter` rule, rules/transition-service.js:299-309) never had an
   * `invokeSkill` decision. Only sessions this process has materialized are
   * known: after a restart, a session is known again once it is used.
   */
  #sessionLive(card: WorkItemRow): boolean {
    const live = this.#liveSessions;
    if (!live) return false;
    return Object.values(card.sessions ?? {}).some(
      entry => typeof entry?.sessionId === 'string' && (live.isRunning(entry.sessionId) || live.parked(entry.sessionId) !== undefined),
    );
  }

  /**
   * The cards of the project with a run in flight: a pending, leased or
   * retrying `invokeSkill` decision. The dispatcher holds such a decision
   * leased, renewing it, until the run it started settles
   * (@mastra/factory 0.20.0 rules/dispatcher.js:420-422, 687, 1023-1028).
   */
  async #inFlightRuns(orgId: string, projectId: string): Promise<Set<string>> {
    const runtime = this.#ctx!.runtime!;
    const out = new Set<string>();
    let before: { createdAt: Date; id: string } | undefined;
    for (;;) {
      const page = await runtime.workItems.listDeferredDecisionPage({
        orgId,
        factoryProjectId: projectId,
        statuses: ['pending', 'leased', 'retry'],
        limit: 200,
        ...(before ? { before } : {}),
      });
      for (const record of page.decisions) {
        if (record.workItemId && record.decision?.type === 'invokeSkill') out.add(record.workItemId);
      }
      const last = page.decisions.at(-1);
      if (!page.hasMore || !last) return out;
      before = { createdAt: last.createdAt, id: last.id };
    }
  }

  /**
   * Publish writes committed in the copy (`bd sync`). Returns whether it
   * published. A conflict (2) or stuck working set (4) parks the repository
   * until an operator resets it, as for an agent-tool write; any other
   * failure leaves the write for the next tick to publish.
   */
  async #publish(repo: BdRepo, credentials: RepoCredentials | undefined, report: RepoSyncReport, what: string): Promise<boolean> {
    const sync = await this.#syncWithRetry(repo, credentials);
    if (sync.code === 0) {
      this.#unpublished.delete(repo.slug);
      return true;
    }
    if (sync.code === 2 || sync.code === 4) {
      // Never retried: park until an operator resets.
      const diagnostic = `bd sync exit ${sync.code} ${what}: ${resultTail(sync, 600)}`;
      await repo.park(diagnostic);
      this.#unpublished.delete(repo.slug);
      report.state = 'parked';
      report.diagnostic = `${diagnostic}; resolve it, then POST /web/beads/reset`;
      return false;
    }
    this.#unpublished.add(repo.slug);
    report.state = 'error';
    report.diagnostic = `bd sync exit ${sync.code} (${what}): ${resultTail(sync, 300)}`;
    return false;
  }

  /**
   * Step 7 of a sweep (samskara-l2t.3). Reads bead state from the refresh
   * read only; without it nothing moves this sweep.
   *
   * **Closed outside.** A card in a resting or working phase whose bead is
   * closed, and that write-back did not close (no `beadsSyncedAt`), is
   * committed to the done phase, or to the canceled phase when
   * `closedOutsideOutcome` says the bead was not completed. Linear's
   * issue-closed rule does the same for a Linear card
   * (@mastra/factory 0.20.0 dist/integrations/linear/default-rules.js:35-49:
   * canceled to `canceled`, otherwise `done`, whatever the card's phase).
   * The card is first marked `beadsClosedOutside` with the target, so
   * write-back marks it synced without a close or a sync when the target is
   * the done phase, and the board policy lets the system move a research or
   * plan card whose bead is already closed: nothing is left for a person to
   * approve. Once the card has reached the target (`arrivedClosedOutside`:
   * its stage history since the marker, or this step finding it there,
   * recorded as `beadsClosedOutsideAt`), it is never moved for that close
   * again: a person who moves it out of Canceled keeps the move, as one who
   * moves it out of Done does through `beadsSyncedAt`. A card whose close
   * write-back made locally but could not sync (`beadsLocalClose`) is not a
   * close made in bd, and is left to write-back.
   *
   * Not for an overview card: its own close path (step 4) moves it once its
   * children are closed, and a container closed while a child is open keeps
   * its card (owner decision, samskara-l2t.2.2). A card with `beadsSyncedAt`
   * in a non-terminal phase is a card a person moved out of Done after
   * write-back closed its bead; moving it back would undo that person's
   * move (the two-way status sync, samskara-l2t.4, owns that case).
   *
   * A run on the card does not hold the move. Moving a card to a terminal
   * phase aborts the sessions bound to it and revokes their bindings
   * (the transition service runs terminal cleanup on every accepted move to
   * a terminal phase, rules/transition-service.js:377-390;
   * rules/terminal-cleanup.js:24-50), so the run stops and its later moves
   * are refused (rules/tools.js:61-62). The work is finished or dropped in
   * bd; a run past that point builds what nobody tracks. Waiting for the
   * binding instead would wait up to 24 hours: a binding stays active after
   * its run ends until the card leaves for a terminal phase or the stale
   * sweep revokes it (rules/dispatcher.js:34-35,373-385).
   *
   * **Reopened.** A card in the done phase whose close was recorded
   * (`beadsSyncedAt`, set by write-back, or `beadsClosedOutside` naming the
   * done phase, for a card moved here because its bead was closed in bd,
   * synced or not yet) and whose bead is no longer closed is
   * committed to the board's initial phase (owner decision, samskara-l2t:
   * a bead reopened after Done moves its same card Done -> Intake). In the
   * same sweep, before the commit, its close markers are cleared and
   * `beadsReopenPending` records its stage-history length: write-back skips
   * it while the move waits, a later sweep re-commits (a replay at the same
   * revision), and once the card has moved the marker is stale and cleared,
   * so a person's Done made before the next sweep closes the bead again
   * instead of being sent back to Intake. A card in the canceled phase is
   * never moved back: a canceled card leaves its bead open by owner
   * decision, so an open bead there is expected; its closed-outside markers
   * are cleared, so a person's later Done is written back as usual.
   *
   * **After a reopen.** Once such a card has left the terminal phase and
   * its bead is open, any close marker still set is cleared, and its
   * org-wide claim, which
   * Factory dropped when the card entered a terminal phase
   * (storage/domains/work-items/base.js:911-920), is taken again with
   * `claimWorkItem` (:1232-1256); that holds for any card back from a
   * terminal phase with its bead open.
   *
   * Each move is a committed transition (#commitTransition): a repeat at
   * the same card revision is a replay, so no move is committed twice.
   */
  async #followOutsideState(scope: IntakeScope, board: BoardPhases): Promise<void> {
    const { orgId, projectId, slug, snapshot, initialPhase } = scope;
    if (!snapshot) return;
    const runtime = this.#ctx!.runtime!;
    const canceledPhase = board.phaseKind(this.canceledPhase) === 'terminal' ? this.canceledPhase : this.donePhase;
    // Re-read: earlier steps moved revisions.
    const cards = await runtime.workItems.list({ orgId, factoryProjectId: projectId });
    for (let card of cards) {
      if (card.externalSource?.integrationId !== BEADS_INTEGRATION_ID || card.metadata?.[BEADS_META.repo] !== slug) continue;
      const beadId = card.metadata?.[BEADS_META.id];
      if (typeof beadId !== 'string' || card.board !== this.board || card.stages.length !== 1) continue;
      const bead = snapshot.get(beadId);
      // Not in the list (bd leaves gates, templates and wisps out): unknown, so left alone.
      if (!bead?.status) continue;
      const stage = card.stages[0]!;
      const terminal = board.phaseKind(stage) === 'terminal';
      const closed = bead.status === 'closed';
      let meta = card.metadata ?? {};
      try {
        // A reopen move the card has made since, or any move after it, ends the wait.
        if (meta[BEADS_META.reopenPending] != null && !isReopenPending(card)) {
          card = await this.#mark(orgId, card, { [BEADS_META.reopenPending]: null });
          meta = card.metadata ?? {};
        }
        if (!terminal && closed) {
          // A close write-back made (synced, or still waiting for its sync)
          // that a person moved out of Done: theirs to keep (samskara-l2t.4).
          if (meta[BEADS_META.cardKind] === OVERVIEW_CARD_KIND || meta[BEADS_META.syncedAt] || meta[BEADS_META.localClose]) continue;
          // Already moved for this close once, then moved out by a person: theirs to keep too.
          if (arrivedClosedOutside(card)) {
            if (!meta[BEADS_META.closedOutsideAt]) await this.#mark(orgId, card, { [BEADS_META.closedOutsideAt]: new Date().toISOString() });
            continue;
          }
          const outcome = closedOutsideOutcome(bead);
          const target = outcome === 'completed' ? this.donePhase : canceledPhase;
          if (meta[BEADS_META.closedOutside] !== target) {
            card = await this.#mark(orgId, card, { [BEADS_META.closedOutside]: target, [BEADS_META.closedOutsideMoves]: stageMoves(card) });
          }
          const result = await this.#commitTransition(orgId, card, target, 'closed-outside');
          if (result === 'committed') {
            this.#log.info(`[factory-beads] ${slug}: ${beadId} was ${outcome} outside the Factory; its card moves from ${stage} to ${target}`);
          }
        } else if (!terminal) {
          // Open bead on a card that is not finished: clear what a past close left.
          const patch = clearedCloseMarkers(meta);
          if (Object.keys(patch).length > 0) card = await this.#mark(orgId, card, patch);
          // A card back from a terminal phase (reopened, or moved back by a person).
          if (card.claimKey === null) {
            const claimed = await runtime.workItems.claimWorkItem({ orgId, id: card.id, claimKey: beadsClaimKey(slug, beadId) });
            if (!claimed) {
              this.#warnOnce(
                `reclaim:${card.id}`,
                `[factory-beads] ${slug}: card ${card.id} of reopened ${beadId} could not take its claim back: another card in the organization holds it`,
              );
            }
          }
        } else if (closed) {
          // In a terminal phase with its bead closed: record that a card moved
          // for a close made in bd has arrived, so it is never moved again
          // for that close once a person moves it out.
          if (meta[BEADS_META.closedOutside] === stage && !meta[BEADS_META.closedOutsideAt]) {
            await this.#mark(orgId, card, { [BEADS_META.closedOutsideAt]: new Date().toISOString() });
          }
        } else if (
          stage === this.donePhase &&
          (meta[BEADS_META.syncedAt] || meta[BEADS_META.closedOutside] === this.donePhase || isReopenPending(card))
        ) {
          // The close markers are cleared before the move is committed, in
          // this sweep, and the wait is recorded instead: write-back skips the
          // card while the move waits, and once the card has moved, a
          // person's Done closes the bead again instead of being undone.
          if (!isReopenPending(card)) {
            card = await this.#mark(orgId, card, { ...clearedCloseMarkers(meta), [BEADS_META.reopenPending]: stageMoves(card) });
          }
          const result = await this.#commitTransition(orgId, card, initialPhase, 'reopened');
          if (result === 'committed') {
            this.#log.info(`[factory-beads] ${slug}: ${beadId} was reopened (${bead.status}); its card moves from ${stage} to ${initialPhase}`);
          }
        } else {
          // In a terminal phase with its bead open and no close recorded to
          // undo: a canceled card keeps its phase (owner decision), and a
          // closed-outside marker left from the close no longer applies.
          const patch = clearedCloseMarkers(meta);
          if (Object.keys(patch).length > 0) await this.#mark(orgId, card, patch);
        }
      } catch (error) {
        this.#log.warn(
          `[factory-beads] ${slug}: card of ${beadId} not moved after its bead changed outside the Factory: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * The refresh read (samskara-l2t.15, BdRepo.refresh), or undefined when it
   * failed. A failure warns once per failure streak, not once per sweep, and
   * the first read that works again logs one line. The repository's report
   * carries the failure as its diagnostic, naming the `consequence`; a later
   * failed read in the same sweep replaces an earlier one's, so the overview
   * steps' is the one shown. Its state is left as the other steps set it:
   * write-back falls back to `bd show`, and the pull and the intake of ready
   * beads still run.
   */
  async #readSnapshot(repo: BdRepo, report: RepoSyncReport, consequence: string): Promise<BeadSnapshot | undefined> {
    try {
      const snapshot = await repo.refresh();
      if (this.#refreshFailing.delete(repo.slug)) {
        this.#log.info(`[factory-beads] ${repo.slug}: the refresh read (bd list --all) works again; ${snapshot.size} beads read`);
      }
      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.#refreshFailing.has(repo.slug)) {
        this.#refreshFailing.add(repo.slug);
        this.#log.warn(
          `[factory-beads] ${repo.slug}: ${message}. Until it reads again, each sweep skips open-children counts, overview and planning cards, overview moves and re-arms for this repository, and write-back reads each bead with bd show. Ready beads are still carded; a ready bead is linked under its parent only when the parent already has a card. Logged once until it recovers.`,
        );
      }
      if (report.diagnostic === undefined || report.diagnostic.startsWith(REFRESH_FAILED)) {
        report.diagnostic = `${REFRESH_FAILED}, so ${consequence} this sweep: ${message}`;
      }
      return undefined;
    }
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
   * refuses the container's close; step 6 re-arms that close once the child
   * closes.
   *
   * Returns the ids of the cards whose move is committed.
   */
  async #closeSettledOverviews(scope: IntakeScope, phaseKind: (phase: string) => string | undefined): Promise<Set<string>> {
    const moved = new Set<string>();
    const settled = [...scope.counted].filter(([, count]) => count.open === 0);
    if (settled.length === 0) return moved;
    const { orgId, projectId, slug, repo, snapshot } = scope;
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
        // A counted container is in the refresh read; bd show only for one the list leaves out.
        if (count.total === 0 && (snapshot?.get(beadId) ?? (await repo.show(beadId)))?.status !== 'closed') continue;
        const outcome = await this.#commitTransition(orgId, card, this.donePhase, 'overview-done');
        if (outcome === 'committed' || outcome === 'replayed') moved.add(card.id);
        if (outcome === 'committed') {
          this.#log.info(`[factory-beads] ${slug}: every child of ${beadId} is closed; its card moves to ${this.donePhase}`);
        }
      } catch (error) {
        this.#log.warn(
          `[factory-beads] ${slug}: card of ${beadId} not moved to ${this.donePhase}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return moved;
  }

  /**
   * Step 5 of a sweep. An overview card never runs, so one in a working phase
   * is stranded. The board policy refuses every move of it into a working
   * phase, but a planning card becomes an overview card wherever it sits (the
   * children its file run creates are seen by the next sweep, possibly before
   * the run moves the card back), and a card made before overview cards
   * existed may already be in one, with a run on it. Such a card moves to the
   * board's initial phase (Intake), where overview cards rest, unless the
   * phase's own seat is still bound to it. The move is a committed
   * transition, as in step 4, and the policy allows it: Intake is not a
   * working phase.
   *
   * An active binding is Factory's record of a seat bound to the card
   * (`WorkItemsStorage.listRunBindings`, @mastra/factory 0.20.0
   * storage/domains/work-items/base.d.ts:730). Only a binding for the seat
   * the phase seats (`roleForPhase`) holds the card: that is the run that
   * may still be moving it, the planning card's file run above all, and
   * moving the card from under it would turn that run's own move back to
   * Intake into a stale rejection. Factory gives an integration no way to
   * tell a live run from a finished one: `IntegrationContext.runtime` holds
   * only configVersion, workItems and boards (integrations/base.d.ts:137-143),
   * and the running-session set is the HTTP layer's (routes/work-items.js:250).
   * A binding for any other seat does not hold the card: the `chat` seat a
   * person's "Start session" takes (rules/start-coordinator.js:158-175, role
   * `chat` from the UI) neither runs the phase nor moves the card.
   *
   * A held card is not stuck. Its run's moves into a working phase are
   * refused with a reason that names the way out (OVERVIEW_WORKING_REASON,
   * board-rules.ts), and its moves to Intake, or to Done once no child is
   * open, are allowed; a person can move it to Intake at any time. A binding
   * stays active after its run ends, until the card reaches a terminal phase
   * or the session takes another role (storage/domains/work-items/base.js:
   * 2121-2190), or until the dispatcher's stale-binding sweep revokes it:
   * every 10 minutes it revokes each active binding created more than 24
   * hours earlier (rules/dispatcher.js:34-35,373-385, storage/domains/
   * work-items/base.js:2159-2181; samskara passes neither override). So a
   * held card whose run ended without moving it is moved here about 24 hours
   * after that run started. `moved` holds the cards step 4 just committed to
   * Done.
   */
  async #resetStrandedOverviews(scope: IntakeScope, board: BoardPhases, moved: Set<string>): Promise<void> {
    const runtime = this.#ctx!.runtime!;
    const { orgId, projectId, slug, initialPhase } = scope;
    const cards = await runtime.workItems.list({ orgId, factoryProjectId: projectId });
    for (const card of cards) {
      if (card.externalSource?.integrationId !== BEADS_INTEGRATION_ID || card.metadata?.[BEADS_META.repo] !== slug) continue;
      if (card.board !== this.board || card.metadata?.[BEADS_META.cardKind] !== OVERVIEW_CARD_KIND || moved.has(card.id)) continue;
      const stage = card.stages.length === 1 ? card.stages[0]! : undefined;
      if (!stage || board.phaseKind(stage) !== 'working') continue;
      try {
        const seat = board.roleForPhase(stage);
        const bindings = await runtime.workItems.listRunBindings(orgId, projectId, card.id);
        if (bindings.some(binding => binding.status === 'active' && binding.role === seat)) continue;
        const outcome = await this.#commitTransition(orgId, card, initialPhase, 'overview-intake');
        if (outcome === 'committed') {
          this.#log.info(`[factory-beads] ${slug}: overview card ${card.id} sat in ${stage} with no ${seat ?? 'run'} seat bound; it moves to ${initialPhase}`);
        }
      } catch (error) {
        this.#log.warn(
          `[factory-beads] ${slug}: overview card ${card.id} not moved to ${initialPhase}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Step 6 of a sweep. bd refuses to close any bead while a child is open
   * ("cannot close X: 1 open child issue(s)", checked on bd 1.3.1 for an epic
   * and for a task with a subtask), so a parent's card that reached Done
   * early is parked `close-failed` after `maxCloseAttempts`, and write-back
   * never tries it again: an overview card moved by hand, or with a child
   * added after the count was read, and a task's card moved to Done before
   * its subtasks closed (the board policy guards only overview cards). Once
   * every child is closed that refusal no longer holds: the attempts and the
   * write-back state are reset so the close is retried. Once per card
   * (`beadsCloseRearmedAt`): a close that then fails for another reason stays
   * parked for an operator. The card stays in Done. A card whose bead has no
   * children is never re-armed.
   */
  async #rearmParentCloses(scope: IntakeScope, cards: WorkItemRow[]): Promise<void> {
    const { orgId, slug, snapshot } = scope;
    // Children come from the refresh read; without it nothing is re-armed this sweep.
    if (!snapshot) return;
    let rearmed = 0;
    for (const card of cards) {
      const beadId = card.metadata?.[BEADS_META.id];
      if (typeof beadId !== 'string' || card.board !== this.board) continue;
      if (card.stages.length !== 1 || card.stages[0] !== this.donePhase) continue;
      if (card.metadata?.[BEADS_META.writeback] !== 'close-failed' || card.metadata?.[BEADS_META.closeRearmedAt]) continue;
      // Only a close bd refused for an open child can clear on its own.
      if (!String(card.metadata?.[BEADS_META.diagnostic] ?? '').includes('open child')) continue;
      try {
        const children = snapshot.children(beadId);
        if (children.length === 0 || children.some(child => child.status !== 'closed')) continue;
        await this.#mark(orgId, card, {
          [BEADS_META.writeback]: null,
          [BEADS_META.closeAttempts]: 0,
          [BEADS_META.closeRearmedAt]: new Date().toISOString(),
        });
        rearmed++;
        this.#log.info(`[factory-beads] ${slug}: every child of ${beadId} is closed; its close is retried`);
      } catch (error) {
        this.#log.warn(`[factory-beads] ${slug}: close of ${beadId} not re-armed: ${error instanceof Error ? error.message : String(error)}`);
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
   * 2026-10-09: a childless container gets no overview card; a childless open
   * epic is recorded in `scope.childless` and becomes a planning card), or is
   * carded in another project. Never throws.
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

  /**
   * The card a ready bead is linked under: its container's overview card
   * (#overview), or else the card its parent bead already has in this
   * project, a task with subtasks say (owner principle: use all of beads).
   * Such a parent is never made an overview card and no card is made for it
   * here: it is linked to only when it is carded already, as intake cards it
   * when it is ready. A parent that cannot be read is looked up the same way.
   */
  async #parentCard(scope: IntakeScope, id: string): Promise<WorkItemRow | undefined> {
    const overview = await this.#overview(scope, id, new Set());
    if (overview) return overview;
    const card = await this.#ctx!.runtime!.workItems.getByProjectSource({
      orgId: scope.orgId,
      factoryProjectId: scope.projectId,
      source: beadSource(id),
    });
    return card ?? undefined;
  }

  async #resolveOverview(scope: IntakeScope, id: string, trail: Set<string>): Promise<WorkItemRow | undefined> {
    const runtime = this.#ctx!.runtime!;
    const { snapshot } = scope;
    // No refresh read this sweep (warned once per streak by #readSnapshot):
    // nothing is known about the container, so nothing is carded or changed
    // for it, and its children are carded without a parent.
    if (!snapshot) return undefined;
    // The container from the refresh read; bd show only for a bead the list
    // leaves out (bd list hides gates, templates and wisps by default).
    const row = snapshot.get(id);
    const shown = row ? undefined : await scope.repo.show(id);
    const bead: BeadRow | BeadDetails | undefined = row ?? shown;
    if (!bead) {
      this.#warnOnce(
        `unreadable:${scope.slug}:${id}`,
        `[factory-beads] ${scope.slug}: parent ${id} is not in bd list and cannot be read with bd show; its children are carded without an overview card`,
      );
      return undefined;
    }
    if (!(OVERVIEW_TYPES as readonly string[]).includes(bead.issue_type ?? '') || bead.status === 'closed') return undefined;
    const children = snapshot.children(id);
    if (children.length === 0) {
      scope.childless.add(id);
      return undefined;
    }
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
    return card;
  }

  /**
   * Step 2b of a sweep (samskara-l2t.8). Reads beads from the refresh read
   * only; without it nothing changes this sweep.
   *
   * **Title.** A card's title is `<bead id>: <bead title>`, as intake made
   * it. When the bead's title differs from the one recorded on the card
   * (`beadsTitle`), the card is retitled and the new title recorded, in one
   * update (`UpdateWorkItemInput.title`, @mastra/factory 0.20.0
   * storage/domains/work-items/base.d.ts:447-450). Only a change in bd moves
   * the title: a card a person renamed in the Factory keeps its name until
   * the bead's title changes. A card with no recorded title (made before
   * this) is retitled when its title is not the bead's, so a bead edited
   * before then catches up once.
   *
   * **Kind and parent.** `bd ready` lists open beads with no active blocker,
   * never an in_progress one (`bd ready --help`, v1.3.1), so intake's updates
   * of an existing card skip a card whose bead is not ready. For such a card
   * whose bead is not closed, the same updates run here from the refresh
   * read: the research kind follows the bead's type (an epic's kind is left
   * to the overview steps), and a bead with a parent is linked under the
   * parent's card when it has one. Cards in a terminal phase are left out.
   */
  async #followBeadEdits(scope: IntakeScope, readyIds: ReadonlySet<string>): Promise<void> {
    const { orgId, projectId, slug, snapshot } = scope;
    if (!snapshot) return;
    const runtime = this.#ctx!.runtime!;
    const board = runtime.boards.get(this.board);
    const cards = await runtime.workItems.list({ orgId, factoryProjectId: projectId });
    for (let card of cards) {
      if (card.externalSource?.integrationId !== BEADS_INTEGRATION_ID || card.metadata?.[BEADS_META.repo] !== slug) continue;
      const beadId = card.metadata?.[BEADS_META.id];
      if (typeof beadId !== 'string' || card.board !== this.board) continue;
      const bead = snapshot.get(beadId);
      if (!bead) continue;
      try {
        if (typeof bead.title === 'string' && card.metadata?.[BEADS_META.title] !== bead.title) {
          const title = `${beadId}: ${bead.title}`;
          const recorded = card.metadata?.[BEADS_META.title];
          const updated = await runtime.workItems.update({
            orgId,
            id: card.id,
            userId: `integration:${BEADS_INTEGRATION_ID}`,
            patch: { ...(card.title !== title ? { title } : {}), metadata: { [BEADS_META.title]: bead.title } },
          });
          if (updated) {
            if (card.title !== title && recorded !== undefined) {
              this.#log.info(`[factory-beads] ${slug}: ${beadId} was retitled in bd; its card follows`);
            }
            card = updated.item;
          }
        }
        if (readyIds.has(beadId) || bead.status === 'closed') continue;
        if (card.stages.some(stage => board?.phaseKind(stage) === 'terminal')) continue;
        const current = card.metadata?.[BEADS_META.cardKind];
        if (bead.issue_type !== EPIC_TYPE && current !== OVERVIEW_CARD_KIND && current !== PLAN_CARD_KIND) {
          const kind = readyCardKind(bead);
          if ((current ?? undefined) !== kind) card = await this.#mark(orgId, card, { [BEADS_META.cardKind]: kind ?? null });
        }
        if (bead.parent) {
          const parent = await this.#parentCard(scope, bead.parent);
          if (parent) await this.#linkParent(scope, card, parent);
        }
      } catch (error) {
        this.#log.warn(`[factory-beads] ${slug}: card of ${beadId} not updated from its bead: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
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
            [BEADS_META.title]: bead.title ?? null,
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

/**
 * `ready` reordered so that a bead whose parent is also ready comes after
 * that parent (and its ancestors), so the parent's card exists when the
 * child's card is made. Otherwise bd's order is kept. A parent cycle cannot
 * loop: each bead is placed once.
 */
export function parentsFirst<T extends { id: string; parent?: string }>(ready: readonly T[]): T[] {
  const byId = new Map(ready.map(bead => [bead.id, bead]));
  const placed = new Set<string>();
  const out: T[] = [];
  const place = (bead: T, trail: Set<string>) => {
    if (placed.has(bead.id) || trail.has(bead.id)) return;
    trail.add(bead.id);
    const parent = bead.parent ? byId.get(bead.parent) : undefined;
    if (parent) place(parent, trail);
    placed.add(bead.id);
    out.push(bead);
  };
  for (const bead of ready) place(bead, new Set());
  return out;
}

/** How a bead closed outside the Factory ended: its card moves to Done, or to Canceled. */
export type ClosedOutsideOutcome = 'completed' | 'canceled';

/** The edge types bd 1.3.1 writes when it closes a bead as superseded or as a duplicate. */
export const NOT_COMPLETED_EDGES = ['supersedes', 'duplicates'] as const;

/** The close reason `bd human dismiss` writes, alone or as `Dismissed: <reason>`. */
export const DISMISSED_REASON = 'Dismissed';

/**
 * Whether a closed bead was completed or dropped, from its refresh row
 * (samskara-l2t.3). bd 1.3.1 has no close-reason vocabulary to read this
 * from, so it is read from what bd's own commands leave behind:
 *
 *   - `bd supersede <old> --with <new>` and `bd duplicate <dup> --of <canonical>`
 *     add a `supersedes` / `duplicates` edge from the closed bead to the
 *     other one, then close it with an EMPTY reason (bd v1.3.1
 *     cmd/bd/duplicate.go:100-114, :170-184). The edge is on the closed
 *     bead's row (`dependencies`, issue_id = the bead); checked on bd 1.3.1.
 *     So such a bead is `canceled`.
 *   - `bd human dismiss` closes with `Dismissed` or `Dismissed: <reason>`
 *     (cmd/bd/human.go:366-368,451): `canceled`. `bd human respond` closes
 *     with `Responded` (:315): `completed`, as any other reason or none.
 *
 * Only a closed bead is read this way. A reopened bead keeps its edge
 * (checked on bd 1.3.1: `bd reopen` clears close_reason, not the edge), so
 * a superseded bead that is reopened and then closed normally still reads
 * as `canceled`.
 */
export function closedOutsideOutcome(bead: Pick<BeadRow, 'id' | 'close_reason' | 'dependencies'>): ClosedOutsideOutcome {
  const dropped = (bead.dependencies ?? []).some(
    dep =>
      (NOT_COMPLETED_EDGES as readonly string[]).includes(dep?.type ?? '') && (dep?.issue_id === undefined || dep.issue_id === bead.id),
  );
  if (dropped) return 'canceled';
  const reason = bead.close_reason?.trim() ?? '';
  if (reason === DISMISSED_REASON || reason.startsWith(`${DISMISSED_REASON}:`)) return 'canceled';
  return 'completed';
}

/** A bead card's external source. The same for a work card and an overview card. */
function beadSource(beadId: string): ExternalWorkItemSource {
  return { integrationId: BEADS_INTEGRATION_ID, type: 'issue', externalId: beadId };
}

/** The org-wide claim for one bead: a repo's bead is carded by one project at a time. */
export function beadsClaimKey(repo: string, beadId: string): string {
  return `beads:${repo}:${beadId}`;
}
