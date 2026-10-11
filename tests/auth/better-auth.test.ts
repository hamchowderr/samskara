/**
 * The Better Auth instance Samskara owns, against a real libSQL file.
 *
 * Guards two fixes:
 * - samskara-gk0: migrating BEFORE constructing, so a first boot logs no
 *   false "Database schema mismatch" error.
 * - samskara-9t9: a new session is pinned to the user's most recently joined
 *   org, so an invitee does not sign back in to their empty personal org.
 * - A new session opens in the org the user last switched to, while they are
 *   still a member of it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildBetterAuth } from '../../src/mastra/auth/better-auth';
import { signIn, signUp, tempAuthDatabase, TEST_SECRET } from '../helpers/auth-db';

let db: ReturnType<typeof tempAuthDatabase>;

afterEach(() => {
  vi.restoreAllMocks();
  db?.cleanup();
});

async function freshAuth() {
  db = tempAuthDatabase();
  const auth = await buildBetterAuth({ secret: TEST_SECRET, database: db.database });
  return auth;
}

/** Insert an org and a membership with an explicit join time. */
async function addMembership(userId: string, orgId: string, joinedAt: string, role = 'member') {
  await db.client.execute({
    sql: 'INSERT OR IGNORE INTO "organization" ("id","name","slug","createdAt") VALUES (?,?,?,?)',
    args: [orgId, orgId, orgId, joinedAt],
  });
  await db.client.execute({
    sql: 'INSERT INTO "member" ("id","organizationId","userId","role","createdAt") VALUES (?,?,?,?,?)',
    args: [`${orgId}-${userId}`, orgId, userId, role, joinedAt],
  });
}

async function activeOrgOf(auth: Awaited<ReturnType<typeof freshAuth>>, headers: Headers) {
  const session = await auth.api.getSession({ headers });
  return (session?.session as { activeOrganizationId?: string | null } | undefined)?.activeOrganizationId ?? null;
}

describe('first boot on an empty database (samskara-gk0)', () => {
  it('creates the auth tables and logs no schema mismatch', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const auth = await freshAuth();
    // Wait for the schema check Better Auth starts at construction.
    const ctx = await auth.$context;
    await ctx.checkSchema?.();

    const tables = await db.client.execute(`SELECT name FROM sqlite_master WHERE type='table'`);
    const names = tables.rows.map(r => r.name);
    expect(names).toEqual(expect.arrayContaining(['user', 'session', 'account', 'organization', 'member', 'invitation']));

    const logged = errors.mock.calls.map(args => args.join(' ')).join('\n');
    expect(logged).not.toMatch(/schema mismatch/i);
  });

  it('is a no-op on an already-migrated database', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    db = tempAuthDatabase();
    await buildBetterAuth({ secret: TEST_SECRET, database: db.database });
    logs.mockClear();
    await buildBetterAuth({ secret: TEST_SECRET, database: db.database });
    expect(logs.mock.calls.flat().join('\n')).toContain('schema current');
  });
});

describe('which org a new session acts under (samskara-9t9)', () => {
  it('pins a new session to the most recently joined org, not the oldest', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const auth = await freshAuth();
    const { userId } = await signUp(auth, 'invitee@example.test');

    // The Factory creates a personal org on the invitee's first visit; they
    // join the team afterwards.
    await addMembership(userId, 'personal-org', '2026-09-01T00:00:00.000Z', 'owner');
    await addMembership(userId, 'team-org', '2026-09-02T00:00:00.000Z');

    const headers = await signIn(auth, 'invitee@example.test');
    expect(await activeOrgOf(auth, headers)).toBe('team-org');
  });

  it('uses the only org when there is one', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const auth = await freshAuth();
    const { userId } = await signUp(auth, 'owner@example.test');
    await addMembership(userId, 'solo-org', '2026-09-01T00:00:00.000Z', 'owner');

    const headers = await signIn(auth, 'owner@example.test');
    expect(await activeOrgOf(auth, headers)).toBe('solo-org');
  });

  it('opens a new session in the org the user last switched to, until they leave it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const auth = await freshAuth();
    const { userId } = await signUp(auth, 'switcher@example.test');
    await addMembership(userId, 'personal-org', '2026-09-01T00:00:00.000Z', 'owner');
    await addMembership(userId, 'team-org', '2026-09-02T00:00:00.000Z');

    const first = await signIn(auth, 'switcher@example.test');
    expect(await activeOrgOf(auth, first)).toBe('team-org');
    // The team page's switcher calls Better Auth's set-active.
    // The organization plugin's endpoint; buildBetterAuth returns the plain Auth type.
    const api = auth.api as unknown as { setActiveOrganization(input: { headers: Headers; body: { organizationId: string } }): Promise<unknown> };
    await api.setActiveOrganization({ headers: first, body: { organizationId: 'personal-org' } });
    await auth.api.signOut({ headers: first });

    const again = await signIn(auth, 'switcher@example.test');
    expect(await activeOrgOf(auth, again)).toBe('personal-org');

    // Removed from that org: back to the most recently joined one.
    await db.client.execute({ sql: 'DELETE FROM "member" WHERE "organizationId" = ? AND "userId" = ?', args: ['personal-org', userId] });
    const removed = await signIn(auth, 'switcher@example.test');
    expect(await activeOrgOf(auth, removed)).toBe('team-org');
  });

  it('does not remember an org from a session update that is not a choice (a refresh, another device)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const auth = await freshAuth();
    const { userId } = await signUp(auth, 'two-devices@example.test');
    await addMembership(userId, 'personal-org', '2026-09-01T00:00:00.000Z', 'owner');
    await addMembership(userId, 'team-org', '2026-09-02T00:00:00.000Z');
    const headers = await signIn(auth, 'two-devices@example.test');
    const session = await auth.api.getSession({ headers });
    // Outside any endpoint, as Better Auth's own refresh updates a session.
    const ctx = await auth.$context;
    await ctx.internalAdapter.updateSession(session!.session.token, { activeOrganizationId: 'personal-org' } as never);
    const { rows } = await db.client.execute({ sql: 'SELECT "lastActiveOrganizationId" FROM "user" WHERE "id" = ?', args: [userId] });
    expect(rows[0]?.lastActiveOrganizationId ?? null).toBeNull();
  });

  it('never takes the remembered org from a request', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const auth = await freshAuth();
    const { headers } = await signUp(auth, 'sneaky@example.test');
    await auth.api.updateUser({ headers, body: { lastActiveOrganizationId: 'someone-elses-org' } as never }).catch(() => undefined);
    const { rows } = await db.client.execute({ sql: 'SELECT "lastActiveOrganizationId" FROM "user" WHERE "email" = ?', args: ['sneaky@example.test'] });
    expect(rows[0]?.lastActiveOrganizationId ?? null).toBeNull();
  });

  it('leaves the session without an org when the user has none', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const auth = await freshAuth();
    const { headers } = await signUp(auth, 'new@example.test');
    expect(await activeOrgOf(auth, headers)).toBeNull();
  });
});
