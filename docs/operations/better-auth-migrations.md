# Better Auth schema migrations

Samskara owns the Better Auth schema. This page explains why, what runs when,
and what to do when a migration is refused.

## Why we own it

`@mastra/auth-better-auth` has two modes.

**Deferred instance** — pass `secret` and the provider builds its own
`betterAuth()` in `init()`, then migrates it behind a once-per-process latch
(`#ensureDbReady`, `dist/index.js:508`). Nothing for the operator to do.

**Bring your own instance** — pass a pre-built `auth`. Samskara does this,
because the deferred path calls `organization()` with no options
(`dist/index.js:495`) and therefore cannot send invitation email. See
[mail.md](./mail.md).

The switch is not free. Both hooks bail out for an instance the provider did
not build:

```js
async init(ctx) { this.#crossSite = …; if (this.#auth) return; … }   // :477
async #ensureDbReady() { if (!this.#ownsInstance) return; … }        // :509
```

So from that point the deployment owns the schema, the database handle,
`baseURL`, `trustedOrigins` and the cross-site cookie attributes.
`src/mastra/auth/better-auth.ts` supplies all of them.

### Which side is authoritative

The provider's `init()` is the reference for everything the host-to-provider
contract depends on — the database shape, `basePath`, `baseURL`,
`trustedOrigins`, `emailAndPassword`, the `organization()` plugin, the
cross-site cookie attributes. The factory mounts the handler at `/auth/api` and
hands it origins and a database, and those have to agree. Our config is
authoritative **only** for what we deliberately add on top: the three mail
callbacks. Anywhere else the two disagree, the provider is right and
`better-auth.ts` is stale.

### How drift is caught

Not by asking people to remember. `scripts/check-auth-provider-parity.mjs`
hashes `MastraAuthBetterAuth.prototype.init.toString()` and compares it against
a recorded constant:

```bash
npm run check:auth-parity
# auth provider parity ok — @mastra/auth-better-auth 1.1.5, init() 176ca9f3ce70246a
```

CI runs it on every pull request and every push to `main`. The provider is
pinned exact, so it can only trip on a deliberate upgrade — exactly when
someone should re-read that function.

**It runs in CI, not at boot, on purpose.** The provider version can only
change when someone runs `npm install`, so this is a development-time problem.
Failing the boot over it would risk taking a deployment down for an upstream
refactor that changed nothing we depend on.

Clearing it is three steps, and step 2 is the one that matters:

1. Print the new `init()`:
   ```bash
   node -e "import('@mastra/auth-better-auth').then(m => console.log(m.MastraAuthBetterAuth.prototype.init.toString()))"
   ```
2. Diff it against `buildBetterAuth()` and mirror anything new.
3. Update `KNOWN_INIT_SHA256` and `KNOWN_PROVIDER_VERSION` in the script.

Updating the constant without doing step 2 defeats the entire mechanism.

Neither Mastra CLI command covers this. `mastra migrate` migrates the Mastra
**storage** schema; `mastra auth` is Mastra Cloud login.

## What runs, and when

`src/mastra/auth/migrate.ts` runs at boot, before the provider is constructed.
It uses Better Auth's own `getMigrations()` — the same entry point the provider
used — so this is the framework's migration path, not a hand-rolled one.

This deliberately preserves the previous behaviour: the deployment auto-migrated
before the change and auto-migrates after it, so no new operator step appeared.
There is no opt-out flag — the behaviour being replaced had none, and an
untested escape hatch is worse than no escape hatch.

Boot prints one of:

```
[auth] schema current — no migration needed.
[auth] applying Better Auth migrations:
  create tables: user, session, account, verification, organization, member, invitation
  add columns:   session(+activeOrganizationId)
[auth] migrations applied.
```

## It throws rather than degrading

A half-migrated database is a broken deployment. The Factory UI cannot load
without auth — `/web/factory/projects` returns 401 and the SPA blocks on
`/auth/me` — so failing at boot is better than failing at a client's first
sign-in.

Two cases stop the boot:

**`schemaProblems`** — the configured schema is internally inconsistent
(conflicting index definitions, for instance). Fix the configuration.

**`unsafeChanges`** — Better Auth refuses to add a **required column with no
default to a populated table**, because the existing rows have nothing to
backfill with. That needs a human decision, and there are three ways out:

1. Give the field a default in the schema config, so existing rows get it.
2. Make the field nullable.
3. Apply it in two steps: add it nullable, backfill the rows yourself, then
   make it required.

Pick deliberately — option 1 or 2 silently changes what the column means for
rows written before the change.

## Before any schema change

Back up first. SQLite holds recent writes in a `-wal` sidecar, so copying the
`.db` file alone does not capture them:

```bash
npm run db:backup     # VACUUM INTO ~/.samskara-backups
```

See [backup-and-restore.md](./backup-and-restore.md).

## Inspecting the plan without applying it

`getMigrations(options, { throwOnUnsafe: false })` returns the plan —
`toBeCreated`, `toBeAdded`, `toBeAddedIndexes`, `unsafeChanges`,
`schemaProblems` — plus `compileMigrations()`, which returns the SQL as a
string instead of executing it. `src/mastra/auth/migrate.ts` already reads the
plan and logs it; extend that function rather than opening a second connection
to the same database.

## Upgrading `better-auth`

`better-auth` is pinned exact in `package.json` and must stay compatible with
the range `@mastra/auth-better-auth` declares (`^1.6.23` as of provider
1.1.5). Two copies on disk means two `Auth` type identities and the provider
will not accept our instance. After any bump:

```bash
npm ls better-auth     # must report a single version, "deduped"
npm run check
```

Then boot once and read the `[auth]` lines: a version that adds a column will
say so.
