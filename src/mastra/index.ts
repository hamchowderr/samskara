/**
 * Platform-deployable Mastra entry for MastraCode.
 *
 * This module is the ONE place deployment env is read. It maps today's env
 * vars onto explicit `MastraFactory` config — instances for behaviors (pubsub,
 * storage, vector), plain values for config (publicUrl, origins) — so anyone
 * reading the entry sees exactly which env var feeds which slot.
 * Everything else (feature readiness, route/middleware assembly, controller
 * construction) lives in `MastraFactory` (`@mastra/factory`).
 *
 * `mastra build` requires the entry to export a `Mastra` instance named
 * `mastra` constructed by a literal `new Mastra(...)` in THIS file (validated
 * by the deployer's `checkConfigExport` Babel plugin) — which is why the
 * factory returns constructor args from `prepare()` instead of the instance.
 * The Mastra CLI consumes this entry everywhere: `mastra dev`, `mastra build`,
 * and `mastra deploy` all bundle this module and let the deployer generate
 * the server.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLFactoryStorage, LibSQLVector } from '@mastra/libsql';
import { LocalSandbox, detectIsolation, getRecommendedIsolation } from '@mastra/core/workspace';
import { PlatformSandbox, createRepoTemplate as createPlatformRepoTemplate } from '@mastra/platform-workspace';
import { E2BSandbox, createRepoTemplate as createE2BRepoTemplate } from '@mastra/e2b';
import { RedisStreamsPubSub } from '@mastra/redis-streams';
import { getDatabasePath } from '@mastra/code-sdk/utils/project';
import { DEFAULT_RETENTION } from '@mastra/code-sdk/utils/storage-maintenance';
import { MastraAuthWorkos } from '@mastra/auth-workos';
import { MastraAuthBetterAuth } from '@mastra/auth-better-auth';

import { keepOutboundConnectionsAlive } from './keep-alive';
import { buildBetterAuth } from './auth/better-auth';
import { SessionCache } from './auth/session-cache';
import { mailConfigured } from './auth/mailer';
import { createFactoryRouteAuth, createFactorySecretEncryption, MastraFactory, reviewBoard } from '@mastra/factory';
import { GithubIntegration } from '@mastra/factory/integrations/github/integration';
import { parseAuthorizedBotsEnv } from '@mastra/factory/integrations/github/webhook';
import { LinearIntegration } from '@mastra/factory/integrations/linear/integration';
import { SlackIntegration } from '@mastra/factory/integrations/slack/integration';
import type { IMastraAuthProvider } from '@mastra/core/server';
import { requestsBoard } from './boards/requests-board';
import { BeadsIntegration, beadsSetting, beadsStartupLine } from '@samskara/factory-beads';
import { createTeamRoutes } from './team/routes';

/**
 * Parse a positive-integer env knob; anything else means "use the default".
 * Fractional values are rejected rather than floored — flooring `0.5` to `0`
 * would silently disable a capacity knob or turn an idle window into
 * immediate expiry.
 */
function positiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function decodeCredentialEncryptionKey(name: string, encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, 'base64');
  if (key.byteLength !== 32) throw new Error(`${name} must contain base64-encoded 32-byte keys.`);
  return key;
}

function credentialEncryption() {
  const encodedKey = process.env.FACTORY_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!encodedKey) {
    console.warn(
      '[factory] FACTORY_CREDENTIAL_ENCRYPTION_KEY is not set. Stored model-provider keys, custom-provider ' +
        'API keys, and integration secrets will be persisted as plaintext. Generate a key with ' +
        '`openssl rand -base64 32` and set FACTORY_CREDENTIAL_ENCRYPTION_KEY to encrypt them at rest.',
    );
    return undefined;
  }

  const previousKeys: Record<string, unknown> = process.env.FACTORY_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS
    ? JSON.parse(process.env.FACTORY_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS)
    : {};
  if (!previousKeys || Array.isArray(previousKeys) || typeof previousKeys !== 'object') {
    throw new Error('FACTORY_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS must be a JSON object of key ids to base64 keys.');
  }

  return createFactorySecretEncryption({
    primary: {
      id: process.env.FACTORY_CREDENTIAL_ENCRYPTION_KEY_ID?.trim() || 'v1',
      key: decodeCredentialEncryptionKey('FACTORY_CREDENTIAL_ENCRYPTION_KEY', encodedKey),
    },
    previous: Object.entries(previousKeys).map(([id, value]) => {
      if (typeof value !== 'string') {
        throw new Error('FACTORY_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS values must be base64 strings.');
      }
      return { id, key: decodeCredentialEncryptionKey('FACTORY_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS', value) };
    }),
  });
}

