/**
 * The gate's session lookup, against a real libSQL file (samskara-lx1).
 *
 * The Factory auth gate calls the provider on every request, and the provider
 * calls Better Auth's `getSession`, which queries the session row and the user
 * row. On Turso every query can stall for about a second, so the gate is
 * served from a short in-process cache instead. These tests count the
 * statements one authenticated request sends, and pin the invalidation rules.
 */
import { MastraAuthBetterAuth } from '@mastra/auth-better-auth';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildBetterAuth } from '../../src/mastra/auth/better-auth';
import { SessionCache } from '../../src/mastra/auth/session-cache';
import { signIn, signUp, tempAuthDatabase, TEST_SECRET } from '../helpers/auth-db';

let db: ReturnType<typeof tempAuthDatabase>;

afterEach(() => {
  vi.restoreAllMocks();
  db?.cleanup();
});

/** Count statements sent on the client while `fn` runs. */
async function countStatements(client: object, fn: () => Promise<unknown>) {
  const target = client as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const sql: string[] = [];
  const originals = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  for (const name of ['execute', 'batch']) {
    const original = target[name]!;
    originals.set(name, original);
    target[name] = async (...args: unknown[]) => {
      const first = args[0] as { sql?: string } | string | unknown[];
      sql.push(typeof first === 'string' ? first : Array.isArray(first) ? `batch(${first.length})` : (first?.sql ?? ''));
      return original.apply(client, args);
    };
  }
  try {
    await fn();
  } finally {
    for (const [name, original] of originals) target[name] = original;
  }
  return sql;
}

/**
 * A signed-in member of one org. Production sessions carry an
 * activeOrganizationId (the session.create hook in better-auth.ts); without
 * one the provider adds a `member` query of its own, outside getSession.
 */
async function member(auth: Awaited<ReturnType<typeof buildBetterAuth>>, email: string) {
  const { userId } = await signUp(auth, email);
  const now = new Date().toISOString();
  await db.client.execute({
    sql: 'INSERT INTO "organization" ("id","name","slug","createdAt") VALUES (?,?,?,?)',
    args: ['org-1', 'org-1', 'org-1', now],
  });
  await db.client.execute({
    sql: 'INSERT INTO "member" ("id","organizationId","userId","role","createdAt") VALUES (?,?,?,?,?)',
    args: ['m-1', 'org-1', userId, 'owner', now],
  });
  return { headers: await signIn(auth, email) };
}

function requestWith(headers: Headers) {
  return new Request('http://localhost/api/anything', { headers });
}

async function setup(cache?: SessionCache) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  db = tempAuthDatabase();
  const auth = await buildBetterAuth({ secret: TEST_SECRET, database: db.database, sessionCache: cache });
  const provider = new MastraAuthBetterAuth({ auth: cache ? cache.wrap(auth) : auth });
  return { auth, provider };
}

describe('statements per authenticated request', () => {
  it('without the cache, every request queries the database', async () => {
    const { auth, provider } = await setup();
    const { headers } = await member(auth, 'a@example.test');
    await provider.authenticateToken('', requestWith(headers)); // warm-up

    const sql = await countStatements(db.client, async () => {
      const result = await provider.authenticateToken('', requestWith(headers));
      expect(result?.user.email).toBe('a@example.test');
    });
    console.info(`[lx1] uncached request: ${sql.length} statements\n  ${sql.map(s => s.replace(/\s+/g, ' ').slice(0, 90)).join('\n  ')}`);
    expect(sql.length).toBeGreaterThan(0);
  });

  it('with the cache, a repeat request sends no statements', async () => {
    const { auth, provider } = await setup(new SessionCache());
    const { headers } = await member(auth, 'a@example.test');
    await provider.authenticateToken('', requestWith(headers)); // first request fills the cache

    const sql = await countStatements(db.client, async () => {
      const result = await provider.authenticateToken('', requestWith(headers));
      expect(result?.user.email).toBe('a@example.test');
    });
    console.info(`[lx1] cached request: ${sql.length} statements`);
    expect(sql).toEqual([]);
  });

  it('concurrent first requests share one lookup', async () => {
    const { auth } = await setup();
    const { headers } = await member(auth, 'a@example.test');
    const single = new MastraAuthBetterAuth({ auth: new SessionCache().wrap(auth) });
    const one = await countStatements(db.client, () => single.authenticateToken('', requestWith(headers)));
    const burst = new MastraAuthBetterAuth({ auth: new SessionCache().wrap(auth) });
    const many = await countStatements(db.client, () =>
      Promise.all(Array.from({ length: 5 }, () => burst.authenticateToken('', requestWith(headers)))),
    );
    expect(many.length).toBe(one.length);
  });
});

