# Upgrading Mastra

`@mastra/factory` is pinned to an exact version in `package.json`, not a caret
range. The package ships breaking minors weekly, so an upgrade is a task with a
verification step, not a version bump.

## Before upgrading

Read what changed. The MCP server has a tool for exactly this:

```
mastraMigration { }                         # lists available migration guides
mastraMigration { path: "upgrade-to-v1" }   # reads one
```

Check the release notes for the packages you are moving, not only
`@mastra/factory`. `@mastra/core`, `@mastra/code-sdk` and the integrations move
independently and are pinned independently.

Snapshot the database first — an upgrade can run schema migrations that a
downgrade will not undo:

```bash
npm run db:backup
```

## Doing it

Four packages release together and must move together, pinned exactly:

| Package | Why it moves with the others |
|---|---|
| `@mastra/factory` | the package being upgraded |
| `@mastra/core` | pinned exactly in factory's `dependencies` |
| `@mastra/code-sdk` | pinned exactly in factory's `dependencies` |
| `mastra` (CLI) | ships the Factory UI that `npm run dev` serves |

Read the core and code-sdk versions from the factory release itself:

```bash
npm view @mastra/factory@<version> dependencies --json | grep -E '"@mastra/(core|code-sdk)"'
npm install --save-exact @mastra/factory@<version> @mastra/core@<core> @mastra/code-sdk@<sdk> mastra@<cli>
npm run check
npm ls @mastra/core     # one copy for the app; the docs MCP server may keep its own
```

Moving factory alone leaves two copies of `@mastra/core` and fails type-checking
with identity mismatches on `LibSQLVector`, `LibSQLFactoryStorage`, `PubSub` and
`MastraWorker`. That is a dedupe failure, not a code change. Take the CLI version
released alongside the factory: 0.15.0 shipped with CLI 1.30.0, and 0.16.0 with
CLI 1.31.0, minutes apart (`npm view mastra time`).

The other `@mastra/*` packages (libsql, memory, auth providers, e2b,
redis-streams) are pinned on their own schedule. Move them only when the new
core requires it.

`npm run check` catches removed and renamed exports, which is how most breaking
changes surface here. It will not catch behaviour changes.

## Verifying

Type-checking is not enough. The entry point depends on runtime behaviour that
compiles cleanly either way.

Start the server and read the startup lines:

```
[auth] provider=MastraAuthBetterAuth
[storage] app=… vectors=…
[integrations] github, slack
[sandbox] provider=… isolation=…
```

A missing integration means its constructor now wants something different. A
changed storage or sandbox line means selection logic moved.

Then check the four things this deployment depends on, because each has broken
across a version before:

1. **The vector store is still constructed.** Omitting `vector` yields no vector
   store rather than a default — the SDK's fallback is gated on `storageConfig`,
   which is undefined whenever a storage instance is injected.
2. **The sandbox still throws on an explicit provider with no credentials.**
   `FACTORY_SANDBOX_PROVIDER=e2b` with `E2B_API_KEY` unset must refuse to start.
3. **The custom board still loads**, and its phase handlers still fire. A
   misspelled source key type-checks, is stored, and never runs —
   `defineBoard()` does not validate handler keys.
4. **The plan-advance rule still targets the right board.** The SDK's
   `advanceApprovedPlan` hardcodes `board: "work"` in its return type; the local
   wrapper in `src/mastra/boards/requests-board.ts` exists to correct it. If
   upstream adds a parameterised variant, replace the wrapper.

Verify against the **built** output as well as source when a change touches
configuration. `mastra build` folds `process.env.NODE_ENV` at build time, so a
branch that reads one way in source can compile to a constant.

## Rolling back

```bash
npm install --save-exact @mastra/factory@<previous-version>
```

If the upgrade ran schema migrations, restore the snapshot you took — see
[backup-and-restore.md](backup-and-restore.md). Reinstalling the old package
does not reverse a migration.

## Why the pin

A caret range on a package that ships breaking minors weekly means a
`npm install` on a different day produces a different deployment. The pin makes
upgrades deliberate and dated, and makes a bug report reproducible.
