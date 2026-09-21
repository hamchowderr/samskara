# Contributing to Samskara

The most useful contribution to this project is a **detailed issue**.

Samskara does not accept pull requests. This is deliberate and is explained
below, so that nobody spends an evening on a change that will not be merged.

## Why issues and not pull requests

- **One maintainer.** A patch that arrives without context costs more to review,
  verify and take responsibility for than the same problem described well.
- **A pinned, fast-moving dependency.** The project pins
  `@mastra/factory@0.15.0` exactly, and that package ships breaking minors
  weekly. A change that is correct against your installed version can be wrong
  against the pinned one, and neither of us would notice until something broke.
- **Most defects here are not in this repository.** Samskara is a thin layer
  over `@mastra/*`. A careful bug report frequently resolves to an upstream
  issue, and the report is what establishes that. A patch here would have
  papered over it.

If you have already written a fix, describe it in the issue — the diff, the
file and line, what you tested. That is welcome and useful. It just arrives as
an issue rather than a branch.

## Set up the documentation tooling first

Most reports about this project are really about `@mastra/*`, and the framework
ships breaking minors weekly — so anything remembered about its behaviour is
probably wrong, including by people who use it daily. Mastra provides
first-party tooling so an agent or a person can check instead of recall. Set it
up before investigating, and the report you write will be checkable rather than
asserted.

```bash
# Mastra's own skills: the framework guide, and the Factory supervisor
npx skills add mastra-ai/skills --skill '*' -y
npx skills update          # they move; refresh rather than assume
```

The `skills` CLI installs into whichever agent tools it detects — Claude Code,
Codex, Cursor, Windsurf and others — so this works whatever you use. `npx
skills list` shows what landed where.

The docs MCP server is already configured in `.mcp.json` and installs with
`npm install`. Setup and the reason this repository pins it rather than using
Mastra's documented `npx -y ...@latest` invocation are in
[docs/setup/mastra-docs-mcp.md](docs/setup/mastra-docs-mcp.md).

That gives four sources, in descending order of authority:

1. The `mastra` and `mastra-factory` skills.
2. Docs each package embeds under `node_modules/@mastra/<pkg>/dist/docs/`,
   version-matched to what you installed.
3. The installed package itself — cite `file:line`.
4. The MCP server, for packages that embed no docs. `@mastra/factory` and
   `@mastra/code-sdk` are both in that category, and they are most of what this
   project touches.

**When two sources disagree, say so in the issue.** That disagreement is
frequently the finding — a docstring describing behaviour the code cannot
perform is a real defect, and reporting it as one is more useful than picking
whichever source you trusted.

## Before opening an issue

Search the [existing issues](https://github.com/hamchowderr/samskara/issues)
first, including closed ones.

The issue tracker also travels with this repository on a separate git ref. If
you want to read it locally:

```bash
bd init --remote git+https://github.com/hamchowderr/samskara.git
bd list --status=open
```

## Reporting a bug

A report that can be acted on contains all of these. A report missing the
version block or the reproduction usually cannot be, and will be asked for them
before anything else happens.

**Versions.** Exact, not "latest":

```bash
node --version
npm ls @mastra/factory @mastra/core @mastra/code-sdk --depth=0
git rev-parse --short HEAD
```

**What you did, what happened, what you expected.** In that order, concretely.
"Slack intake is broken" is not actionable; "a message mentioning the bot
creates a work item on the Work board at the Building stage, and I expected it
on my custom board" is.

**A minimal reproduction.** The smallest configuration that shows the problem.
Start from a fresh clone rather than your working tree — it separates the defect
from your environment, and it frequently identifies the cause before you finish
writing it up.

**The evidence, not your conclusion from it.** Paste the actual error, the
actual log lines, the actual database row. If you inspected something, say what
command you ran. A summary of what you think you saw cannot be checked.

**What you already ruled out.** This saves the first three replies.

### Environment details that matter here

State these when they are relevant, because behaviour genuinely differs:

- **Operating system.** Several known traps are Windows-specific, and Windows
  has no sandbox isolation backend at all.
- **Sandbox provider** — `local`, `e2b` or `platform`, and whether you set
  `FACTORY_SANDBOX_PROVIDER` explicitly or let it auto-detect.
- **Database** — a local libSQL file, Turso, or Postgres. Those are the
  backends a Factory runs on, and behaviour differs between them. Samskara's
  entry point wires libSQL and Turso, so say how you got there if you are on
  Postgres.
- **Whether you ran a build.** `mastra build` deletes the entire `.mastra/`
  directory, and the bundler folds `process.env.NODE_ENV` at build time, so a
  branch can behave differently in the built output than in source.
- **Whether you changed `src/mastra/index.ts`.** It is the whole configuration
  surface. A modified entry point is a different deployment, and the report
  should include the diff.

## Requesting a feature

Describe the problem before the solution. What are you trying to do, what
happens instead, and what would "done" look like.

Say whether it belongs here or upstream. A change to how agents plan, run or
review work is `@mastra/factory`'s concern; Samskara's scope is storage
selection, sandbox selection, intake routing, and the board that runs triage on
chat-sourced work.

Feature requests may be declined. Samskara is a specific deployment shape, not a
general-purpose Factory distribution, and a narrow tool that works is worth more
than a broad one that needs explaining.

## Documentation

Errors in the setup runbooks under [`docs/setup/`](docs/setup/) are worth
reporting as bugs — those documents exist because each one cost somebody hours,
and a step that does not work costs the next person the same.

Quote the step that failed and what happened instead.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## What happens to your issue

It gets read. If it can be acted on, it enters the tracker with a priority. If
it resolves to an upstream defect, the issue says so and links the upstream
report. If it is declined, the reason is written down rather than left to a
silent close.

No timeline is promised. This is maintained alongside other work.
