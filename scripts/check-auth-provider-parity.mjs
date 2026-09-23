/**
 * Fail CI when `@mastra/auth-better-auth`'s `init()` changes.
 *
 * WHY THIS EXISTS. Samskara passes the provider its own `betterAuth()`
 * instance so the organization plugin can carry `sendInvitationEmail`. That
 * makes the provider's `init()` return early (dist/index.js:477), so every
 * option it would have set — database shape, basePath, baseURL,
 * trustedOrigins, emailAndPassword, the organization() plugin, cross-site
 * cookie attributes — is ours to set in src/mastra/auth/better-auth.ts.
 *
 * If a provider upgrade changes that function, our copy silently goes stale.
 * A comment asking people to keep the two in sync does not fire. Hashing the
 * function does.
 *
 * WHY CI AND NOT BOOT. The provider version can only change when someone runs
 * npm install, so this is a development-time problem. Throwing at boot would
 * risk taking a deployment down over an upstream refactor that changed
 * nothing we depend on. CI runs on every pull request and every push to main,
 * which is where a dependency bump actually arrives.
 *
 * Run: npm run check:auth-parity
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

/**
 * sha256 (first 16 hex) of `MastraAuthBetterAuth.prototype.init.toString()`
 * for the pinned provider version.
 *
 * Update this ONLY after reading the new init() and mirroring anything new
 * into buildBetterAuth(). Bumping the constant without doing that diff defeats
 * the entire mechanism.
 *
 * Recorded 2026-09-22 against @mastra/auth-better-auth 1.1.5.
 */
const KNOWN_INIT_SHA256 = '176ca9f3ce70246a';
const KNOWN_PROVIDER_VERSION = '1.1.5';

const require = createRequire(import.meta.url);
const installedVersion = require('@mastra/auth-better-auth/package.json').version;

const { MastraAuthBetterAuth } = await import('@mastra/auth-better-auth');
const actual = createHash('sha256')
  .update(MastraAuthBetterAuth.prototype.init.toString())
  .digest('hex')
  .slice(0, 16);

if (actual === KNOWN_INIT_SHA256) {
  console.log(`auth provider parity ok — @mastra/auth-better-auth ${installedVersion}, init() ${actual}`);
  process.exit(0);
}

console.error(
  [
    `@mastra/auth-better-auth init() has changed.`,
    ``,
    `  expected ${KNOWN_INIT_SHA256}  (recorded against ${KNOWN_PROVIDER_VERSION})`,
    `  actual   ${actual}  (installed ${installedVersion})`,
    ``,
    `This deployment passes its own betterAuth() instance, so that function no longer`,
    `runs — every option it sets is ours to set in src/mastra/auth/better-auth.ts.`,
    `A change there can leave our instance out of step with what the factory expects.`,
    ``,
    `To clear this:`,
    `  1. Print the new init():`,
    `     node -e "import('@mastra/auth-better-auth').then(m => console.log(m.MastraAuthBetterAuth.prototype.init.toString()))"`,
    `  2. Diff it against buildBetterAuth() and mirror anything new. THIS IS THE STEP THAT MATTERS.`,
    `  3. Update KNOWN_INIT_SHA256 and KNOWN_PROVIDER_VERSION in this file.`,
    ``,
    `See docs/operations/better-auth-migrations.md.`,
  ].join('\n'),
);
process.exit(1);
