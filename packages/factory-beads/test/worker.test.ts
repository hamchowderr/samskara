import type { LeaseProvider } from '@mastra/core/events';
import type { WorkerDeps } from '@mastra/core/worker';
import { describe, expect, it } from 'vitest';

import { BeadsSyncWorker } from '../src/index';

const logger = { info: () => undefined, warn: () => undefined, debug: () => undefined, error: () => undefined };

class MemoryLease implements LeaseProvider {
  owners = new Map<string, string>();
  async acquireLease(key: string, owner: string) {
    const current = this.owners.get(key);
    if (current && current !== owner) return { acquired: false, owner: current };
    this.owners.set(key, owner);
    return { acquired: true, owner };
  }
  async getLeaseOwner(key: string) {
    return this.owners.get(key);
  }
  async releaseLease(key: string, owner: string) {
    if (this.owners.get(key) === owner) this.owners.delete(key);
  }
  async renewLease(key: string, owner: string) {
    return this.owners.get(key) === owner;
  }
  async transferLease(key: string, from: string, to: string) {
    if (this.owners.get(key) !== from) return false;
    this.owners.set(key, to);
    return true;
  }
}

const deps = (pubsub: unknown) => ({ pubsub, logger, storage: {} }) as unknown as WorkerDeps;

describe('BeadsSyncWorker lease', () => {
  it('takes the lease from a pubsub that implements LeaseProvider (as RedisStreamsPubSub does)', async () => {
    const lease = new MemoryLease();
    const pubsub = Object.assign(lease, { publish: async () => undefined, subscribe: async () => undefined });
    const worker = new BeadsSyncWorker({ name: 'beads-sync', leaseKey: 'beads:writer', intervalMs: 60_000, sweep: async () => 1 });
    await worker.init(deps(pubsub));
    expect(worker.leaseSource).toBe('pubsub');
  });

  it('falls back to the no-op lease, and says so, without one', async () => {
    const worker = new BeadsSyncWorker({ name: 'beads-sync', leaseKey: 'beads:writer', intervalMs: 60_000, sweep: async () => 1 });
    await worker.init(deps({ publish: async () => undefined }));
    expect(worker.leaseSource).toBe('noop');
  });

  it('only one of two processes sweeps while the lease is held', async () => {
    const lease = new MemoryLease();
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    let sweeps = 0;
    const make = () =>
      new BeadsSyncWorker({
        name: 'beads-sync',
        leaseKey: 'beads:writer',
        intervalMs: 60_000,
        leaseProvider: lease,
        sweep: async () => {
          sweeps++;
          await gate;
          return sweeps;
        },
      });
    const a = make();
    const b = make();
    const first = a.runNow();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(await b.runNow()).toEqual({ ran: false, reason: 'lease-held' });
    release();
    expect(await first).toEqual({ ran: true, result: 1 });
    // Released after the tick: the other process can now take it.
    expect(await b.runNow()).toEqual({ ran: true, result: 2 });
  });
});
