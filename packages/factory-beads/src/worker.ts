/**
 * The beads sync worker: the only place a bead is ever written. Sweeps run in
 * its tick; agent-tool writes run through `withLease`. Both hold the same lease
 * and the same in-process mutex, so they never overlap.
 *
 * It mirrors Factory's `IssueReconcileWorker` (@mastra/factory 0.20.0
 * dist/integrations/issue-reconcile-worker.js:6-88) — an interval tick that
 * runs only while holding a lease from the server's pubsub `LeaseProvider`,
 * renewed at a third of its TTL and released after the tick. It is its own
 * class because that worker has no way to run a tick on demand: the Done rule
 * needs one, and every write path, including that wake-up, must go through
 * the same lease.
 *
 * Lease source, in order: the `leaseProvider` option; the worker's pubsub when
 * it implements `LeaseProvider` (`RedisStreamsPubSub` does —
 * @mastra/redis-streams dist/index.d.ts:88), resolved exactly as
 * issue-reconcile-worker.js:92-96 does; otherwise core's `NoopLeaseProvider`
 * (@mastra/core dist/events/pubsub.d.ts:237-243), which always wins and is
 * therefore single-process only. A database-row lease is deliberately not the
 * fallback: on libSQL, `FactoryStorageOps.updateAtomic` serialises through an
 * in-process promise chain (@mastra/libsql dist/index.js:1395-1399, :14455), so
 * it would not exclude a second process either.
 */
import { NoopLeaseProvider, isLeaseProvider } from '@mastra/core/events';
import type { LeaseProvider } from '@mastra/core/events';
import { MastraWorker } from '@mastra/core/worker';
import type { WorkerDeps } from '@mastra/core/worker';

const MIN_LEASE_TTL_MS = 30_000;

export type LeaseSource = 'option' | 'pubsub' | 'noop';

export interface BeadsSyncWorkerOptions<T> {
  name: string;
  leaseKey: string;
  intervalMs: number;
  /** One sweep. Called only while this process holds the lease. */
  sweep: () => Promise<T>;
  leaseProvider?: LeaseProvider;
  /** Delay between a kick and its tick, so a burst of Done moves coalesces. */
  kickDelayMs?: number;
}

export type TickOutcome<T> = { ran: true; result: T } | { ran: false; reason: 'lease-held' | 'not-running' };

/**
 * `withLease` gave up waiting: another process held the writer lease
 * (`lease`), or a sweep or another beads operation in this process ran the
 * whole time (`queue`).
 */
export class LeaseWaitTimeoutError extends Error {
  constructor(key: string, waitedMs: number, cause: 'lease' | 'queue' = 'lease') {
    const seconds = Math.round(waitedMs / 1000);
    super(
      cause === 'lease'
        ? `the ${key} lease was held by another process for ${seconds} s; try again shortly`
        : `waited ${seconds} s behind a sweep or another beads operation on this server (${key}); try again shortly`,
    );
    this.name = 'LeaseWaitTimeoutError';
  }
}

export interface WithLeaseOptions {
  /** Give up after this long, counting both the in-process queue and the lease. Default 120 s. */
  timeoutMs?: number;
  /** Delay between attempts while another process holds the lease. Default 1 s. */
  pollMs?: number;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function resolveLeaseProvider(pubsub: WorkerDeps['pubsub'] | undefined): LeaseProvider | undefined {
  if (!pubsub) return undefined;
  const getProvider = (pubsub as { getLeaseProvider?: () => LeaseProvider | undefined }).getLeaseProvider;
  if (typeof getProvider === 'function') return getProvider.call(pubsub) ?? undefined;
  if (isLeaseProvider(pubsub)) return pubsub;
  return (pubsub as { lease?: LeaseProvider }).lease ?? undefined;
}

export class BeadsSyncWorker<T> extends MastraWorker {
  readonly name: string;
  readonly #options: BeadsSyncWorkerOptions<T>;
  readonly #owner = globalThis.crypto.randomUUID();
  readonly #leaseTtlMs: number;
  #lease: LeaseProvider = NoopLeaseProvider;
  #leaseSource: LeaseSource = 'noop';
  #running = false;
  #timer: NodeJS.Timeout | undefined;
  #inFlight: Promise<TickOutcome<T>> | undefined;
  #again = false;
  /**
   * In-process exclusion between ticks and `withLease` calls. The lease alone
   * cannot give it: the no-op provider grants every acquire, and one owner id
   * is shared by everything in this process.
   */
  #mutex: Promise<unknown> = Promise.resolve();

  constructor(options: BeadsSyncWorkerOptions<T>) {
    super();
    if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error('factory-beads: pollIntervalMs must be a positive number');
    }
    this.name = options.name;
    this.#options = options;
    this.#leaseTtlMs = Math.max(MIN_LEASE_TTL_MS, options.intervalMs * 3);
    if (options.leaseProvider) {
      this.#lease = options.leaseProvider;
      this.#leaseSource = 'option';
    }
  }

