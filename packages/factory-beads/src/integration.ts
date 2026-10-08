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
 *   - IntegrationContext.storage.{sourceControls, projects} integrations/base.d.ts:109-111
 *   - VersionControl.getRepositoryAccess                  capabilities/version-control.d.ts:231
 *       (GitHub: plain https cloneUrl + installation token, integrations/github/integration.js:199-213)
 *   - WorkItemsStorage.getByProjectSource / upsert / update / list
 *                                                         storage/domains/work-items/base.d.ts:544,562,746,759
 *   - update merges metadata                              storage/domains/work-items/base.js:381-384
 *   - claimKey: org-wide, released on a terminal phase    work-items/base.d.ts:395-400; base.js:912-919
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
import type { MastraWorker } from '@mastra/core/worker';
import type { VersionControl } from '@mastra/factory/capabilities/version-control';
import type { FactoryIntegration, IntegrationContext } from '@mastra/factory/integrations/base';
import { WorkItemClaimConflictError } from '@mastra/factory/storage/domains/work-items/base';
import type { ExternalWorkItemSource, WorkItemRow } from '@mastra/factory/storage/domains/work-items/base';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerLive } from './done-rule';
import { BdRepo, cacheDirFor, resultTail } from './repo';
import { BdRunner } from './runner';
import type { BdResult, RepoCredentials } from './runner';
import { BeadsSyncWorker } from './worker';
import type { TickOutcome } from './worker';

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
} as const;

export type WritebackState = 'synced' | 'conflict' | 'close-failed' | 'reset-requested';

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
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export interface RepoSyncReport {
  orgId: string;
  projectId: string;
  repo: string;
  created: number;
  existing: number;
  closed: number;
  state: 'ok' | 'blocked' | 'error';
  diagnostic?: string;
}

export interface SweepSummary {
  at: string;
  durationMs: number;
  repos: RepoSyncReport[];
  error?: string;
}

