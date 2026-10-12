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
downgrade will not undo.

Locally (needs `MASTRA_DB_PATH`):

```bash
npm run db:backup
```

In production, on Turso, `npm run db:backup` cannot reach the database. Export
both Turso databases first, or note the time for a point-in-time restore; see
[backup-and-restore.md](backup-and-restore.md#production-turso).

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
released alongside the factory: 0.15.0 shipped with CLI 1.30.0, 0.16.0 with
CLI 1.31.0, and 0.20.0 with CLI 1.33.0, minutes apart (`npm view mastra time`).

The other `@mastra/*` packages (libsql, memory, auth providers, e2b,
redis-streams) are pinned on their own schedule. Move them only when the new
core requires it. Check whether it does from the factory and code-sdk
dependency lists:

```bash
npm view @mastra/factory@<version> dependencies --json    # core, code-sdk, auth-workos
npm view @mastra/code-sdk@<sdk> dependencies --json       # libsql, memory
```

At 0.20.0 that moved three more: `@mastra/auth-workos` 1.6.6 (pinned in
factory), `@mastra/libsql` 1.25.1 and `@mastra/memory` 1.36.0 (pinned in
code-sdk 1.11.0). Leaving them behind installs a second copy beside the app's.

`npm run check` catches removed and renamed exports, which is how most breaking
changes surface here. It will not catch behaviour changes.

## Verifying

Type-checking is not enough. The entry point depends on runtime behaviour that
compiles cleanly either way.

Start the server and read the startup lines:

```
[auth] provider=MastraAuthBetterAuth
[mail] Resend configured — password reset, email verification and invitations will send.
[storage] app=… vectors=…
[beads] on by default; set BEADS_INTEGRATION=0 to turn it off.
[integrations] github, slack, beads
[sandbox] provider=…
[sandbox] isolation=…        (local provider only)
```

A missing integration means its constructor now wants something different. A
changed storage or sandbox line means selection logic moved.

Then check the things this deployment depends on, because each has broken
across a version before, or depends on code that reads the installed package:

1. **The vector store is still constructed.** Omitting `vector` yields no vector
   store rather than a default — the SDK's fallback is gated on `storageConfig`,
   which is undefined whenever a storage instance is injected.
2. **The sandbox still throws on an explicit provider with no credentials.**
   `FACTORY_SANDBOX_PROVIDER=e2b` with `E2B_API_KEY` unset must refuse to start.
3. **Our Work board still replaces the built-in.** `includeDefaultBoards: false`
   with a same-id board is the documented customization path (README "replace
   Work or Review", `factory-skills/configure-factory-rules/SKILL.md`). Re-read
   both on every upgrade, and check that `tests/boards/requests-board.test.ts`
   still passes: it asserts our phases and roles match `workBoard`'s and that
   every source key is one the runtime knows (`defineBoard()` does not validate
   handler keys).
4. **Behaviour keyed to the id `work` still applies.** The default GitHub
   rules, `advanceApprovedPlan` and the triage classification tool all key on
   the literal `"work"`; see [boards.md](../boards.md#replacing-work-by-id).
   `tests/boards/work-board-github-rules.test.ts` drives the stock GitHub rules
   against the installed registry.
5. **Beads still constructs and syncs.** `beads` is in the `[integrations]`
   line, and `GET /web/beads/status`, from a signed-in session, shows each
   beads repository with `state: "ok"`. Check that
   `.mastra/output/package.json` does not list `@samskara/factory-beads` (see
   [beads.md](beads.md#build-note)).
6. **The Better Auth provider has not changed under us.** `npm run
   check:auth-parity` passes; when it fails, follow
   [better-auth-migrations.md](better-auth-migrations.md#how-drift-is-caught).

Verify against the **built** output as well as source when a change touches
configuration. `mastra build` folds `process.env.NODE_ENV` at build time, so a
branch that reads one way in source can compile to a constant.

## Behaviour changes in 0.20.0

Moving from 0.16.0 to 0.20.0 changes runtime behaviour that type-checking does
not show. Each item below was checked against the installed package.

- **Plan gate (#25329).** `boards/work-transition-policy.js:15` rejects
  Planning to Building for every non-human actor unless plans auto-approve or
  the transition carries `planApproved`. The valid human actor type is
  `'human'` (`rules/types.d.ts:74`), not `'user'`. The approved-plan rule
  runs as a `system` actor, and `rules/processor.js:402` stamps
  `planApproved` only for an approved `submit_plan` result, on any board.
  Our Work board uses this policy unchanged; `tests/boards/requests-board.test.ts`
  covers the agent, system and human cases.
- **The Work board no longer auto-triages Intake arrivals (0.17.2, #24983).**
  Its Intake phase has no `onEnter` (`boards/work.js:147`). Our Work board
  follows it: SKILL.md says not to restore arrival automation on the
  built-in boards, so arrivals wait in Intake for a person.
- **Work cards go to Review when a pull request opens, and to Done when it
  merges (#25377).** The rules are in
  `integrations/github/default-rules.js:110` and `:129`. Both hardcode
  `board: "work"`; our board has that id, so they apply to it unchanged. The
  policy also stops an agent moving a card to Done while
  `openPullRequestNumber` is set; the merge clears it.
- **Multi-repo runs stop when the repository is ambiguous (#25116).**
  `routes/surface.js:189` throws `source_repository_ambiguous` instead of
  picking one. In a project with more than one linked repository, a card
  that does not name its repository needs it chosen. Beads cards name it
  (`metadata.repository`, `samskara-srl`;
  [beads.md](beads.md#multi-repository-factories-the-card-names-its-repository)).
- **Tenant subagents no longer fall back to server env keys (code-sdk 1.9.0,
  #25482).** With a tenant credential store registered, provider keys come
  from the org or user store only (`agents/credential-resolver.js`). A key
  that exists only in the server environment no longer reaches tenant runs.
- **`/web/config/model-packs` is replaced by `/web/config/default-model`
  (#25997)** (`routes/config.js:560`). Nothing in this repository calls
  either route.

## Rolling back

Roll back the four packages together, as they moved together (see
[Doing it](#doing-it)), plus any of `@mastra/libsql`, `@mastra/memory` and
`@mastra/auth-workos` that moved with them:

```bash
npm install --save-exact @mastra/factory@<previous> @mastra/core@<previous-core> @mastra/code-sdk@<previous-sdk> mastra@<previous-cli>
npm run check
npm ls @mastra/core
```

Moving factory back alone leaves the same duplicate `@mastra/core` that moving
it forward alone does.

If the upgrade ran schema migrations, restore the snapshot you took — see
[backup-and-restore.md](backup-and-restore.md). Reinstalling the old package
does not reverse a migration.

## Why the pin

A caret range on a package that ships breaking minors weekly means a
`npm install` on a different day produces a different deployment. The pin makes
upgrades deliberate and dated, and makes a bug report reproducible.
