# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:1105d646 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


## Verify against the Mastra docs AND the installed package — always

**Before stating any fact about Mastra behaviour, and before writing code that
depends on one, check BOTH sources. Never answer from memory or inference.**

1. **The installed package** — `node_modules/@mastra/*`. This is what actually
   runs. Cite `file:line`.
2. **The official docs** — via the `mastra-docs` MCP server
   (`@mastra/mcp-docs-server`). `searchMastraDocs`, `readMastraDocs`,
   `getMastraExports`, `getMastraExportDetails`, `mastraMigration`. Every
   `[📦 LOCAL PACKAGES]` tool needs `projectPath` (absolute repo root) as a
   required argument.

**When the two disagree, that disagreement IS the finding** — say so explicitly
rather than silently trusting one. A docstring describing behaviour the code
cannot perform is a reportable bug, not a detail to smooth over.

If the MCP server is unreachable (it times out on a cold `npx` download and
cannot be reconnected mid-session), either restart, or drive it over stdio
directly — do NOT fall back to guessing. Say it is unavailable instead.

### Claims require evidence

- Never report a negative ("X is not supported", "there is no route for Y")
  from a single grep. Validate the instrument first: prove the search finds a
  known-present case. HTTP status codes are NOT evidence of route existence
  here — unknown `/auth/*` paths return SPA HTML and unknown `/api/*` paths
  return 401.
- Verify behaviour, not just logic: run it and read the output. Type-checking
  proves nothing about runtime.
- **Verify against the BUILT output, not only source.** The bundler folds
  `process.env.NODE_ENV` at build time, so a NODE_ENV-dependent branch can
  compile to a constant and behave differently from the source you read.
- Before anything goes to the Mastra team or a public issue, have it
  independently audited (a fresh subagent and Codex, separately) and report
  only what survives. Overstating a claim gets it dismissed.

## Build & Test

```bash
npm run dev          # local: plain .env, no Infisical needed
npm run dev:secure   # injects secrets from Infisical (maintainer only)
npm run check        # tsc --noEmit
npm run build        # bundles to .mastra/output
npm run db:backup    # snapshot to ~/.samskara-backups (VACUUM INTO)
```

**`mastra build` deletes the whole `.mastra/` directory.** Never store anything
you want to keep there — the database lives in `data/` for exactly this reason,
and backups go outside the repo. This destroyed the local database twice.

## Architecture Overview

Samskara is a self-hosted Mastra Factory built on `@mastra/factory` as a
dependency, not a fork. Entry point: `src/mastra/index.ts`.

- **Storage** — libSQL only. Local file by default; Turso when
  `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` are set. Postgres is deliberately
  not wired: an injected `DATABASE_URL` must never repoint the backend.
- **Vector** — `LibSQLVector`, passed explicitly and kept in its own file
  beside the app database. It must be passed: the Factory always injects a
  storage instance, so the SDK's documented default-vector resolution cannot
  run and omitting it yields no vector store at all.
- **Sandbox** — `local | e2b | platform` via `FACTORY_SANDBOX_PROVIDER`,
  auto-detected when unset. An explicit choice missing its credentials THROWS;
  it must never silently downgrade to a less isolated provider.
- **Boards** — `src/mastra/boards/requests-board.ts` wires `manual` work items
  into triage, which the built-in Work board does not do.

## Conventions & Patterns

- Back up the database before killing any server process. SQLite holds recent
  writes in a `-wal` sidecar until a checkpoint, so a hard kill loses them and
  copying the `.db` file alone does not capture them — use `npm run db:backup`.
- Edit `src/mastra/index.ts` with anchored scripts that assert each anchor
  matches exactly once. Loose string slicing has silently deleted whole blocks.
- Never print a secret value. Confirm presence by mask only (type, length,
  first characters).
