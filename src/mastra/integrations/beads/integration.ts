/**
 * SPIKE (samskara-iz6): a `beads` FactoryIntegration — ready beads become
 * cards, Done cards close their bead. Throwaway proof, not the real build.
 *
 * Factory extension points used (installed @mastra/factory 0.20.0):
 *   - FactoryIntegration.workers(ctx)          integrations/base.d.ts:241
 *   - FactoryIntegration.routes(ctx)           integrations/base.d.ts:207
 *   - IntegrationContext.runtime.workItems     integrations/base.d.ts:137-143
 *   - IntegrationContext.storage.sourceControls / projects  base.d.ts:109-111
 *   - IssueReconcileWorker (interval + lease)  integrations/issue-reconcile-worker.js:6-88
 *   - WorkItemsStorage.getByProjectSource / upsert / update / list
 *                                              storage/domains/work-items/base.d.ts:544,562,746,763
 *   - claimKey (org-wide unique)               storage/domains/work-items/base.d.ts:395-400,439-440
 *   - VersionControl.getRepositoryAccess       capabilities/version-control.d.ts:231
 *
 * Why cards are created through `workItems.upsert` and not a rule decision:
 * `upsertLinkedWorkItem.source` is a closed union (rules/types.d.ts:2) and a
 * `manual` source is stored as integrationId `factory` (rules/types.js:2-9),
 * so a decision cannot carry `integrationId: 'beads'`. `upsert` is the same
 * call POST /web/factory/projects/:id/work-items makes (routes/work-items.js:386)
 * and it accepts any externalSource.
 *
 * Why the Done handler does NOT run `bd close` itself: board rules run BEFORE
 * the transition commits, inside a 5 s timeout (rules/transition-service.js:9,
 * :240-317). A side effect there can fire for a move that then fails to commit,
 * and `bd sync` regularly exceeds 5 s. So the handler only wakes the worker;
 * the worker, which is the single automated writer, closes the bead after the
 * card is durably in the done phase.
 */
import { registerApiRoute } from '@mastra/core/server';
import type { ApiRoute } from '@mastra/core/server';
import type { MastraWorker } from '@mastra/core/worker';
import type { FactoryIntegration, IntegrationContext } from '@mastra/factory/integrations/base';
import { IssueReconcileWorker } from '@mastra/factory/integrations/issue-reconcile-worker';
import type { VersionControl } from '@mastra/factory/capabilities/version-control';
import type { FactoryStageRuleContext } from '@mastra/factory/rules/types';
import { WorkItemClaimConflictError } from '@mastra/factory/storage/domains/work-items/base';
import type { ExternalWorkItemSource, WorkItemRow } from '@mastra/factory/storage/domains/work-items/base';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BdRepo, cacheDirFor, gitAuthEnv } from './bd';

const INTEGRATION_ID = 'beads';
const ACTOR = 'integration:beads';

/** The source-control integration whose App tokens read and write the repo. */
interface SourceControlProvider {
  readonly id: string;
  readonly versionControl?: VersionControl;
  /** Present on GithubIntegration; used only by the proof-seed route. */
  getAppOctokit?(): {
    paginate: (route: unknown, params: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    apps: { listInstallations: unknown };
  };
}

export interface BeadsIntegrationConfig {
  sourceControl: SourceControlProvider;
  /**
   * Board the cards land on. Pass the installed board's id from its
   * definition (e.g. `requestsBoard.id`) rather than a literal, so a board
   * rename follows. Defaults to `work`. Nothing else here depends on the id.
   */
  board?: string;
  /** Phase whose arrival closes the bead. Defaults to `done`. */
  donePhase?: string;
  intervalMs?: number;
  cacheDir?: string;
  /** SPIKE ONLY: mounts POST /web/beads/proof/register-installation. */
  proofSeedRoute?: boolean;
}

interface SweepSummary {
  projects: number;
  checked: number;
  updated: number;
  closed: number;
  missing: number;
  failed: number;
  created: number;
  skippedExisting: number;
  errors: Array<{ projectId: string; workItemId?: string; error: string }>;
  at?: string;
  durationMs?: number;
}

const live = new Set<BeadsIntegration>();

/**
 * Done-phase `manual` onEnter handler for the board. Pure with respect to the
 * card: it returns no decision, so it can never block or alter the move. It
 * only wakes the beads worker, which re-reads committed state before writing.
 */
export function beadsDoneRule(context: FactoryStageRuleContext): undefined {
  if (typeof context.item.metadata?.beadsId !== 'string') return undefined;
  for (const integration of live) integration.kickSoon();
  return undefined;
}

export class BeadsIntegration implements FactoryIntegration {
  readonly id = INTEGRATION_ID;
  readonly #config: BeadsIntegrationConfig;
  readonly #boardId: string;
  readonly #donePhase: string;
  readonly #cacheRoot: string;
  readonly #repos = new Map<string, BdRepo>();
  #ctx: IntegrationContext | undefined;
  #chain: Promise<unknown> = Promise.resolve();
  #last: SweepSummary | undefined;
  #kickTimer: NodeJS.Timeout | undefined;

