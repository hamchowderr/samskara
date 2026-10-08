/**
 * Keep idle outbound HTTP connections open for 20 seconds (samskara-lx1).
 *
 * Turso is reached over HTTPS through `@libsql/isomorphic-fetch`, which calls
 * the global `fetch` with a node-fetch style `agent: { keepAlive: true }`
 * option (`@libsql/isomorphic-fetch/node.js:7-20`). Node's `fetch` is undici
 * and ignores `agent`, so connections fall back to undici's default: closed
 * after 4 seconds idle. Turso sends no Keep-Alive header to extend that.
 *
 * In production the Factory UI polls about every 5 seconds, so nearly every
 * query opened a fresh TLS connection. Measured 2026-10-07/08 inside the
 * container: Better Auth's two per-request queries took 0.6-1.1s each, and
 * the auth gate 1.1-2.5s; a request on a reused connection took 41-45ms.
 *
 * The dispatcher is process-wide, so this applies to every outbound fetch
 * (GitHub, Slack, model providers). 20s keeps a 5-second poll on one
 * connection while staying short enough that a server is unlikely to have
 * dropped the socket first. It must run before anything opens a
 * connection. It is a function called at the top of index.ts
 * rather than a side-effect import: `mastra build` drops a bare
 * `import './keep-alive'` from the bundle (checked in .mastra/output).
 */
import { Agent, setGlobalDispatcher } from 'undici';

export function keepOutboundConnectionsAlive(): void {
  setGlobalDispatcher(new Agent({ keepAliveTimeout: 20_000, keepAliveMaxTimeout: 600_000 }));
}
