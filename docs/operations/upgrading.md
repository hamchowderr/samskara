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

## Behaviour changes in 0.20.0

Moving from 0.16.0 to 0.20.0 changes runtime behaviour that type-checking does
not show. Each item below was checked against the installed package.

- **Plan gate (#25329).** `boards/work-transition-policy.js:15` rejects
  Planning to Building for every non-human actor unless plans auto-approve or
  the transition carries `planApproved`. The valid human actor type is
  `'human'` (`rules/types.d.ts:74`), not `'user'`. The approved-plan rule
  runs as a `system` actor, and `rules/processor.js:402` stamps
  `planApproved` only for an approved `submit_plan` result, on any board.
  The Requests board shares this policy; `tests/boards/requests-board.test.ts`
  covers the agent, system and human cases.
- **The Work board no longer auto-triages Intake arrivals (0.17.2, #24983).**
  Its Intake phase has no `onEnter` (`boards/work.js:147`). The Requests
  board keeps its `onArrival` triage rule, so auto-start candidates on it
  still triage themselves.
- **Work cards go to Review when a pull request opens, and to Done when it
  merges (#25377).** The rules are in
  `integrations/github/default-rules.js:110` and `:129`. Both hardcode
  `board: "work"`, so they do not move Requests cards: a Requests card stays
  in Building when its pull request opens, and the merge transition targets
  Work and is refused as cross-board. The policy also stops an agent moving a
  card to Done while `openPullRequestNumber` is set; the merge clears it.
  Verify the Work board behaviour when real work starts.
- **Multi-repo runs stop when the repository is ambiguous (#25116).**
  `routes/surface.js:189` throws `source_repository_ambiguous` instead of
  picking one. A project with more than one linked repository needs the
  repository chosen.
- **Tenant subagents no longer fall back to server env keys (code-sdk 1.9.0,
  #25482).** With a tenant credential store registered, provider keys come
  from the org or user store only (`agents/credential-resolver.js`). A key
  that exists only in the server environment no longer reaches tenant runs.
- **`/web/config/model-packs` is replaced by `/web/config/default-model`
  (#25997)** (`routes/config.js:560`). Nothing in this repository calls
  either route.

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
