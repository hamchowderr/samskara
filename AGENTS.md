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


## Verifying Mastra behaviour

### Never answer Mastra from memory

Mastra ships breaking minors weekly, so training data is wrong and a plausible
answer is usually a stale one. Verify every claim against a live source, in this
order:

1. **The `mastra` skill** — the vendor's own guide to finding current docs and
   building against current APIs. Mastra names this the recommended path for
   everyday work, over the MCP docs server.
2. **Embedded package docs** — `node_modules/@mastra/<pkg>/dist/docs/`, carrying
   `SKILL.md`, `references/` and `assets/SOURCE_MAP.json`. Version-matched to
   what is installed, so they beat anything published. Not every package ships
   them: `@mastra/core` and `@mastra/libsql` do.
3. **The installed package itself** — `node_modules/@mastra/*`. This is what
   actually runs. Cite `file:line`.
4. **The `mastra-docs` MCP server** — for packages with no embedded docs, and
   for the published-docs view. Its `[📦 LOCAL PACKAGES]` tools read
   `node_modules` and each require `projectPath`; its `[🌐 REMOTE]` tools read
   the published docs and may be ahead of what is installed.

**When two sources disagree, that disagreement is the finding.** Say so rather
than silently trusting one. A docstring describing behaviour the code cannot
perform is a reportable bug.

### Setting up the tooling

**The skills are not checked in.** `skills-lock.json` pins them; the files are
fetched. Run `npx skills list` at the start of a session — if `mastra` and
`mastra-factory` are not there, install them before doing any Mastra work:

```bash
npx skills add mastra-ai/skills --skill '*' -y
npx skills update            # they move; refresh rather than assume
```

- **`mastra`** — framework guide: agents, workflows, tools, memory, storage and
  the `mastra api` CLI.
- **`mastra-factory`** — operating a running Factory through
  `mastra api factory`: status, queues, work items, metrics, health, supervisor
  sessions.

`npx skills list` shows what is installed and where. A skill named in
`skills-lock.json` is a declaration, not proof of installation — check disk.

The docs MCP server needs no setup: `.mcp.json` is checked in, and
`@mastra/mcp-docs-server` is a devDependency, so `npm install` is enough.

> Mastra's published config for the MCP server is
> `npx -y @mastra/mcp-docs-server@latest`. Avoid it — but note that dropping
> `@latest` is not enough, because **`npx` itself is the cost**. Measured here,
> spawn to a valid `initialize` response: `npx mcp-docs-server` took 35.1s cold
> and 2.0-2.5s warm; `node node_modules/@mastra/mcp-docs-server/dist/stdio.js`
> took 0.7-0.9s every time. Claude Code's connect budget is 30s, so only the cold
> run misses it — and any manual retest hits a warm cache and passes, which is how
> this regressed twice. `.mcp.json` therefore calls `node` on the declared bin
> directly. If you change it, time a COLD start, not a warm one.

### Two things specific to this project

- **`@mastra/factory` and `@mastra/code-sdk` ship no `dist/docs`.** For those
  two — which is most of what this project touches — read the installed package
  and cite `file:line`, or use the `mastra-docs` MCP. The embedded-docs step
  does not apply.
- **The `mastra-factory` skill operates a running Factory** via
  `mastra api factory` — status, queues, work items, health, supervisor
  sessions. Reach for it before writing a script that pokes the database or the
  HTTP API directly.

### Before wiring anything Mastra-shaped

Mastra or this project usually already ships it. Check, in this order, and only
then consider writing something:

1. `npx mastra --help`, and the subcommand's `--help` — the CLI covers create,
   init, dev, build, lint, api and `factory`.
2. `scripts/` in this repository — it may already exist.
3. The `mastra` and `mastra-factory` skills.
4. The package's exports — `getMastraExports` via the MCP, or read `dist/*.d.ts`.

Hand-rolling something the framework ships is the recurring failure here. It
wastes a session and produces a worse version that then has to be maintained.

### Non-Mastra dependencies you configure yourself

Everything above is scoped to Mastra. The moment this project takes ownership
of another library's configuration — as it does with `better-auth`, because
`@mastra/auth-better-auth` cannot pass `sendInvitationEmail` — that library's
OWN documentation becomes a required source, and the ladder above does not
cover it.

**Reading the installed source is not a substitute.** Source tells you what the
code does. It never tells you what the maintainers warn you about. Better
Auth's "Avoid awaiting the email sending to prevent timing attacks" exists only
in prose; reading `api/routes/password.mjs` shows the call and nothing about
why awaiting it leaks account existence. That warning was missed exactly this
way, and it shipped an account-enumeration oracle into a first draft.

So before writing integration code against any non-Mastra library this project
configures:

1. **Fetch the vendor's docs** for the specific feature — WebFetch, the
   `defuddle` skill, or the `SDK Quality Gate` agent. Not a search result
   summary: the page.
2. **Ask what it ships that you are about to write.** Better Auth ships
   `@better-auth/cli migrate`; the reason this project calls `getMigrations()`
   instead is that the CLI statically imports an `auth.ts` and our instance
   needs a runtime database handle. That reason belongs in the code, and it
   only exists because the docs were checked.
3. **Read the security notes**, not just the API shape. Timing, CSRF, origin
   and enumeration guidance is prose, and it is the part source-reading loses.

Record what the docs said in `docs/operations/`, with the file:line of the code
that implements it, so the next reader does not have to re-derive it.

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
npm run dev          # local: no Infisical needed. `predev` generates a
                     # development BETTER_AUTH_SECRET and
                     # FACTORY_CREDENTIAL_ENCRYPTION_KEY into .env.local
                     # on first run, so sign-in works against the local
                     # database instead of falling through to the
                     # platform default.
npm run dev:secure   # injects secrets from Infisical (maintainer only);
                     # predev:secure refuses to start if its credential
                     # key differs from .env.local's (samskara-1kl)
npm run check        # tsc --noEmit
npm test             # vitest: tier-1, real temp libSQL, no server
npm run test:e2e     # playwright: invite flow on port 4199, throwaway DB
npm run build        # bundles to .mastra/output
npm run db:backup    # snapshot to ~/.samskara-backups (VACUUM INTO)
```

**`mastra build` deletes the whole `.mastra/` directory.** Never store anything
you want to keep there — the database lives in `data/` for exactly this reason,
and backups go outside the repo. This destroyed the local database twice.

Production runs the Docker image on Coolify, booting under `infisical run`:
see `docs/setup/deploy-coolify.md`.

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
