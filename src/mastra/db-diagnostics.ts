/**
 * Diagnostic for samskara-lx1. Temporary: remove once the cause is fixed.
 *
 * Better Auth's two per-request queries take 0.5-1.1s inside the production
 * process, yet the same statements take 44-62ms from outside it against the
 * same Turso database (indexed lookups on 5- and 2-row tables), and a fresh
 * process in the same container reuses a connection in ~43ms. So the time is
 * spent inside the app process. Two candidates:
 *
 * 1. Queueing on the shared client. `@libsql/client` runs at most 20 requests
 *    at once and queues the rest (`http.js:48-56`, default in
 *    `@libsql/core` `config.js:17`), and every Factory domain and Better Auth
 *    share the one client (`@mastra/libsql` `authDatabase()`).
 * 2. A busy event loop, which delays every await in the process.
 *
 * Every 30s this logs, only when something was slow: calls on the shared
 * client, the most in flight at once, the slowest call with its leading SQL
 * (never its arguments), and event-loop delay. In-flight near 20 points at
 * (1); a high event-loop delay points at (2).
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';

const REPORT_EVERY_MS = 30_000;
const SLOW_MS = 250;

type Method = (...args: unknown[]) => Promise<unknown>;

export function watchDatabaseClient(client: object): void {
  let calls = 0;
  let slow = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let slowest = { ms: 0, what: '' };

  const target = client as Record<string, unknown>;
  for (const name of ['execute', 'batch', 'transaction', 'executeMultiple', 'migrate']) {
    const original = target[name];
    if (typeof original !== 'function') continue;
    target[name] = async (...args: unknown[]) => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const started = performance.now();
      try {
        return await (original as Method).apply(client, args);
      } finally {
        inFlight -= 1;
        const ms = Math.round(performance.now() - started);
        if (ms >= SLOW_MS) slow += 1;
        if (ms > slowest.ms) {
          const first = args[0] as { sql?: string } | string | unknown[] | undefined;
          const sql =
            typeof first === 'string' ? first : Array.isArray(first) ? `${first.length} statements` : (first?.sql ?? '');
          slowest = { ms, what: `${name}: ${sql.replace(/\s+/g, ' ').slice(0, 70)}` };
        }
      }
    };
  }

  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();

  const timer = setInterval(() => {
    const p99 = Math.round(loop.percentile(99) / 1e6);
    const max = Math.round(loop.max / 1e6);
    if (slow > 0 || p99 >= SLOW_MS) {
      console.log(
        `[db:diag] 30s: calls=${calls} slow=${slow} maxInFlight=${maxInFlight} inFlightNow=${inFlight} ` +
          `slowest=${slowest.ms}ms (${slowest.what}) eventLoop p99=${p99}ms max=${max}ms`,
      );
    }
    calls = 0;
    slow = 0;
    maxInFlight = inFlight;
    slowest = { ms: 0, what: '' };
    loop.reset();
  }, REPORT_EVERY_MS);
  timer.unref();
}
