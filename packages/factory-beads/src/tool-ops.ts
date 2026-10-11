/**
 * Host-side operations behind the beads agent tools (samskara-e64).
 *
 * Agents never run bd in their sandbox. A tool call runs bd here, on the same
 * cached copy the sync sweep uses, while holding the same `beads:writer` lease
 * (`BeadsSyncWorker.withLease`), so the host stays the only writer:
 *
 *   read : lease -> ensure copy -> bd --readonly <cmd> --json
 *   write: lease -> ensure copy -> bd dolt pull -> bd --sandbox <cmd> --json -> bd sync
 *   init : lease -> origin has no refs/dolt/data -> git clone -> bd init -> bd dolt push --yes
 *
 * Reads take the lease too: bd's embedded Dolt database has one writer, and a
 * read that overlaps a sweep's write on the same directory can fail on the lock.
 *
 * The App token reaches bd and git only through the child environment
 * (runner.ts); reads get no token at all.
 */
import { mkdir } from 'node:fs/promises';

import type { VersionControl } from '@mastra/factory/capabilities/version-control';

import type { BdRepo } from './repo';
import { resultTail } from './repo';
import type { BdResult, BdRunner, RepoCredentials } from './runner';
import type { WithLeaseOptions } from './worker';

/** One linked repository, as a tool call targets it. */
export interface ToolRepo {
  orgId: string;
  projectId: string;
  repositoryId: string;
  slug: string;
}

/** A failure the agent should read as-is: no stack, no token, one actionable sentence. */
export class BeadsToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BeadsToolError';
  }
}

export interface BeadsToolOpsDeps {
  runner: BdRunner;
  versionControl: VersionControl | undefined;
  /** Runs `fn` under the writer lease; undefined when the worker is not running. */
  withLease: (<R>(fn: () => Promise<R>, options?: WithLeaseOptions) => Promise<R>) | undefined;
  /** The cached copy for a repository (shared with the sweep). */
  repoFor(slug: string, cloneUrl: string): BdRepo;
  /** Drop the cached copy and any "no beads data" memory, so the next sweep looks again. */
  forget(slug: string): Promise<void>;
  hasBeadsData(cloneUrl: string, credentials: RepoCredentials | undefined): Promise<boolean>;
  /** The repository's state in the last sweep, if any. */
  repoState(orgId: string, slug: string): string | undefined;
  /** Startup precondition failure, or undefined when the integration can run. */
  idleReason(): Promise<string | undefined>;
  /** A write is committed on the host copy but not yet on origin. */
  markUnpublished(slug: string, unpublished: boolean): void;
  /** Ask the sweep to run soon (cards for new ready beads). */
  kick(): void;
  syncRetry?: { retries?: number; baseDelayMs?: number };
  leaseWait?: WithLeaseOptions;
}

/** Actor recorded on every bead an agent tool writes, distinct from the sweep's closes. */
export const AGENT_ACTOR_SUFFIX = '/agent';