// Before any client is created: Turso queries otherwise reconnect after 4s
// idle, which made each request's auth gate take 1-2.5s (samskara-lx1).
keepOutboundConnectionsAlive();

// Distributed pub/sub: when `REDIS_URL` is set, events (streams, workflows,
// signals) ride Redis Streams so multiple web server processes can share one
// event bus. RedisStreamsPubSub also implements LeaseProvider, so the factory
// marks it cross-process and the controller drops its file-based thread locks
// in favor of pubsub-coordinated leases. Without `REDIS_URL` (bare local dev)
// the in-process default applies.
const redisUrl = process.env.REDIS_URL;
const pubsub = redisUrl ? new RedisStreamsPubSub({ url: redisUrl }) : undefined;
if (redisUrl) {
  // Redact credentials before logging (REDIS_URL may embed a password).
  let redisTarget = 'redis';
  try {
    const parsed = new URL(redisUrl);
    redisTarget = `${parsed.protocol}//${parsed.host}`;
  } catch {
    // Unparseable URL — RedisStreamsPubSub will surface the real error; keep the log generic.
  }
  console.log(`[PubSub] REDIS_URL set — event bus on Redis Streams (${redisTarget}), cross-process leases enabled.`);
}

// Auth selection, ordered by how explicit the operator's intent is:
//   1. MASTRACODE_AUTH_DISABLED=1 — explicit opt-out, auth off entirely.
//   2. MASTRA_SHARED_API_URL — explicit platform deferral; identity rides the
//      shared platform API (`.env.schema` names this the highest-precedence
//      auth config), so it wins even over a configured WORKOS_* pair — but
//      loudly, because silently ignoring sign-in config is how self-hosted
//      logins end up 302-ing somewhere that rejects their redirect_uri.
//   3. WORKOS_API_KEY + WORKOS_CLIENT_ID — self-managed WorkOS sign-in. The
//      constructor reads the rest of the WORKOS_* group from env, and
//      `init()` derives the /auth/callback redirect from the deployment's
//      publicUrl when WORKOS_REDIRECT_URI is unset. `fetchMemberships` lets
//      token auth resolve the user's organization so the bootstrapped
//      personal org works without re-auth. Note MASTRA_PLATFORM_ACCESS_TOKEN /
//      MASTRA_PLATFORM_SECRET_KEY do NOT defer to the platform here: they are
//      compute/integration credentials (sandboxes, GitHub/Linear slots), not
//      identity signals — platform compute plus self-managed sign-in is a
//      supported combination.
//   4. BETTER_AUTH_SECRET — self-hosted sign-in with no third-party identity
//      provider. NOT deferred-instance mode: we hand the provider our own
//      `betterAuth()` (src/mastra/auth/better-auth.ts) because the deferred
//      path calls `organization()` with no options, which makes invite email
//      impossible. The trade is that we own the schema migrations, the
//      database handle, baseURL, trustedOrigins and cookie attributes — so
//      this branch is wired AFTER storage, not here. Ranked below WorkOS so an
//      explicitly configured WORKOS_* pair still wins.
//   5. Nothing configured — leave undefined and MastraFactory installs its
//      platform-backed default provider.
const authDisabled = process.env.MASTRACODE_AUTH_DISABLED === '1';
const workosConfigured = Boolean(process.env.WORKOS_API_KEY?.trim() && process.env.WORKOS_CLIENT_ID?.trim());
const betterAuthSecret = process.env.BETTER_AUTH_SECRET?.trim();
let auth: IMastraAuthProvider | null | undefined;
let betterAuthSelected = false;

