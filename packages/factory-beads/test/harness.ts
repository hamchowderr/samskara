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
import { WorkItemClaimConflictError } from '@mastra/factory/storage/domains/work-items/base';
import type { CreateWorkItemInput, ExternalWorkItemSource, WorkItemRow } from '@mastra/factory/storage/domains/work-items/base';

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
  blockedBy?: string[];
  closeReason?: string | null;
}

export interface FakeState {
  beads: FakeBead[];
  syncExits: number[];
  pullExits: number[];
  closeFail: string[];
  calls: Array<{
    argv: string[];
    cwd: string;
    env: { token: string | null; remoteInfoBranch: string | null; gitConfig: Record<string, string>; serverSecret: string | null };
  }>;
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
    const now = new Date();
    const item = {
      id: `card_${++this.#seq}`,
      orgId,
      factoryProjectId,
      board: input.board ?? 'work',
      externalSource: input.externalSource ?? null,
      claimKey: input.claimKey ?? null,
      parentWorkItemId: null,
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
    // Same merge as WorkItemsStorage.applyUpdate (work-items/base.js:381-384).
    if (patch.metadata !== undefined) item.metadata = patch.metadata === null ? null : { ...(item.metadata ?? {}), ...patch.metadata };
    if (patch.stages) item.stages = patch.stages;
    item.revision++;
    return { item: structuredClone(item), previous: { stages: [], sessionRoles: [] } };
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

export interface Harness {
  dir: string;
  remote: string;
  cacheDir: string;
  statePath: string;
  workItems: MemoryWorkItems;
  ctx: IntegrationContext;
  state(): FakeState;
  setState(update: (s: FakeState) => void): void;
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

  const statePath = join(dir, 'fake-bd-state.json');
  const initial: FakeState = { beads, syncExits: [], pullExits: [], closeFail: [], calls: [] };
  writeFileSync(statePath, JSON.stringify(initial));

  const workItems = new MemoryWorkItems();
  const board = {
    id: 'work',
    initialPhase: 'intake',
    phaseKind: (p: string) => (['intake', 'triage', 'planning', 'execute', 'review'].includes(p) ? 'working' : p === 'done' || p === 'canceled' ? 'terminal' : undefined),
  };
  const sourceControlHandle = {
    integrationId: 'github',
    connections: { list: async () => [{ id: 'conn_1' }] },
    projectRepositories: { list: async () => [{ repositoryId: 'repo_1' }] },
    repositories: { get: async () => ({ id: 'repo_1', slug: SLUG }) },
  };
  const ctx = {
    auth: { enabled: () => true, ensureUser: async () => undefined, tenant: () => ({ orgId: ORG, userId: 'u1' }), isOrganizationAdmin: async () => true },
    storage: {
      sourceControls: [sourceControlHandle],
      projects: { listAll: async () => [{ id: PROJECT, orgId: ORG }] },
    },
    runtime: { configVersion: 'test', workItems, boards: new Map([['work', board]]) },
  } as unknown as IntegrationContext;

  const cacheDir = join(dir, 'cache');
  const harness: Harness = {
    dir,
    remote,
    cacheDir,
    statePath,
    workItems,
    ctx,
    state: () => JSON.parse(readFileSync(statePath, 'utf8')) as FakeState,
    setState(update) {
      const s = harness.state();
      update(s);
      writeFileSync(statePath, JSON.stringify(s));
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