  constructor(config: BeadsIntegrationConfig) {
    this.#config = config;
    this.#boardId = config.board ?? 'work';
    this.#donePhase = config.donePhase ?? 'done';
    this.#cacheRoot = config.cacheDir ?? join(tmpdir(), 'samskara-beads-cache');
    live.add(this);
  }

  diagnostics(): Record<string, unknown> {
    return { board: this.#boardId, donePhase: this.#donePhase, sourceControl: this.#config.sourceControl.id };
  }

  workers(ctx: IntegrationContext): MastraWorker[] {
    this.#ctx = ctx;
    if (!ctx.runtime) return [];
    return [
      new IssueReconcileWorker({
        integrationId: INTEGRATION_ID,
        reconcile: () => this.sweep(),
        intervalMs: this.#config.intervalMs ?? 30_000,
      }),
    ];
  }

  /** Coalesced wake-up from the Done rule; runs after the transition commits. */
  kickSoon(): void {
    if (this.#kickTimer) return;
    this.#kickTimer = setTimeout(() => {
      this.#kickTimer = undefined;
      void this.sweep().catch(error => console.warn('[beads] kicked sweep failed', error));
    }, 1_000);
    this.#kickTimer.unref?.();
  }

  /**
   * One sweep at a time per process. The worker's lease (issue-reconcile-worker.js:62)
   * serialises replicas when the pubsub provides one; this chain serialises the
   * worker tick against Done-rule kicks and the manual sync route.
   */
  sweep(): Promise<SweepSummary> {
    const next = this.#chain.then(() => this.#sweep());
    this.#chain = next.catch(() => undefined);
    return next;
  }