if (authDisabled) {
  auth = null;
} else if (process.env.MASTRA_SHARED_API_URL?.trim()) {
  if (workosConfigured) {
    console.warn(
      '[Auth] WORKOS_API_KEY/WORKOS_CLIENT_ID are set but ignored: MASTRA_SHARED_API_URL takes precedence, so sign-in defers to the platform. Unset MASTRA_SHARED_API_URL to use self-managed WorkOS auth.',
    );
  }
} else if (workosConfigured) {
  auth = new MastraAuthWorkos({ fetchMemberships: true });
} else if (betterAuthSecret) {
  // Samskara runs fully self-hosted: no WorkOS tenant, no platform identity.
  // Auth cannot simply be turned off instead — with MASTRACODE_AUTH_DISABLED=1
  // the agent runtime works but the Factory surface does not:
  // /web/factory/projects returns 401 and resolveTenant rejects a tenant with
  // no organization as 403 organization_required. A real login is what
  // bootstraps the personal organization the board needs.
  // Constructed AFTER storage, below: we pass our OWN betterAuth() instance so
  // the organization plugin can carry sendInvitationEmail, and that needs the
  // host's libSQL client. See src/mastra/auth/better-auth.ts for what owning
  // the instance costs us (migrations, baseURL, trustedOrigins, cookies).
  betterAuthSelected = true;
}
// Direct GitHub App fallback: when the platform-backed integration isn't in
// play (self-hosted / local deploys), a complete GITHUB_APP_* env group wires
// a GithubIntegration so the app still gets a real GitHub connection — Connect
// GitHub in onboarding, the repo picker, and webhooks. A partial group stays
// disabled so the status route can report exactly what's missing.
const githubAppId = process.env.GITHUB_APP_ID?.trim();
const githubPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
const githubClientId = process.env.GITHUB_APP_CLIENT_ID?.trim();
const githubClientSecret = process.env.GITHUB_APP_CLIENT_SECRET?.trim();
const githubAppSlug = process.env.GITHUB_APP_SLUG?.trim();
const github =
  githubAppId && githubPrivateKey && githubClientId && githubClientSecret && githubAppSlug
    ? new GithubIntegration({
        appId: githubAppId,
        privateKey: githubPrivateKey,
        clientId: githubClientId,
        clientSecret: githubClientSecret,
        slug: githubAppSlug,
        webhookSecret: process.env.GITHUB_APP_WEBHOOK_SECRET?.trim() || undefined,
        // Extra reviewer bot logins this deployment trusts to trigger
        // review/comment notifications, on top of the built-in defaults.
        authorizedBots: parseAuthorizedBotsEnv(process.env.MASTRACODE_GITHUB_AUTHORIZED_BOTS),
      })
    : undefined;

// Direct Linear OAuth fallback for self-hosted / local deploys. As with the
// GitHub fallback, only a complete credential group enables the integration;
// partial configuration remains available to the diagnostics routes.
const linearClientId = process.env.LINEAR_CLIENT_ID?.trim();
const linearClientSecret = process.env.LINEAR_CLIENT_SECRET?.trim();
const linear =
  linearClientId && linearClientSecret
    ? new LinearIntegration({
        clientId: linearClientId,
        clientSecret: linearClientSecret,
      })
    : undefined;

// Host env exposed to the local sandbox: an ALLOW-LIST, so app secrets
// (GITHUB_APP_PRIVATE_KEY, BETTER_AUTH_SECRET, TURSO_AUTH_TOKEN, E2B_API_KEY, …)
// never leak into commands run against a repo checkout. PATH is added by the
// core LocalSandbox itself; these keep git, TLS and the shell working.
//
// Both POSIX and Windows names are listed because Samskara is meant to be
// self-hostable on any OS the Mastra sandbox supports. Absent names are simply
// skipped, so carrying both sets costs nothing on either platform — whereas the
// POSIX-only list the scaffold shipped left a Windows checkout with no HOME, no
// TEMP and no COMSPEC, which breaks git and any shell-invoking command.
const LOCAL_SANDBOX_ENV_KEYS = [
  // POSIX
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  // Windows
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  // Locale, terminal and TLS — same names everywhere
  'LANG',
  'LC_ALL',
  'TERM',
  'TZ',
  'GIT_EXEC_PATH',
  'GIT_TEMPLATE_DIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;

function localSandboxEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of LOCAL_SANDBOX_ENV_KEYS) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

/** Where local sandbox checkouts live. homedir() is correct on every platform. */
function localSandboxRoot(): string {
  return (
    process.env.MASTRACODE_LOCAL_SANDBOX_ROOT?.trim() ||
    join(homedir(), '.mastracode', 'web', 'sandboxes')
  );
}

// One libSQL database powers agent storage, the factory app tables, the
// distributed project lock, and better-auth — plus its own vector index for
// recall search. There is exactly ONE adapter for every environment; local dev
// and production differ only by URL:
//
//   TURSO_DATABASE_URL unset -> file:<getDatabasePath()>   (local development)
//   TURSO_DATABASE_URL set   -> libsql://<db>.turso.io     (production)
//
// Postgres/PgVector are deliberately NOT wired. libSQL covers all 24 storage
// domains and ships LibSQLVector, so Postgres buys nothing here — and a
// DATABASE_URL-triggered branch is an active hazard, because most deploy
// platforms inject DATABASE_URL automatically. That would silently repoint the
// whole factory at an empty Postgres and strand every row living in Turso.
const tursoUrl = process.env.TURSO_DATABASE_URL?.trim() || undefined;
const tursoAuthToken = process.env.TURSO_AUTH_TOKEN?.trim() || undefined;