describe('invalidation', () => {
  it('a signed-out session stops authenticating at once', async () => {
    const { auth, provider } = await setup(new SessionCache());
    const { headers } = await signUp(auth, 'a@example.test');
    expect(await provider.authenticateToken('', requestWith(headers))).not.toBeNull();

    await auth.api.signOut({ headers });
    expect(await provider.authenticateToken('', requestWith(headers))).toBeNull();
  });

  it('a revoked session stops authenticating at once', async () => {
    const { auth, provider } = await setup(new SessionCache());
    const { headers: first } = await signUp(auth, 'a@example.test');
    const second = await signIn(auth, 'a@example.test');
    expect(await provider.authenticateToken('', requestWith(first))).not.toBeNull();

    // Revoke the first session from the second device.
    const sessions = (await auth.api.listSessions({ headers: second })) as Array<{ token: string }>;
    const firstToken = (await auth.api.getSession({ headers: first }))!.session.token;
    expect(sessions.map(s => s.token)).toContain(firstToken);
    await auth.api.revokeSession({ headers: second, body: { token: firstToken } });

    expect(await provider.authenticateToken('', requestWith(first))).toBeNull();
    expect(await provider.authenticateToken('', requestWith(second))).not.toBeNull();
  });

  it('a user update is visible at once', async () => {
    const { auth, provider } = await setup(new SessionCache());
    const { headers } = await signUp(auth, 'a@example.test');
    expect((await provider.authenticateToken('', requestWith(headers)))?.user.name).toBe('a');

    await auth.api.updateUser({ headers, body: { name: 'Renamed' } });
    expect((await provider.authenticateToken('', requestWith(headers)))?.user.name).toBe('Renamed');
  });

  it('an entry never outlives the session it caches', async () => {
    // A TTL longer than the session's own life, so only the expiresAt cap
    // can end the entry.
    const cache = new SessionCache({ ttlMs: 30 * 24 * 3600_000 });
    const { auth, provider } = await setup(cache);
    const { headers } = await signUp(auth, 'a@example.test');
    expect(await provider.authenticateToken('', requestWith(headers))).not.toBeNull();

    await db.client.execute({ sql: 'UPDATE "session" SET "expiresAt" = ?', args: [new Date(Date.now() - 1000).toISOString()] });
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 8 * 24 * 3600_000);
    expect(await provider.authenticateToken('', requestWith(headers))).toBeNull();
  });

  it('a forged cookie is never served from the cache', async () => {
    const { auth, provider } = await setup(new SessionCache());
    const { headers } = await signUp(auth, 'a@example.test');
    expect(await provider.authenticateToken('', requestWith(headers))).not.toBeNull();

    const forged = new Headers({ cookie: headers.get('cookie')!.replace(/session_token=([^.;]+)\.[^;]+/, 'session_token=$1.forged') });
    expect(await provider.authenticateToken('', requestWith(forged))).toBeNull();
  });

  it('a header with the session cookie twice is never served from the cache', async () => {
    const { auth, provider } = await setup(new SessionCache());
    const { headers } = await member(auth, 'a@example.test');
    const cookie = headers.get('cookie')!;
    const doubled = new Headers({ cookie: `${cookie}; ${cookie}` });
    await provider.authenticateToken('', requestWith(doubled)); // would fill the cache if it were keyed

    const sql = await countStatements(db.client, () => provider.authenticateToken('', requestWith(doubled)));
    expect(sql.length).toBeGreaterThan(0);
  });
});
