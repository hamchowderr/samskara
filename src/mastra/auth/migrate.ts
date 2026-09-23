/**
 * Better Auth schema migrations — ours to run now.
 *
 * In deferred-instance mode the provider did this itself: `#ensureDbReady()`
 * called `getMigrations(...)` then `runMigrations()` behind a once-per-process
 * latch (@mastra/auth-better-auth/dist/index.js:508-519). Passing our own
 * `auth` instance turns that off — `#ensureDbReady()` returns immediately when
 * `!#ownsInstance` — so without this module the auth tables are never created
 * and a fresh clone signs nobody in.
 *
 * Neither Mastra CLI command covers this: `mastra migrate` migrates the Mastra
 * STORAGE schema, and `mastra auth` is Mastra Cloud login. Better Auth's own
 * `getMigrations` is the same entry point the provider used, so this is the
 * framework's migration path, not a hand-rolled one.
 *
 * Run at boot rather than as a separate step, which keeps the previous
 * behaviour exactly: the provider migrated unconditionally at first use, and
 * so do we. There is deliberately no opt-out knob — the behaviour this
 * replaces had none, nothing here needs one, and an untested escape hatch is
 * worse than no escape hatch.
 */
import type { BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';

/**
 * Create or update the Better Auth tables to match the configured schema.
 *
 * Throws rather than degrading. The Factory UI cannot load without auth
 * (`/web/factory/projects` is 401 and the SPA blocks on `/auth/me`), so a
 * half-migrated database is a broken deployment that should announce itself at
 * boot instead of at a client's first sign-in.
 *
 * Takes the options, not a built instance, so it can run BEFORE `betterAuth()`
 * — see buildBetterAuth() for why that order matters.
 */
export async function ensureAuthSchema(options: BetterAuthOptions): Promise<void> {
  const plan = await getMigrations(options, { throwOnUnsafe: false });

  if (plan.schemaProblems.length) {
    throw new Error(
      'Better Auth schema problems, refusing to start:\n  ' + plan.schemaProblems.join('\n  '),
    );
  }

  if (plan.unsafeChanges.length) {
    // A required column with no default cannot be added to a populated table:
    // the existing rows have nothing to backfill with. That needs a human
    // decision (a default, a nullable column, or a data migration).
    throw new Error(
      'Better Auth needs a change that cannot be applied safely to existing rows:\n  ' +
        plan.unsafeChanges.join('\n  ') +
        '\nSee docs/operations/better-auth-migrations.md.',
    );
  }

  const created = plan.toBeCreated.map(t => t.table);
  const altered = plan.toBeAdded.map(t => `${t.table}(+${Object.keys(t.fields).join(', ')})`);
  const indexes = plan.toBeAddedIndexes.map(i => `${i.table}.${i.name}`);

  if (!created.length && !altered.length && !indexes.length) {
    console.log('[auth] schema current — no migration needed.');
    return;
  }

  console.log(
    '[auth] applying Better Auth migrations:' +
      (created.length ? `\n  create tables: ${created.join(', ')}` : '') +
      (altered.length ? `\n  add columns:   ${altered.join(', ')}` : '') +
      (indexes.length ? `\n  add indexes:   ${indexes.join(', ')}` : ''),
  );

  await plan.runMigrations();
  console.log('[auth] migrations applied.');
}