if (process.env.DATABASE_URL?.trim() || process.env.APP_DATABASE_URL?.trim()) {
  console.warn(
    '[storage] DATABASE_URL is set but IGNORED — Samskara runs on libSQL/Turso only. ' +
      'Set TURSO_DATABASE_URL to point at a remote database.',
  );
}

// No NODE_ENV gate here, deliberately. An earlier version threw unless
// NODE_ENV was development/test, which broke every BUILT deployment: the
// bundler folds process.env.NODE_ENV at build time, so `!localDevelopmentMode`
// compiled down to the literal `true` and the throw fired unconditionally —
// runtime NODE_ENV could not switch it back off. Anyone self-hosting Samskara
// from a build was then forced to own a Turso account just to boot.
//
// Running on a local file is a legitimate deployment (one machine, one
// operator), so it warns rather than throws. Serving clients from it is not,
// and the warning says so — a cloud deploy that forgets TURSO_DATABASE_URL is
// loud in the logs on every boot instead of silently correct-looking.
if (!tursoUrl) {
  console.warn(
    '[storage] No TURSO_DATABASE_URL — using a local libSQL file. Fine for self-hosting ' +
      'on one machine; it does NOT survive a container restart and cannot be shared across ' +
      'replicas, so never serve clients this way. Set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN ' +
      'for a hosted database.',
  );
}
// A remote Turso database always requires a token; failing here beats failing
// on the first query with an opaque authorization error.
if (tursoUrl && tursoUrl.startsWith('libsql://') && !tursoAuthToken) {
  throw new Error('TURSO_AUTH_TOKEN is required when TURSO_DATABASE_URL points at a remote libsql:// database.');
}

const databaseUrl = tursoUrl ?? `file:${getDatabasePath()}`;

const storage = new LibSQLFactoryStorage({
  id: 'mastra-code-storage',
  url: databaseUrl,
  authToken: tursoAuthToken,
  retention: DEFAULT_RETENTION,
});