  async #sweep(): Promise<SweepSummary> {
    const started = Date.now();
    const summary: SweepSummary = {
      projects: 0,
      checked: 0,
      updated: 0,
      closed: 0,
      missing: 0,
      failed: 0,
      created: 0,
      skippedExisting: 0,
      errors: [],
    };
    const ctx = this.#ctx;
    const runtime = ctx?.runtime;
    const vc = this.#config.sourceControl.versionControl;
    if (!ctx || !runtime || !vc) return summary;
    const board = runtime.boards.get(this.#boardId);
    if (!board) {
      summary.failed++;
      summary.errors.push({ projectId: '-', error: `board "${this.#boardId}" is not installed` });
      return summary;
    }
    const handle = ctx.storage.sourceControls.find(h => h.integrationId === this.#config.sourceControl.id);
    if (!handle) return summary;

    for (const project of await ctx.storage.projects.listAll()) {
      summary.projects++;
      for (const connection of await handle.connections.list({ orgId: project.orgId, factoryProjectId: project.id })) {
        for (const link of await handle.projectRepositories.list({ orgId: project.orgId, connectionId: connection.id })) {
          const repository = await handle.repositories.get({ orgId: project.orgId, id: link.repositoryId });
          if (!repository) continue;
          try {
            await this.#syncRepo(project.orgId, project.id, repository.id, repository.slug, board.initialPhase, summary);
          } catch (error) {
            summary.failed++;
            summary.errors.push({ projectId: project.id, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
    }
    summary.at = new Date().toISOString();
    summary.durationMs = Date.now() - started;
    this.#last = summary;
    console.log('[beads] sweep', JSON.stringify(summary));
    return summary;
  }

  async #syncRepo(
    orgId: string,
    factoryProjectId: string,
    repositoryId: string,
    slug: string,
    initialPhase: string,
    summary: SweepSummary,
  ): Promise<void> {
    const runtime = this.#ctx!.runtime!;
    const access = await this.#config.sourceControl.versionControl!.getRepositoryAccess({ orgId, repositoryId });
    const env = gitAuthEnv(access.authorization?.token);
    let repo = this.#repos.get(slug);
    if (!repo) {
      repo = new BdRepo(slug, cacheDirFor(this.#cacheRoot, slug), access.cloneUrl);
      this.#repos.set(slug, repo);
    }
    await repo.ensure(env, msg => console.log(msg));

    const cards = (await runtime.workItems.list({ orgId, factoryProjectId })).filter(
      item => item.externalSource?.integrationId === INTEGRATION_ID && item.metadata?.beadsRepo === slug,
    );

    // 1. Write-back: Done cards whose bead has not been closed and pushed yet.
    const pending = cards.filter(
      item =>
        item.board === this.#boardId &&
        item.stages.length === 1 &&
        item.stages[0] === this.#donePhase &&
        !item.metadata?.beadsSyncedAt &&
        item.metadata?.beadsWriteback !== 'conflict',
    );
    let halted = false;
    if (pending.length > 0) {
      const closedNow: WorkItemRow[] = [];
      for (const item of pending) {
        const beadId = String(item.metadata?.beadsId);
        const status = await repo.status(env, beadId);
        if (status !== 'closed') {
          const res = await repo.close(env, beadId, `Factory card ${item.id} reached ${this.#donePhase}`);
          console.log(`[beads] bd close ${beadId} -> exit ${res.code} (${res.ms}ms) ${res.stdout.trim().slice(0, 200)}`);
          if (res.code !== 0) {
            summary.failed++;
            summary.errors.push({ projectId: factoryProjectId, workItemId: item.id, error: `bd close exit ${res.code}: ${res.stderr.slice(-300)}` });
            continue;
          }
        }
        closedNow.push(item);
      }
      const sync = await repo.sync(env);
      console.log(`[beads] bd sync ${slug} -> exit ${sync.code} (${sync.ms}ms) ${(sync.stdout + sync.stderr).trim().slice(-400)}`);
      if (sync.code === 0) {
        for (const item of closedNow) {
          await runtime.workItems.update({
            orgId,
            id: item.id,
            userId: ACTOR,
            patch: { metadata: { beadsWriteback: 'synced', beadsSyncedAt: new Date().toISOString() } },
          });
          summary.closed++;
        }
      } else if (sync.code === 2 || sync.code === 4) {
        // Conflict (2) or stuck working set (4): never retried automatically.
        halted = true;
        for (const item of closedNow) {
          await runtime.workItems.update({
            orgId,
            id: item.id,
            userId: ACTOR,
            patch: { metadata: { beadsWriteback: 'conflict', beadsSyncExit: sync.code } },
          });
        }
        summary.failed++;
        summary.errors.push({ projectId: factoryProjectId, error: `bd sync exit ${sync.code}: operator must resolve` });
      } else {
        // 3 = push race / busy writer, 1 = transport: the close is committed
        // locally; the next tick re-runs sync. Nothing is stamped.
        summary.failed++;
        summary.errors.push({ projectId: factoryProjectId, error: `bd sync exit ${sync.code}: retry next tick` });
      }
    } else {
      const pull = await repo.pull(env);
      if (pull.code !== 0) console.warn(`[beads] bd dolt pull ${slug} exit ${pull.code}: ${pull.stderr.slice(-300)}`);
    }
    if (halted) return;

    // 2. Intake: one card per ready bead, idempotently.
    const ready = await repo.ready(env);
    for (const bead of ready) {
      summary.checked++;
      // No `workspaceId`: POST /web/factory/projects/:id/work-items drops it
      // (routes/contracts.js externalSourceSchema), so a key carrying it would
      // never match a card created through the documented route, and the two
      // paths would duplicate each other. The repo lives in claimKey/metadata.
      const source: ExternalWorkItemSource = {
        integrationId: INTEGRATION_ID,
        type: 'issue',
        externalId: bead.id,
      };
      const existing = await runtime.workItems.getByProjectSource({ orgId, factoryProjectId, source });
      if (existing) {
        summary.skippedExisting++;
        continue;
      }
      try {
        const result = await runtime.workItems.upsert({
          orgId,
          userId: ACTOR,
          factoryProjectId,
          reuseMode: 'preserve',
          input: {
            board: this.#boardId,
            externalSource: source,
            claimKey: `beads:${slug}:${bead.id}`,
            title: `${bead.id}: ${bead.title}`,
            stages: [initialPhase],
            metadata: {
              beadsId: bead.id,
              beadsRepo: slug,
              beadsType: bead.issue_type ?? null,
              beadsPriority: bead.priority ?? null,
              beadsParent: bead.parent ?? null,
            },
          },
        });
        if (result.created) {
          summary.created++;
          console.log(`[beads] card ${result.item.id} created for ${slug} ${bead.id}`);
        } else summary.skippedExisting++;
      } catch (error) {
        if (error instanceof WorkItemClaimConflictError) {
          summary.skippedExisting++;
          continue;
        }
        throw error;
      }
    }
  }

  routes(ctx: IntegrationContext): ApiRoute[] {
    const auth = ctx.auth;
    type Ctx = Parameters<typeof auth.ensureUser>[0];
    const tenantOf = async (c: unknown) => {
      if (!auth.enabled()) return undefined;
      await auth.ensureUser(c as Ctx);
      return auth.tenant(c as Ctx) ?? undefined;
    };
    const routes: ApiRoute[] = [
      registerApiRoute('/web/beads/status', {
        method: 'GET',
        requiresAuth: false,
        handler: async c => {
          if (!(await tenantOf(c))) return c.json({ error: 'unauthorized' }, 401);
          return c.json({ diagnostics: this.diagnostics(), lastSweep: this.#last ?? null });
        },
      }),
      registerApiRoute('/web/beads/sync', {
        method: 'POST',
        requiresAuth: false,
        handler: async c => {
          if (!(await tenantOf(c))) return c.json({ error: 'unauthorized' }, 401);
          return c.json({ sweep: await this.sweep() });
        },
      }),
    ];
    if (this.#config.proofSeedRoute) {
      // SPIKE ONLY. The documented way to get an installation into an org is
      // the GitHub OAuth identify flow (/auth/github/connect), which needs a
      // browser and the App's registered callback origin. This registers the
      // App installation for one account through the provider's own
      // VersionControl.registerInstallation (capabilities/version-control.d.ts:216).
      routes.push(
        registerApiRoute('/web/beads/proof/register-installation', {
          method: 'POST',
          requiresAuth: false,
          handler: async c => {
            const tenant = await tenantOf(c);
            if (!tenant?.orgId) return c.json({ error: 'unauthorized' }, 401);
            const body = (await c.req.json().catch(() => ({}))) as { account?: string };
            const sc = this.#config.sourceControl;
            if (!sc.getAppOctokit || !sc.versionControl) return c.json({ error: 'unsupported' }, 400);
            const octokit = sc.getAppOctokit();
            const installs = await octokit.paginate(octokit.apps.listInstallations, { per_page: 100 });
            const match = installs.find(i => (i.account as { login?: string } | null)?.login?.toLowerCase() === body.account?.toLowerCase());
            if (!match) return c.json({ error: 'installation_not_found' }, 404);
            const account = match.account as { login: string; type?: string };
            const installation = await sc.versionControl.registerInstallation({
              orgId: tenant.orgId,
              userId: tenant.userId,
              installation: { externalId: String(match.id), accountName: account.login, accountType: account.type ?? null },
            });
            return c.json({ installation });
          },
        }),
      );
    }
    return routes;
  }
}
