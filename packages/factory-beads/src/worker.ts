/**
 * The beads sync worker: the only place a bead is ever written.
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

  async #tick(): Promise<TickOutcome<T>> {
    const key = this.#options.leaseKey;
    const acquired = await this.#lease
      .acquireLease(key, this.#owner, this.#leaseTtlMs)
      .catch(() => ({ acquired: false as const }));
    if (!acquired.acquired) return { ran: false, reason: 'lease-held' };
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
      return { ran: true, result: await this.#options.sweep() };
    } catch (error) {
      this.deps?.logger.warn(`${this.name} sweep failed`, { error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      clearInterval(renewal);
      await this.#lease.releaseLease(key, this.#owner).catch(() => undefined);
    }
  }
}