  override async init(deps: WorkerDeps): Promise<void> {
    await super.init(deps);
    if (this.#leaseSource === 'option') return;
    const provider = resolveLeaseProvider(deps.pubsub);
    if (provider) {
      this.#lease = provider;
      this.#leaseSource = 'pubsub';
    }
  }

  get leaseSource(): LeaseSource {
    return this.#leaseSource;
  }

  get isRunning(): boolean {
    return this.#running;
  }

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.deps?.logger.info(`${this.name} started`, { intervalMs: this.#options.intervalMs, lease: this.#leaseSource });
    if (this.#leaseSource === 'noop') {
      this.deps?.logger.warn(
        `${this.name}: no lease provider (set REDIS_URL or pass leaseProvider); the single-writer guarantee holds only while ONE server process runs`,
      );
    }
    this.#schedule(0);
  }

  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#inFlight;
  }

  /** Run a tick soon. Coalesces with a pending one; re-runs once if a tick is in flight. */
  kick(): void {
    if (!this.#running) return;
    if (this.#inFlight) {
      this.#again = true;
      return;
    }
    this.#schedule(this.#options.kickDelayMs ?? 1_000);
  }

  /** Run a tick now, under the lease, and return what happened. Works without `start()`. */
  runNow(): Promise<TickOutcome<T>> {
    if (this.#inFlight) {
      const next = () => this.runNow();
      return this.#inFlight.then(next, next);
    }
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    return this.#launch();
  }

  /**
   * Run `fn` while holding the writer lease, after any tick or other
   * `withLease` call in this process. When another process holds the lease,
   * wait for it (polling). The whole wait, queue and lease together, is
   * capped at `timeoutMs`; past it the call throws `LeaseWaitTimeoutError`
   * and `fn` never runs. Once `fn` has started it is not interrupted.
   * Works without `start()`.
   *
   * `fn` must not call `runNow()`: that waits for this call and deadlocks.
   * Use `kick()` to ask for a sweep afterwards.
   */
  withLease<R>(fn: () => Promise<R>, options: WithLeaseOptions = {}): Promise<R> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const pollMs = options.pollMs ?? 1_000;
    const key = this.#options.leaseKey;
    const started = Date.now();
    let begun = false;
    let abandoned = false;
    const run = this.#exclusive(async () => {
      // Timed out while queued: the caller already has its error.
      if (abandoned) throw new LeaseWaitTimeoutError(key, Date.now() - started, 'queue');
      begun = true;
      while (!(await this.#acquire())) {
        if (Date.now() - started >= timeoutMs) throw new LeaseWaitTimeoutError(key, Date.now() - started);
        await sleep(pollMs);
      }
      return this.#hold(fn);
    });
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (begun) return;
        abandoned = true;
        reject(new LeaseWaitTimeoutError(key, Date.now() - started, 'queue'));
      }, timeoutMs);
      timer.unref?.();
      run.then(
        value => {
          clearTimeout(timer);
          resolve(value);
        },
        error => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  #exclusive<R>(fn: () => Promise<R>): Promise<R> {
    const run = this.#mutex.then(fn, fn);
    this.#mutex = run.catch(() => undefined);
    return run;
  }

  async #acquire(): Promise<boolean> {
    const result = await this.#lease
      .acquireLease(this.#options.leaseKey, this.#owner, this.#leaseTtlMs)
      .catch(() => ({ acquired: false as const }));
    return result.acquired;
  }

  /** Run `fn` under an acquired lease: renewed at a third of its TTL, released after. */
  async #hold<R>(fn: () => Promise<R>): Promise<R> {
    const key = this.#options.leaseKey;
    const renewal = setInterval(
      () => {
        this.#lease.renewLease(key, this.#owner, this.#leaseTtlMs).catch(error => {
          this.deps?.logger.warn(`${this.name} lease renewal failed`, {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      },
      Math.max(1_000, Math.floor(this.#leaseTtlMs / 3)),
    );
    renewal.unref?.();
    try {
      return await fn();
    } finally {
      clearInterval(renewal);
      await this.#lease.releaseLease(key, this.#owner).catch(() => undefined);
    }
  }

  #schedule(delayMs: number): void {
    if (!this.#running) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#launch().catch(() => undefined);
    }, delayMs);
    this.#timer.unref?.();
  }

  #launch(): Promise<TickOutcome<T>> {
    const run = this.#tick().finally(() => {
      this.#inFlight = undefined;
      const again = this.#again;
      this.#again = false;
      this.#schedule(again ? 0 : this.#options.intervalMs);
    });
    this.#inFlight = run;
    return run;
  }

  #tick(): Promise<TickOutcome<T>> {
    return this.#exclusive(async (): Promise<TickOutcome<T>> => {
      if (!(await this.#acquire())) return { ran: false, reason: 'lease-held' };
      return this.#hold(async () => {
        try {
          return { ran: true, result: await this.#options.sweep() };
        } catch (error) {
          this.deps?.logger.warn(`${this.name} sweep failed`, { error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      });
    });
  }
}
