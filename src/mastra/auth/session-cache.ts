/**
 * A short in-process cache in front of Better Auth's `getSession`, for the
 * Factory auth gate only (samskara-lx1).
 *
 * WHY. The gate (`@mastra/factory` dist/auth.js `createFactoryAuthGate`)
 * authenticates every non-`/auth/*` request through the provider, and the
 * provider calls `auth.api.getSession({ headers })` each time
 * (`@mastra/auth-better-auth` dist/index.js `authenticateToken`). That reads
 * the session row and the user row. Turso Cloud stalls for about a second
 * every few seconds, so a page that fires a dozen API calls waits on a dozen
 * pairs of queries.
 *
 * WHY NOT BETTER AUTH'S OWN CACHES.
 * - `session.cookieCache` keeps the session in a signed cookie that only a
 *   response can refresh. The gate calls `getSession` server-side and never
 *   returns its Set-Cookie, and the SPA asks `/auth/me` (also server-side)
 *   rather than Better Auth's `/get-session`. So the cookie is set at sign-in
 *   and is never renewed once its `maxAge` passes.
 * - `secondaryStorage` with an in-memory store and `storeSessionInDatabase`
 *   falls back to the database on a miss, but never writes the row back into
 *   the store (better-auth 1.7.5 dist/db/internal-adapter.mjs `findSession`;
 *   `updateSession` only rewrites a key that is already present). After every
 *   restart each existing session stays on the database path until the user
 *   signs in again, and the daily `updateAge` refresh keeps an active session
 *   alive indefinitely. It also moves verification tokens out of the database.
 *
 * HOW IT STAYS CORRECT.
 * - The key is the signed session cookie, signature included. An entry is
 *   only created after Better Auth verified that exact string, so a hit can
 *   skip the HMAC check without accepting anything Better Auth would not.
 * - Null results are never cached.
 * - An entry lives `ttlMs` at most, and never past the session's `expiresAt`.
 * - `buildBetterAuth` clears the whole cache from Better Auth's own database
 *   hooks whenever a session or user row is updated or deleted: sign-out,
 *   revoke, password change with `revokeOtherSessions`, switching the active
 *   organization, profile edits, the `updateAge` refresh. Those are rare, so a
 *   full clear is cheaper than reasoning about which entries a change touched.
 *
 * WHAT IT DOES NOT COVER. A write that bypasses Better Auth (raw SQL against
 * `session` or `user`) is seen only after `ttlMs`. So is any write made by
 * another process: this cache is per container, so with two containers a
 * sign-out on one leaves the session valid on the other for up to `ttlMs`.
 */
import type { Auth } from 'better-auth';

export interface SessionCacheOptions {
  /** How long an entry may be served without asking Better Auth. */
  ttlMs?: number;
  /** Entries kept at most; the oldest is dropped first. */
  maxEntries?: number;
}

type SessionResult = { session: { expiresAt: Date | string }; user: unknown } | null;
type GetSession = (input: unknown) => Promise<SessionResult>;

interface Entry {
  promise: Promise<SessionResult>;
  /** 0 while the lookup is in flight. */
  expiresAt: number;
}

export class SessionCache {
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #entries = new Map<string, Entry>();

  constructor(options: SessionCacheOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 15_000;
    this.#maxEntries = options.maxEntries ?? 1_000;
  }

  /** Drop every entry. Called from Better Auth's session and user hooks. */
  clear(): void {
    this.#entries.clear();
  }

  /**
   * The same instance, with `api.getSession` served from this cache when it is
   * called the way the provider calls it: `{ headers }` and nothing else. Any
   * other call shape (query flags, `returnHeaders`, `asResponse`) goes straight
   * through, as does everything else on the instance.
   */
  wrap(auth: Auth): Auth {
    const getSession = auth.api.getSession as unknown as GetSession;
    const cached = async (input: unknown): Promise<SessionResult> => {
      const key = await this.#keyFor(auth, input);
      if (!key) return getSession(input);
      return this.#lookup(key, () => getSession(input));
    };
    const api = new Proxy(auth.api, {
      get: (target, prop, receiver) => (prop === 'getSession' ? cached : Reflect.get(target, prop, receiver)),
    });
    return new Proxy(auth, {
      get: (target, prop, receiver) => (prop === 'api' ? api : Reflect.get(target, prop, receiver)),
    });
  }

  async #lookup(key: string, load: () => Promise<SessionResult>): Promise<SessionResult> {
    const now = Date.now();
    const hit = this.#entries.get(key);
    if (hit && (hit.expiresAt === 0 || hit.expiresAt > now)) return clone(await hit.promise);
    if (hit) this.#entries.delete(key);

    const entry: Entry = { promise: load(), expiresAt: 0 };
    this.#entries.set(key, entry);
    if (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    let result: SessionResult;
    try {
      result = await entry.promise;
    } catch (err) {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
      throw err;
    }
    // A clear() while the lookup was in flight removed this entry; leave it
    // removed, since the result may predate the change that cleared it.
    if (this.#entries.get(key) === entry) {
      const sessionEnds = result ? new Date(result.session.expiresAt).getTime() : 0;
      if (!result || !(sessionEnds > now)) this.#entries.delete(key);
      else entry.expiresAt = Math.min(now + this.#ttlMs, sessionEnds);
    }
    return clone(result);
  }

  /** The signed session cookie, or null when the call is not the plain `{ headers }` shape. */
  async #keyFor(auth: Auth, input: unknown): Promise<string | null> {
    if (!input || typeof input !== 'object') return null;
    const keys = Object.keys(input);
    if (keys.length !== 1 || keys[0] !== 'headers') return null;
    const headers = (input as { headers: unknown }).headers;
    if (!(headers instanceof Headers)) return null;
    const cookie = headers.get('cookie');
    if (!cookie) return null;
    const name = (await auth.$context).authCookies.sessionToken.name;
    // A header carrying the session cookie twice goes straight through, so the
    // key can never be a different value from the one Better Auth verifies.
    let value: string | null = null;
    for (const pair of cookie.split(';')) {
      const at = pair.indexOf('=');
      if (at <= 0 || pair.slice(0, at).trim() !== name) continue;
      if (value !== null) return null;
      value = pair.slice(at + 1).trim();
    }
    return value || null;
  }
}

/** Callers get their own copy, so nothing they do to it reaches the cache. */
function clone(result: SessionResult): SessionResult {
  return result ? structuredClone(result) : result;
}
