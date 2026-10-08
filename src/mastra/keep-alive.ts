/**
 * Keep idle outbound HTTP connections open for 20 seconds (samskara-lx1).
 *
 * Turso is reached over HTTPS by `@libsql/client` 0.18, whose transport
 * (`@libsql/hrana-client` 0.10) calls the plain global `fetch`
 * (`hrana-client/lib-esm/http/client.js:46`). Node's `fetch` is undici, and
 * undici closes an idle socket after 4 seconds by default. Turso sends no
 * Keep-Alive header to extend that, so every query after a gap of more than
 * 4 seconds opens a new TLS connection, which costs about 150-400ms.
 *
 * Measured 2026-10-08 against the production database with 6-second gaps
 * between queries: by default, median 217ms and a new TCP connection for
 * every query; with this 20-second keep-alive, median 43.5ms on one
 * connection.
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
