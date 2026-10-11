/**
 * The Better Auth instance Samskara owns.
 *
 * WHY BUILD OUR OWN. `@mastra/auth-better-auth` can build one for us
 * ("deferred instance mode": pass `secret`, it does the rest). That path calls
 * `organization()` with NO options (dist/index.js:495), so
 * `sendInvitationEmail` can never be supplied and an invited teammate is never
 * notified — `invite-member` writes a row and nothing else happens. The
 * provider's only escape hatch is its `auth` option, a pre-built
 * `betterAuth()` instance (dist/index.d.ts:31).
 *
 * WHAT THAT COSTS. `init(ctx)` returns early at `if (this.#auth) return;`
 * (dist/index.js:477) and `#ensureDbReady()` returns early when
 * `!#ownsInstance` (dist/index.js:509). So from here on WE own:
 *   - schema migrations (see docs/operations/better-auth-migrations.md)
 *   - the database handle
 *   - `baseURL` and `trustedOrigins`
 *   - the cross-site cookie attributes
 * Everything this module configures below is a job the provider would
 * otherwise have done. Keeping it in step is enforced in CI, not requested in
 * a comment: `scripts/check-auth-provider-parity.mjs` hashes the provider's
 * `init()` and fails the build when it changes. When the two disagree, the
 * provider's `init()` is authoritative for the whole host contract; this file
 * is authoritative only for the mail callbacks it adds on top.
 *
 * WHAT IT BUYS. Beyond invite mail, `organization()` options also gate
 * `teams` (9 endpoints) and `dynamicAccessControl` (5), which return 404 in
 * deferred mode. They are left OFF here: turning them on is a separate
 * decision with its own schema, and this module only claims the mail fix.
 */
import { LibsqlDialect } from '@libsql/kysely-libsql';
import { betterAuth } from 'better-auth';
import type { Auth, BetterAuthOptions } from 'better-auth';
import { organization } from 'better-auth/plugins';

import { basicHtml, escapeHtml, mailConfigured, sendMail } from './mailer';
import { ensureAuthSchema } from './migrate';
import type { SessionCache } from './session-cache';
import { invitationPath } from '../team/paths';

/**
 * The host's auth database handle, exactly as `LibSQLFactoryStorage` returns
 * it from `authDatabase()` — `{ dialect: 'libsql', client }`. Taking the
 * host's client rather than opening a second one matters: two connections to
 * one local SQLite file contend on writes.
 */
export interface AuthDatabase {
  dialect: string;
  /** Present on the libsql branch. The postgres branch carries `pool` instead. */
  client?: unknown;
}

export interface BuildBetterAuthOptions {
  secret: string;
  database: AuthDatabase;
  /** Browser-facing origin, no trailing slash. Reset/verify links are built from this. */
  publicUrl?: string;
  /** Extra browser origins allowed to talk to the API. */
  allowedOrigins?: string[];
  /** Whether public sign-up is open. Mirrors the provider's `signUpEnabled`. */
  signUpEnabled?: boolean;
  /** Product name used in email subjects and bodies. */
  appName?: string;
  /**
   * The gate's session cache, cleared from this instance's database hooks
   * whenever a session or user row changes. See session-cache.ts.
   */
  sessionCache?: SessionCache;
}

/**
 * Migrate the auth schema, then build the instance to hand to
 * `new MastraAuthBetterAuth({ auth })`.
 *
 * The order matters. `betterAuth()` starts a schema check as soon as it is
 * called (better-auth dist/auth/base.mjs, `ctx.checkSchema?.()`), and on an
 * empty database that check runs while the migration is still creating the
 * tables. It then logs a false "Database schema mismatch / Missing tables"
 * ERROR on a boot that succeeds. `getMigrations()` needs only the options, so
 * migrating first means the check sees a current schema. The check itself stays
 * on (`validateSchema` defaults to true): auth requests wait on it and fail if
 * the schema is wrong, which is worth keeping.
 *
 * Throws on a non-libsql handle rather than guessing: the storage backend is
 * libSQL-only by design (see the Architecture note in CLAUDE.md), so anything
 * else means the entry file changed and this needs revisiting.
 */