const MAX_OUTPUT = 60_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** bd's JSON output, parsed; plain text (cut to size) when it is not JSON. */
export function parseBdOutput(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[truncated]` : text;
  }
}

export interface WriteOutcome {
  output: unknown;
  /** True when `bd sync` published the write to origin. */
  published: boolean;
  /** Why it was not published, when it was not. */
  publishNote?: string;
}

export class BeadsToolOps {
  readonly #deps: BeadsToolOpsDeps;

  constructor(deps: BeadsToolOpsDeps) {
    this.#deps = deps;
  }

  get actor(): string {
    return `${this.#deps.runner.actor}${AGENT_ACTOR_SUFFIX}`;
  }

  #lease<R>(fn: () => Promise<R>): Promise<R> {
    const withLease = this.#deps.withLease;
    if (!withLease) throw new BeadsToolError('the beads sync worker is not running on this server, so beads cannot be read or written');
    return withLease(fn, this.#deps.leaseWait);
  }

  async #access(target: ToolRepo): Promise<{ cloneUrl: string; credentials: RepoCredentials | undefined }> {
    const idle = await this.#deps.idleReason();
    if (idle) throw new BeadsToolError(`the beads integration is idle: ${idle}`);
    const vc = this.#deps.versionControl;
    if (!vc) throw new BeadsToolError('source control has no versionControl capability (is the GitHub App configured?)');
    const access = await vc.getRepositoryAccess({ orgId: target.orgId, repositoryId: target.repositoryId });
    const credentials = access.authorization
      ? { token: access.authorization.token, username: access.authorization.username }
      : undefined;
    return { cloneUrl: access.cloneUrl, credentials };
  }

  /** The bootstrapped copy, or a BeadsToolError naming beads_init when origin has no beads data. */
  async #prepare(target: ToolRepo): Promise<{ repo: BdRepo; credentials: RepoCredentials | undefined }> {
    const { cloneUrl, credentials } = await this.#access(target);
    const repo = this.#deps.repoFor(target.slug, cloneUrl);
    if (!repo.bootstrapped) {
      if (!(await this.#deps.hasBeadsData(cloneUrl, credentials))) {
        throw new BeadsToolError(
          `${target.slug} does not use beads yet (origin has no refs/dolt/data). Ask a person whether to start beads there; only if they agree, call beads_init.`,
        );
      }
      try {
        await repo.ensure(credentials);
      } catch (error) {
        throw new BeadsToolError(`could not set up the beads copy of ${target.slug}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { repo, credentials };
  }

  /** Run `fn` on the prepared copy under the lease; for reads that need more than one bd call. */
  inspect<R>(target: ToolRepo, fn: (repo: BdRepo) => Promise<R>): Promise<R> {
    return this.#lease(async () => fn((await this.#prepare(target)).repo));
  }

  /**
   * Run a bd command that writes nothing. `args` must not include `--json` or
   * a mode flag. Default mode `readonly` adds `--readonly`. `dry-run` is for
   * commands bd refuses under `--readonly` even with their own `--dry-run`
   * (bd 1.3.0: "operation 'pour' is not allowed in read-only mode"); it runs
   * with `--sandbox` instead, still under the lease, and never syncs.
   * `check` sees the copy and may refuse first.
   */
  read(
    target: ToolRepo,
    args: readonly string[],
    options: { mode?: 'readonly' | 'dry-run'; check?: (repo: BdRepo) => Promise<void> } = {},
  ): Promise<unknown> {
    return this.#lease(async () => {
      const { repo } = await this.#prepare(target);
      await options.check?.(repo);
      const mode = options.mode === 'dry-run' ? '--sandbox' : '--readonly';
      const res = await this.#deps.runner.bd([mode, ...args, '--json'], { cwd: repo.dir });
      if (res.code !== 0) throw new BeadsToolError(`bd ${args[0]} failed (exit ${res.code}): ${errorText(res)}`);
      return parseBdOutput(res.stdout);
    });
  }

  /**
   * Run one bd write on the copy, then publish it with `bd sync`, as the agent
   * actor unless `options.actor` names another (a person's card comment
   * copied to bd, samskara-l2t.7, is written as the integration). `build` sees
   * the freshly pulled copy (for checks that need it, such as the
   * repository's issue types or a bead's status) and returns the bd
   * arguments, or throws a BeadsToolError to refuse before anything is
   * written.
   *
   * A `bd sync` conflict (exit 2 or 4) parks the repository exactly as a
   * write-back conflict does: state `parked`, no intake and no writes until an
   * operator resolves it and calls POST /web/beads/reset.
   */
  write(target: ToolRepo, build: (repo: BdRepo) => Promise<readonly string[]>, options: { actor?: string } = {}): Promise<WriteOutcome> {
    return this.#lease(async () => {
      const { repo, credentials } = await this.#prepare(target);
      const parked = repo.parkedReason() ?? (this.#deps.repoState(target.orgId, target.slug) === 'parked' ? 'bd sync conflict' : undefined);
      if (parked) {
        throw new BeadsToolError(
          `${target.slug} is parked (${parked}); nothing can be written until an operator resolves it and resets the copy (POST /web/beads/reset)`,
        );
      }
      const pull = await repo.pull(credentials);
      if (pull.code !== 0) throw new BeadsToolError(`bd dolt pull failed (exit ${pull.code}), nothing was written: ${errorText(pull)}`);
      const args = await build(repo);
      const res = await this.#deps.runner.bd(['--sandbox', '--actor', options.actor ?? this.actor, ...args, '--json'], { cwd: repo.dir });
      if (res.code !== 0) throw new BeadsToolError(`bd ${args[0]} failed (exit ${res.code}), nothing was written: ${errorText(res)}`);
      const output = parseBdOutput(res.stdout);
      const sync = await this.#sync(repo, credentials);
      if (sync.code === 0) {
        this.#deps.markUnpublished(target.slug, false);
        this.#deps.kick();
        return { output, published: true };
      }
      if (sync.code === 2 || sync.code === 4) {
        const diagnostic = `bd sync exit ${sync.code} after an agent write: ${errorText(sync)}`;
        await repo.park(diagnostic);
        this.#deps.markUnpublished(target.slug, false);
        return {
          output,
          published: false,
          publishNote: `${sync.code === 2 ? 'merge conflict' : 'stuck working set'}: the write is saved on the host copy but NOT published, and ${target.slug} is now parked until an operator resolves it and resets the copy (POST /web/beads/reset). Do not retry. ${diagnostic}`,
        };
      }
      this.#deps.markUnpublished(target.slug, true);
      return {
        output,
        published: false,
        publishNote: `bd sync exit ${sync.code}: the write is saved on the host copy and the next sweep publishes it. Do not repeat the write. ${errorText(sync)}`,
      };
    });
  }

  async #sync(repo: BdRepo, credentials: RepoCredentials | undefined): Promise<BdResult> {
    const retries = this.#deps.syncRetry?.retries ?? 2;
    const base = this.#deps.syncRetry?.baseDelayMs ?? 2_000;
    let result = await repo.sync(credentials);
    for (let attempt = 0; result.code === 3 && attempt < retries; attempt++) {
      await sleep(base * 2 ** attempt);
      result = await repo.sync(credentials);
    }
    return result;
  }

  /**
   * Start beads in a repository that has none: clone, `bd init --prefix`,
   * `bd dolt push --yes` (the runner keeps DOLT_REMOTE_INFO_BRANCH blank), then
   * drop the copy so the next sweep bootstraps it from origin like any other
   * beads repository.
   */
  init(target: ToolRepo, prefix: string): Promise<{ repository: string; prefix: string; published: true }> {
    return this.#lease(async () => {
      const { cloneUrl, credentials } = await this.#access(target);
      if (await this.#deps.hasBeadsData(cloneUrl, credentials)) {
        throw new BeadsToolError(`${target.slug} already uses beads (origin has refs/dolt/data); nothing to initialise`);
      }
      await this.#deps.forget(target.slug);
      const repo = this.#deps.repoFor(target.slug, cloneUrl);
      const runner = this.#deps.runner;
      const opts = { cwd: repo.dir, credentials };
      try {
        await mkdir(repo.dir, { recursive: true });
        const clone = await runner.git(['clone', '--depth', '1', cloneUrl, '.'], opts);
        if (clone.code !== 0) throw new BeadsToolError(`git clone failed (exit ${clone.code}): ${errorText(clone)}`);
        await runner.git(['config', 'beads.role', 'maintainer'], opts);
        // --skip-agents/--skip-hooks: this checkout is the host's cache, never
        // committed, so AGENTS.md, editor setup and git hooks would only be noise.
        const init = await runner.bd(
          ['init', `--prefix=${prefix}`, '--non-interactive', '--role=maintainer', '--skip-agents', '--skip-hooks', '--quiet'],
          { cwd: repo.dir, timeoutMs: 300_000 },
        );
        if (init.code !== 0) throw new BeadsToolError(`bd init failed (exit ${init.code}): ${errorText(init)}`);
        const push = await runner.bd(['dolt', 'push', '--yes'], { ...opts, timeoutMs: 300_000 });
        if (push.code !== 0) throw new BeadsToolError(`bd dolt push failed (exit ${push.code}); origin was not changed: ${errorText(push)}`);
        if (!(await this.#deps.hasBeadsData(cloneUrl, credentials))) {
          throw new BeadsToolError('bd dolt push reported success but origin still has no refs/dolt/data');
        }
      } finally {
        // Success or not, the next sweep (or tool call) starts from origin.
        await this.#deps.forget(target.slug);
      }
      this.#deps.kick();
      return { repository: target.slug, prefix, published: true };
    });
  }
}

function errorText(result: BdResult): string {
  return resultTail(result, 600);
}