// Self-hosted sign-in, wired here rather than at the selection above because a
// bring-your-own Better Auth instance needs the host's auth database — the same
// handle the factory would have passed to `init()` (factory.js:270), which a
// BYO instance never receives.
if (betterAuthSelected && betterAuthSecret) {
  // Owning the instance means owning its schema: the provider only migrates
  // instances it built itself (dist/index.js:509). buildBetterAuth() migrates
  // before constructing, so a fresh clone gets its auth tables.
  // The gate authenticates every request; this keeps most of them off the
  // database (samskara-lx1). Per container: see auth/session-cache.ts.
  const sessionCache = new SessionCache();
  const betterAuthInstance = await buildBetterAuth({
    sessionCache,
    secret: betterAuthSecret,
    database: storage.authDatabase(),
    publicUrl: process.env.MASTRACODE_PUBLIC_URL?.trim().replace(/\/+$/, ''),
    allowedOrigins: (process.env.MASTRACODE_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map(o => o.trim())
      .filter(Boolean),
  });
  auth = new MastraAuthBetterAuth({ auth: sessionCache.wrap(betterAuthInstance) });
}

// Which auth provider actually resolved. Worth a permanent boot line: when auth
// resolves to null the factory skips buildAuthRoutes (factory.js:497), so every
// /auth/* route — including the /auth/me the SPA blocks on — falls through to
// the HTML catch-all and the UI hangs on an infinite loader with no error
// anywhere. `mastra factory dev` injects MASTRACODE_AUTH_DISABLED=1 unless it
// is already set, which is why the dev script pins it to 0.
console.log(
  '[auth] provider=' +
    (auth === null ? 'DISABLED (Factory UI will not load)' : auth ? auth.constructor.name : 'platform-default'),
);

// Landing on the platform default is almost never what this deployment wants.
// Samskara is self-hosted: the default provider authenticates against
// platform.mastra.ai, so sign-in cannot work against the local database. The
// server otherwise reports itself healthy, which is how a clone ends up with a
// login that silently cannot succeed — so say it plainly rather than printing
// the provider name and moving on.
if (auth === undefined && !authDisabled) {
  console.warn(
    '[auth] NO AUTH PROVIDER CONFIGURED — falling back to the platform default, which authenticates ' +
      'against platform.mastra.ai. Sign-in will NOT work against this local database.\n' +
      '       Set one of: BETTER_AUTH_SECRET (self-hosted sign-in), WORKOS_API_KEY + WORKOS_CLIENT_ID, ' +
      'or MASTRA_SHARED_API_URL (defer to the platform).\n' +
      '       `npm run dev` generates a development BETTER_AUTH_SECRET for you; `npm run dev:secure` ' +
      'injects the real one from Infisical.',
  );
}

// Mail is not optional for a real deployment: with no transport, Better Auth
// declines to mount password reset at all and an invited teammate is never
// notified. Loud on every boot rather than discovered by a locked-out client.
if (betterAuthSelected) {
  console.log(
    mailConfigured
      ? '[mail] Resend configured — password reset, email verification and invitations will send.'
      : '[mail] NO TRANSPORT (set RESEND_API_KEY + MAIL_FROM): password reset is not mounted, ' +
          'verification cannot complete, and invitations write a row that notifies nobody.',
  );
}

const secretEncryption = auth === null ? undefined : credentialEncryption();
// Recall search needs an EXPLICIT vector store here. The factory's `vector`
// option is documented as falling back to "the SDK mount's default vector
// store resolution", but that fallback cannot fire for us: the mount computes
// `storageConfig = injectedStorage ? undefined : …` and only builds a default
// vector when `storageConfig` is set (code-sdk/dist/index.js:270,322). The
// factory ALWAYS injects a storage instance, so omitting `vector` — as the
// generated scaffold did on the libSQL path — leaves recall search with no
// vector store at all.
//
// Embeddings live in their OWN database, matching the SDK's own default
// (`getVectorDatabasePath()`: "Separate from the main DB to avoid bloating it
// with embedding data"). On Turso that also keeps embedding rows off the
// primary database's quota. Point TURSO_VECTOR_DATABASE_URL at a second Turso
// database to split them in production; left unset with Turso configured, both
// share one database and the boot log says so.
// The local vector file must sit BESIDE our app database, never at the SDK's
// `getVectorDatabasePath()`. That helper is hardcoded to
// <appdata>/mastracode/mastra-vectors.db with NO env override (unlike
// getDatabasePath(), which honors MASTRA_DB_PATH) — so it resolves to the
// mastracode CLI's own shared vector database. Pointing Samskara there mixes
// our embeddings into the CLI's store and reintroduces the SQLITE_BUSY
// collision MASTRA_DB_PATH exists to prevent.
const localVectorPath = getDatabasePath().replace(/.db$/i, '') + '-vectors.db';
const vectorUrl =
  process.env.TURSO_VECTOR_DATABASE_URL?.trim() || tursoUrl || `file:${localVectorPath}`;
const vectorAuthToken = process.env.TURSO_VECTOR_AUTH_TOKEN?.trim() || (vectorUrl === tursoUrl ? tursoAuthToken : undefined);

if (vectorUrl.startsWith('libsql://') && !vectorAuthToken) {
  throw new Error('TURSO_VECTOR_AUTH_TOKEN is required when TURSO_VECTOR_DATABASE_URL points at a remote libsql:// database.');
}

const vector = new LibSQLVector({
  id: 'mastra-code-vectors',
  url: vectorUrl,
  authToken: vectorAuthToken,
});

// Which databases are actually live. Hosts only — never a token, and never the
// credential-bearing query string a Turso url can carry.
const describe = (url: string) => (url.startsWith('file:') ? 'local file' : `turso remote (${new URL(url).host})`);
console.log(`[storage] app=${describe(databaseUrl)} vectors=${describe(vectorUrl)}` + (vectorUrl === databaseUrl ? ' (shared)' : ''));

// Deployment-stable secret for OAuth/link `state` signing. Shared by the
// factory's integration signer and the channel-account-link deep link so both
// sign/verify with the same key: webhook secret first, then the WorkOS cookie
// password, then the Slack signing secret so a Slack-only deployment still has
// a stable signer. Unset → per-process random secret (single-process local dev
// only).
const stateSecret =
  process.env.GITHUB_APP_WEBHOOK_SECRET ||
  process.env.WORKOS_COOKIE_PASSWORD ||
  process.env.SLACK_APP_SIGNING_SECRET ||
  undefined;

// Slack channels + account linking. Optional: the Slack adapter validates the
// signing secret at construction, so the integration is only built when the
// Slack app env is configured. Repo-backed Slack threads come from the
// factory's source-control owner (GitHub) — the integration wires itself.
const slackSigningSecret = process.env.SLACK_APP_SIGNING_SECRET?.trim();
const slack = slackSigningSecret
  ? new SlackIntegration({
      signingSecret: slackSigningSecret,
      botToken: process.env.SLACK_APP_BOT_TOKEN,
      clientId: process.env.SLACK_APP_CLIENT_ID?.trim(),
      clientSecret: process.env.SLACK_APP_CLIENT_SECRET?.trim(),
      // Slack requires an HTTPS redirect_uri, which locally is the tunnel
      // origin rather than the app's own public URL.
      oidcRedirectBaseUrl: process.env.MASTRACODE_CHANNELS_PUBLIC_URL ?? process.env.MASTRACODE_PUBLIC_URL,
      uiOrigin: process.env.MASTRACODE_PUBLIC_URL,
    })
  : undefined;

// Beads intake and write-back (samskara-iz6): ready beads in each linked repo
// become Work cards; a card reaching Done closes its bead and publishes it to
// refs/dolt/data. ON by default; BEADS_INTEGRATION=0 (or false/off/no) turns it
// off (samskara-iz6.8). It needs the GitHub App, whose installation tokens read
// and write each repository: without it, one startup line and nothing runs. The
// host needs the `bd` binary (the Docker image installs a pinned one); a
// missing bd is logged once at the first sweep and the integration idles. A
// linked repository with no refs/dolt/data on origin is reported as
// 'no-beads-data', not as an error. Single writer: with more than one server
// process, REDIS_URL must be set so the writer lease is shared. See
// docs/operations/beads.md.
const beadsSwitch = beadsSetting(process.env.BEADS_INTEGRATION);
const beadsLine = beadsStartupLine(beadsSwitch, Boolean(github));
if (beadsSwitch.enabled && !github) console.warn(beadsLine);
else console.log(beadsLine);
const beads =
  beadsSwitch.enabled && github
    ? new BeadsIntegration({
        sourceControl: github,
        // From the board definition, so a board change follows.
        board: requestsBoard.id,
        pollIntervalMs: positiveInt(process.env.BEADS_POLL_INTERVAL_MS),
        cacheDir: process.env.BEADS_CACHE_DIR?.trim() || undefined,
        bdPath: process.env.BEADS_BD_PATH?.trim() || undefined,
      })
    : undefined;

const integrations = [
  ...(github ? [github] : []),
  ...(linear ? [linear] : []),
  ...(slack ? [slack] : []),
  ...(beads ? [beads] : []),
];

// Which integrations actually constructed. Each is built only from a COMPLETE
// credential group — a partial group stays undefined and the surface it powers
// silently does not exist (GitHub missing also means no board renders, because
// the UI gates every board on a linked repository).
console.log(
  '[integrations] ' +
    (integrations.length
      ? [github ? 'github' : null, linear ? 'linear' : null, slack ? 'slack' : null, beads ? 'beads' : null]
          .filter(Boolean)
          .join(', ')
      : 'NONE configured'),
);

// ---------------------------------------------------------------------------
// TEMPORARY: survive an upstream crash in @mastra/core's execute_command tool.
// Delete this whole block once https://github.com/mastra-ai/mastra/issues/24346
// is fixed and we are on a release that contains the fix.
//
// The tool accumulates a command's stdout into one unbounded string
// (`stdout += data`). Past V8's maximum string length the concatenation throws
// RangeError: Invalid string length. That throw reaches us two ways, and both
// are fatal by default:
//
//   * unhandledRejection — `onStdout` is async and `emitStdout` never awaits it
//   * uncaughtException  — RetainedOutputBuffer.append -> compactIfNeeded ->
//                          toString throws synchronously from the socket handler
//
// Either one kills the process serving EVERY tenant, over a single agent run,
// on any sandbox provider (the accumulation happens in this process, not in the
// sandbox — E2B does not protect us). This converts that into one failed run.
//
// NOT a fix, and deliberately narrow: only the exact upstream RangeError raised
// from @mastra/core's workspace bundle is swallowed. Anything else keeps its
// default fatal behaviour, so real bugs still surface instead of being masked.
//
// Known gap: true heap exhaustion is NOT covered. V8 aborts the process on OOM
// without delivering anything to a JS handler, and the same duplication costs
// roughly 6-7x the command's output in memory (measured: 100 MB of output ->
// ~670 MB heap). A command large enough can still exhaust memory before it ever
// reaches the string-length limit.
const UPSTREAM_STDOUT_CRASH_ISSUE = 'https://github.com/mastra-ai/mastra/issues/24346';

function isUpstreamStdoutOverflow(err: unknown): err is Error {
  if (!(err instanceof RangeError)) return false;
  if (!/invalid string length/i.test(err.message)) return false;
  // Must originate in @mastra/core's workspace bundle — otherwise an unrelated
  // RangeError with the same message would be silently swallowed.
  return /workspace-[\w-]+\.(js|mjs|cjs)/.test(err.stack ?? '');
}

function reportSurvivedCrash(kind: string, err: Error): void {
  console.error(
    `[upstream-crash] Survived ${kind} from @mastra/core execute_command: ${err.message}\n` +
      `[upstream-crash] A command produced more output than one JS string can hold. That agent run ` +
      `is now in an undefined state, but the server stayed up.\n` +
      `[upstream-crash] Tracking: ${UPSTREAM_STDOUT_CRASH_ISSUE}\n` +
      (err.stack ?? ''),
  );
}

process.on('unhandledRejection', reason => {
  if (isUpstreamStdoutOverflow(reason)) {
    reportSurvivedCrash('unhandled rejection', reason);
    return;
  }
  // Restore Node's default: an unhandled rejection is fatal.
  throw reason;
});

process.on('uncaughtException', err => {
  if (isUpstreamStdoutOverflow(err)) {
    reportSurvivedCrash('uncaught exception', err);
    return;
  }
  // Restore Node's default: print and die, rather than limping on.
  console.error(err);
  process.exit(1);
});
// ---------------------------------------------------------------------------

export const factoryConfigVersion = 'mastracode-web-v1';

// Sandbox provider. Two supported shapes, and the choice is always EXPLICIT:
//
//   local    — runs agent commands directly on this machine. Correct for
//              someone self-hosting Samskara for their own use, on any OS. NOT
//              safe for multi-tenant serving: no isolation between a client's
//              code and the host, so a repo's own scripts run with this
//              process's privileges.
//   e2b      — runs every command in a per-session E2B microVM. What Samskara
//              serves clients with.
//   platform — runs on Mastra's managed platform workspace, for anyone hosting
//              this on Mastra rather than self-hosting the sandbox layer.
//
// All three stay supported: a self-hoster should be able to pick whichever they
// are set up for. What was removed is the scaffold's SILENT chaining
// (platform -> e2b -> local), which failed OPEN — a missing or misspelled
// E2B_API_KEY did not error, it quietly ran untrusted code on the host. The fix
// was never to delete options, only to stop substituting one provider for
// another behind your back. An explicit request that cannot be honored throws.
type SandboxProvider = 'local' | 'e2b' | 'platform';

const e2bApiKey = process.env.E2B_API_KEY?.trim();
const hasPlatformSandboxEnv =
  ['MASTRA_PLATFORM_ACCESS_TOKEN', 'MASTRA_PLATFORM_SECRET_KEY'].some(k => Boolean(process.env[k]?.trim())) &&
  ['MASTRA_ENVIRONMENT_ID', 'MASTRA_PROJECT_ID'].every(k => Boolean(process.env[k]?.trim()));

const SANDBOX_PROVIDERS: readonly SandboxProvider[] = ['local', 'e2b', 'platform'];
const requestedProvider = process.env.FACTORY_SANDBOX_PROVIDER?.trim().toLowerCase();

if (requestedProvider && !SANDBOX_PROVIDERS.includes(requestedProvider as SandboxProvider)) {
  throw new Error(
    `FACTORY_SANDBOX_PROVIDER must be one of ${SANDBOX_PROVIDERS.join(', ')} (got '${requestedProvider}').`,
  );
}

// Unset → whatever this machine is actually configured for, most isolated
// first. An EXPLICIT request is never downgraded; it throws instead.
const sandboxProvider: SandboxProvider =
  (requestedProvider as SandboxProvider | undefined) ??
  (hasPlatformSandboxEnv ? 'platform' : e2bApiKey ? 'e2b' : 'local');

if (sandboxProvider === 'e2b' && !e2bApiKey) {
  throw new Error(
    'FACTORY_SANDBOX_PROVIDER=e2b requires E2B_API_KEY. ' +
      'Refusing to start rather than falling back to running agent commands on this host.',
  );
}
if (sandboxProvider === 'platform' && !hasPlatformSandboxEnv) {
  throw new Error(
    'FACTORY_SANDBOX_PROVIDER=platform requires MASTRA_PLATFORM_ACCESS_TOKEN or ' +
      'MASTRA_PLATFORM_SECRET_KEY, plus MASTRA_ENVIRONMENT_ID and MASTRA_PROJECT_ID. ' +
      'Refusing to start rather than falling back to running agent commands on this host.',
  );
}

if (sandboxProvider === 'local') {
  console.warn(
    '[sandbox] provider=local — agent commands run DIRECTLY ON THIS MACHINE with this ' +
      "process's privileges. Fine for self-hosting your own work; never serve clients this way. " +
      'Set FACTORY_SANDBOX_PROVIDER=e2b with an E2B_API_KEY for isolated runs.',
  );
} else {
  console.log('[sandbox] provider=' + sandboxProvider);
}

// Resolved once: seatbelt on macOS, bwrap on Linux when installed, 'none'
// everywhere else (Windows has no backend at all —
// https://github.com/mastra-ai/mastra/issues/20304). Unconfined local runs are
// a real exposure, so say so at boot rather than leaving it to be discovered.
const localIsolation = getRecommendedIsolation();
if (sandboxProvider === 'local' && localIsolation === 'none') {
  console.warn(
    '[sandbox] isolation=none — ' +
      detectIsolation().message +
      ' Agent commands will run unconfined, with the privileges of this server process. ' +
      'Use FACTORY_SANDBOX_PROVIDER=e2b (or another cloud provider) for anything untrusted.',
  );
} else if (sandboxProvider === 'local') {
  console.log('[sandbox] isolation=' + localIsolation);
}
export const factory = new MastraFactory({
  auth,
  secretEncryption,
  integrations,
  configVersion: factoryConfigVersion,
  sandbox: ctx => {
    switch (sandboxProvider) {
      case 'platform':
        return new PlatformSandbox({ id: ctx.sessionId, template: createPlatformRepoTemplate(ctx) });
      case 'e2b':
        return new E2BSandbox({ id: ctx.sessionId, template: createE2BRepoTemplate(ctx) });
      case 'local':
        // LocalSandbox defaults to `isolation: 'none'`, which runs agent
        // commands unconfined on EVERY platform — including macOS and Linux,
        // where a backend is available. Ask the SDK for the best one it can
        // actually use instead of taking that default.
        return new LocalSandbox({
          workingDirectory: join(localSandboxRoot(), ctx.sessionId),
          env: localSandboxEnv(),
          isolation: localIsolation,
        });
    }
  },
  // Per-replica cap on concurrent Factory background dispatches. Unset means
  // the dispatcher default; invalid and non-positive values are ignored.
  dispatcher: {
    maxInFlight: positiveInt(process.env.MASTRACODE_DISPATCH_MAX_IN_FLIGHT),
  },
  // Agent state (threads, messages, memory, OM) and the factory app tables live
  // in the one libSQL `storage` built above — a local file, or Turso when
  // TURSO_DATABASE_URL is set — shared by all users and separated by
  // `resourceId` scoping. Recall vectors go to `vector` (see above).
  storage,
  vector,
  pubsub,
  platform: {
    // The deployment's own self-hosted App slug, when one is configured. It is
    // NOT Platform's identity: Platform posts as its own App, which names
    // itself. Reusing this value for that purpose left self-recognition
    // comparing against `undefined[bot]` on every Platform deployment, where
    // this is legitimately unset.
    githubAppSlug,
  },
  // Browser-facing origin. On the platform the SPA is hosted separately, so
  // this MUST be set to the public API origin.
  publicUrl: process.env.MASTRACODE_PUBLIC_URL,
  // Allowed cross-origin SPA origins (comma-separated). The SPA is served from
  // a separate static host, so credentialed requests must be explicitly allowed.
  allowedOrigins: (process.env.MASTRACODE_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean),
  // Deployment-stable secret for OAuth `state` signing (GitHub/Linear connect
  // flows). See `stateSecret` above.
  stateSecret,
  // Samskara's Work board. The built-in one declares no triage handler for
  // `manual`, so a chat- or Slack-submitted card reached Triage and got a
  // generic stage message instead of the triage skill. `requestsBoard` is
  // Work's own definition plus `manual` triage, installed under the id
  // `work` so it REPLACES the built-in (upstream #25595). Keeping the id means
  // every behaviour keyed to `work` — the default GitHub rules, submit_plan,
  // triage classification, Slack cards, the UI's Work page — applies to it with
  // no wrapper. `includeDefaultBoards: false` drops BOTH built-ins, so the
  // stock Review board is re-added explicitly.
  includeDefaultBoards: false,
  boards: [requestsBoard, reviewBoard],
});

const preparedArgs = await factory.prepare();

// Construct the server-owned Mastra HERE so the `new Mastra(...)` literal lives
// in the entry file (see module docs). `prepare()` returns the constructor args
// carrying the controller (via `agentControllers`), storage, and the assembled
// `server` config (middleware + apiRoutes + cors). Keep the worker-relevant
// properties explicit so deploy builds can statically detect the worker topology.
export const mastra = new Mastra({
  ...preparedArgs,
  // Samskara's team pages ride alongside the Factory's own routes, behind the
  // same auth gate middleware. See src/mastra/team/routes.ts.
  server: {
    ...preparedArgs.server,
    apiRoutes: [...(preparedArgs.server?.apiRoutes ?? []), ...createTeamRoutes(createFactoryRouteAuth(auth ?? undefined))],
  },
  storage: preparedArgs.storage,
  pubsub: preparedArgs.pubsub,
  workers: preparedArgs.workers,
});

// Post-construct boot: initialize the controller (which now inherits this
// instance's storage) and start its workers. Runs at module load via top-level
// await, so the deployer imports a fully-booted instance.
await factory.finalize();