interface LinkedRepo {
  orgId: string;
  projectId: string;
  repositoryId: string;
  slug: string;
}

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
    };
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

  async #linkedRepos(ctx: IntegrationContext): Promise<LinkedRepo[]> {
    const handle = ctx.storage.sourceControls.find(h => h.integrationId === this.#options.sourceControl.id);
    if (!handle) return [];
    const out: LinkedRepo[] = [];
    for (const project of await ctx.storage.projects.listAll()) {
      for (const connection of await handle.connections.list({ orgId: project.orgId, factoryProjectId: project.id })) {
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
        };
        summary.repos.push(report);
        try {
          const access = await vc.getRepositoryAccess({ orgId: linked.orgId, repositoryId: linked.repositoryId });
          const credentials: RepoCredentials | undefined = access.authorization
            ? { token: access.authorization.token, username: access.authorization.username }
            : undefined;
          await this.#syncRepo(linked, access.cloneUrl, credentials, board.initialPhase, report);
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
    const problems = summary.repos.filter(r => r.state !== 'ok');
    if (summary.error || problems.length > 0) {
      this.#log.warn('[factory-beads] sweep finished with problems', JSON.stringify({ error: summary.error, problems }));
    }
    return summary;
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
    // Done here, under the writer lease, not in the route.
    if (cards.some(item => item.metadata?.[BEADS_META.writeback] === 'reset-requested')) {
      await this.#repo(slug, cloneUrl).discard();
      this.#repos.delete(slug);
      for (const [index, item] of cards.entries()) {
        if (item.metadata?.[BEADS_META.writeback] !== 'reset-requested') continue;
        cards[index] = await this.#mark(orgId, item, {
          [BEADS_META.writeback]: null,
          [BEADS_META.syncExit]: null,
          [BEADS_META.closeAttempts]: 0,
        });
      }
    }

    // A conflicted write-back parks the whole repo: no pull, no intake, no
    // further writes until an operator resolves it and resets the copy.
    const conflicted = cards.filter(item => item.metadata?.[BEADS_META.writeback] === 'conflict');
    if (conflicted.length > 0) {
      report.state = 'blocked';
      report.diagnostic = `bd sync conflict on ${conflicted.map(c => c.metadata?.[BEADS_META.id]).join(', ')}; resolve it, then POST /web/beads/reset`;
      return;
    }

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
        if ((await repo.status(beadId)) === 'closed') {
          closed.push(item);
          continue;
        }
        const res = await repo.close(beadId, this.#closeReason(item));
        if (res.code === 0) {
          closed.push(item);
          continue;
        }
        const attempts = Number(item.metadata?.[BEADS_META.closeAttempts] ?? 0) + 1;
        await this.#mark(orgId, item, {
          [BEADS_META.closeAttempts]: attempts,
          [BEADS_META.diagnostic]: `bd close exit ${res.code}: ${resultTail(res, 300)}`,
          ...(attempts >= maxAttempts ? { [BEADS_META.writeback]: 'close-failed' satisfies WritebackState } : {}),
        });
        report.state = 'error';
        report.diagnostic = `bd close ${beadId} exit ${res.code}`;
      }
      if (closed.length > 0) {
        const sync = await this.#syncWithRetry(repo, credentials);
        if (sync.code === 0) {
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
          report.state = 'blocked';
          report.diagnostic = diagnostic;
          return;
        } else {
          // 1 (transport/auth) or 3 after our retries: the close is committed
          // locally and the cards stay pending, so the next tick syncs again.
          report.state = 'error';
          report.diagnostic = `bd sync exit ${sync.code}: ${resultTail(sync, 300)}`;
        }
      }
    } else {
      const pull = await repo.pull(credentials);
      if (pull.code !== 0) {
        report.state = 'error';
        report.diagnostic = `bd dolt pull exit ${pull.code}: ${resultTail(pull, 300)}`;
      }
    }

    // 2. Intake: one card per ready bead, idempotently.
    for (const bead of await repo.ready()) {
      const source: ExternalWorkItemSource = { integrationId: BEADS_INTEGRATION_ID, type: 'issue', externalId: bead.id };
      // No `workspaceId`: POST /web/factory/projects/:id/work-items drops it
      // (routes/contracts.js externalSourceSchema), so a key carrying it would
      // never match a card made through that route. The repo is in claimKey.
      if (await runtime.workItems.getByProjectSource({ orgId, factoryProjectId: projectId, source })) {
        report.existing++;
        continue;
      }
      try {
        const result = await runtime.workItems.upsert({
          orgId,
          userId: `integration:${BEADS_INTEGRATION_ID}`,
          factoryProjectId: projectId,
          reuseMode: 'preserve',
          input: {
            board: this.board,
            externalSource: source,
            claimKey: beadsClaimKey(slug, bead.id),
            title: `${bead.id}: ${bead.title}`,
            stages: [initialPhase],
            metadata: {
              [BEADS_META.id]: bead.id,
              [BEADS_META.repo]: slug,
              [BEADS_META.type]: bead.issue_type ?? null,
              [BEADS_META.priority]: bead.priority ?? null,
            },
          },
        });
        if (result.created) report.created++;
        else report.existing++;
      } catch (error) {
        // Another project in the org already carries this bead.
        if (error instanceof WorkItemClaimConflictError) {
          report.existing++;
          continue;
        }
        throw error;
      }
    }
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
    for (const project of (await this.#linkedRepos(this.#ctx!)).filter(r => r.orgId === orgId && r.slug === slug)) {
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
          return c.json({ diagnostics: this.diagnostics(), lastSweep: forOrg(this.#last, tenant.orgId) });
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

/** The org-wide claim for one bead: a repo's bead is carded by one project at a time. */
export function beadsClaimKey(repo: string, beadId: string): string {
  return `beads:${repo}:${beadId}`;
}