export async function buildBetterAuth(options: BuildBetterAuthOptions): Promise<Auth> {
  const { secret, database, publicUrl, allowedOrigins = [], signUpEnabled = true, sessionCache } = options;
  // Runs after the write commits (with-hooks.mjs queues `*.after` hooks), so a
  // lookup that starts after the clear sees the new row.
  const clearSessionCache = { after: async () => sessionCache?.clear() };
  const appName = options.appName ?? 'Samskara';

  if (database.dialect !== 'libsql' || !database.client) {
    throw new Error(
      `buildBetterAuth expects a libsql auth database, got "${database.dialect}". ` +
        'Storage is libSQL-only here; if that changed, mirror the provider dialect switch at ' +
        '@mastra/auth-better-auth/dist/index.js:480.',
    );
  }
  const client = database.client as {
    execute(stmt: { sql: string; args: unknown[] }): Promise<{ rows: Array<Record<string, unknown>> }>;
  };

  // Links in mail must be absolute. With no MASTRACODE_PUBLIC_URL, fall back
  // to the local dev server rather than the request's Host header: an inviter
  // controls that header, and a Host-derived link would let them send a
  // Samskara-branded email pointing at any site they like.
  const linkBase = publicUrl ?? `http://localhost:${process.env.PORT?.trim() || '4111'}`;

  // `#crossSite` in the provider is `allowedOrigins.length > 0`. A cross-origin
  // SPA needs SameSite=None; Secure or the session cookie is dropped.
  const crossSite = allowedOrigins.length > 0;

  // Typed as BetterAuthOptions before the call: `betterAuth()` infers its
  // return from the literal it is handed, and the conditional spreads below
  // narrow that inference to something no longer assignable to plain `Auth`.
  const authOptions: BetterAuthOptions = {
    database: {
      dialect: new LibsqlDialect({ client: client as never }),
      type: 'sqlite',
    },
    secret,
    // The factory mounts the provider's handler under /auth/api/*; basePath
    // must agree or every generated link is wrong.
    basePath: '/auth/api',
    ...(publicUrl ? { baseURL: publicUrl } : {}),
    ...(allowedOrigins.length ? { trustedOrigins: allowedOrigins } : {}),

    // The org the user last acted in, so a new session opens there (see
    // databaseHooks). Server-owned: `input: false` keeps every API and
    // provider profile from setting it, and `returned: false` keeps it out of
    // responses (better-auth.com/docs/concepts/database, additionalFields).
    // Nullable, so the boot migration adds the column to a populated table
    // without a backfill (docs/operations/better-auth-migrations.md).
    user: {
      additionalFields: {
        lastActiveOrganizationId: { type: 'string', required: false, input: false, returned: false },
      },
    },

    emailAndPassword: {
      enabled: true,
      disableSignUp: !signUpEnabled,
      // Attached only when a transport exists — see the note in mailer.ts on
      // why a no-op sender is worse than no sender.
      ...(mailConfigured
        ? {
            sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
              await sendMail({
                to: user.email,
                subject: `Reset your ${appName} password`,
                text: `Reset your password: ${url}\n\nIf you did not request this, ignore this email.`,
                html: basicHtml(
                  `Reset your ${appName} password`,
                  'If you did not request this, you can ignore this email.',
                  url,
                  'Reset password',
                ),
              });
            },
          }
        : {}),
    },

    ...(mailConfigured
      ? {
          emailVerification: {
            sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
              await sendMail({
                to: user.email,
                subject: `Verify your ${appName} email`,
                text: `Verify your email address: ${url}`,
                html: basicHtml(
                  `Verify your ${appName} email`,
                  'Confirm this address to finish setting up your account.',
                  url,
                  'Verify email',
                ),
              });
            },
          },
        }
      : {}),

    // Which org a new session acts under. Nothing sets activeOrganizationId at
    // sign-in, so the provider falls back to the user's OLDEST membership
    // (@mastra/auth-better-auth dist/index.js:546-553). For an invitee that is
    // the personal org the Factory created on their first visit, not the team
    // they were invited into, so they would sign in to an empty org.
    //
    // A new session opens in the org the user last acted in: every change of
    // a session's active org (the team page's switcher, samskara-cai, or
    // accepting an invitation) is recorded on the user as
    // lastActiveOrganizationId, and read back here while the user is still a
    // member of it. Failing that (no record yet, or they left that org), the
    // most recently joined org.
    databaseHooks: {
      user: { update: clearSessionCache, delete: clearSessionCache },
      session: {
        update: {
          after: async (session: { userId?: string; activeOrganizationId?: string | null } | null) => {
            await clearSessionCache.after();
            // The updated row (with-hooks.mjs passes the adapter's result).
            // An unset org (set-active with null, or a refused one) is not a
            // choice to remember.
            if (!session?.userId || !session.activeOrganizationId) return;
            await client.execute({
              sql: 'UPDATE "user" SET "lastActiveOrganizationId" = ? WHERE "id" = ? AND ("lastActiveOrganizationId" IS NULL OR "lastActiveOrganizationId" != ?)',
              args: [session.activeOrganizationId, session.userId, session.activeOrganizationId],
            });
          },
        },
        delete: clearSessionCache,
        create: {
          before: async (session: { userId: string; activeOrganizationId?: string | null }) => {
            if (session.activeOrganizationId) return;
            const last = await client.execute({
              sql: 'SELECT u."lastActiveOrganizationId" AS "organizationId" FROM "user" u JOIN "member" m ON m."organizationId" = u."lastActiveOrganizationId" AND m."userId" = u."id" WHERE u."id" = ?',
              args: [session.userId],
            });
            const newest = last.rows.length
              ? last
              : await client.execute({
                  sql: 'SELECT "organizationId" FROM "member" WHERE "userId" = ? ORDER BY "createdAt" DESC LIMIT 1',
                  args: [session.userId],
                });
            const organizationId = newest.rows[0]?.organizationId;
            if (typeof organizationId !== 'string') return;
            return { data: { ...session, activeOrganizationId: organizationId } };
          },
        },
      },
    },

    plugins: [
      organization({
        ...(mailConfigured
          ? {
              sendInvitationEmail: async (data: {
                id: string;
                email: string;
                organization: { name: string };
                inviter: { user: { email: string; name?: string | null } };
              }) => {
                // Better Auth does not hand the callback a URL for invitations
                // — only the invitation id — so the accept link is ours to
                // build. It opens the page in src/mastra/team/routes.ts.
                const url = `${linkBase}${invitationPath(data.id)}`;
                const who = data.inviter.user.name?.trim() || data.inviter.user.email;
                // Both names are user-controlled (sign-up name, org name), so
                // they are escaped before they go into HTML.
                const org = escapeHtml(data.organization.name);
                // A signed-out invitee is sent to the Factory's /signin page,
                // which opens in sign-in mode; an invitee with no account who
                // signs in there gets "Invalid email or password"
                // (samskara-zkd). Our invitation page cannot greet them first:
                // the Factory auth gate redirects every signed-out /web/
                // request before any route runs (@mastra/factory
                // dist/auth.js createFactoryAuthGate). So the email says it.
                // "New here? Sign up" is the Factory UI's own label.
                const newHere = `New to ${appName}? The link opens a sign-in page. Choose "New here? Sign up" and create your account with this email address, ${data.email}. You come back to the invitation afterwards.`;
                await sendMail({
                  to: data.email,
                  subject: `${who} invited you to ${data.organization.name} on ${appName}`,
                  text: `${who} invited you to join ${data.organization.name}.\n\nAccept: ${url}\n\n${newHere}`,
                  html: basicHtml(
                    `Join ${org}`,
                    `${escapeHtml(who)} invited you to join <strong>${org}</strong> on ${appName}.<br><br>${escapeHtml(newHere)}`,
                    url,
                    'Accept invitation',
                  ),
                });
              },
            }
          : {}),
      }),
    ],

    advanced: {
      // Better Auth awaits the mail callbacks unless a background handler is
      // configured: `runInBackgroundOrAwait` only defers when
      // `advanced.backgroundTasks.handler` exists, and otherwise falls through
      // to `await promise` (context/create-context.mjs:215-225).
      //
      // Awaiting is an account-enumeration oracle. `/request-password-reset`
      // deliberately returns the same body whether or not the address is
      // known, but if the response waits on Resend it is measurably slower for
      // an address that exists. Better Auth's own docs call this out: "Avoid
      // awaiting the email sending to prevent timing attacks."
      //
      // Their examples are Vercel `waitUntil` and Cloudflare `ctx.waitUntil`.
      // This is a long-running Node process, so there is no platform primitive
      // to hand off to — letting the promise run detached is the equivalent.
      // The catch is required: an unhandled rejection here would take the
      // process down.
      backgroundTasks: {
        handler: (promise: Promise<unknown>) => {
          void promise.catch((err: unknown) => {
            console.error('[mail] background send failed:', err instanceof Error ? err.message : err);
          });
        },
      },
      ...(crossSite ? { defaultCookieAttributes: { sameSite: 'none' as const, secure: true } } : {}),
    },
  };

  await ensureAuthSchema(authOptions);
  return betterAuth(authOptions);
}
