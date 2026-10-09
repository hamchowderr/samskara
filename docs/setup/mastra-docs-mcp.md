# The Mastra docs MCP server

`@mastra/mcp-docs-server` gives an agent two ways to answer a question about
Mastra: read the packages installed in this repo, or read the published
documentation. This project requires both — see the verification rule in
[CLAUDE.md](../../CLAUDE.md).

Do this first. Every other runbook assumes an agent can check its own claims.

This server is one of four sources, and not the first. In descending order of
authority: the `mastra` skill (`npx skills add mastra-ai/skills --skill '*' -y`),
the docs each package embeds under `node_modules/@mastra/<pkg>/dist/docs/`, the
installed package itself, and this server for packages that embed none —
`@mastra/factory` and `@mastra/code-sdk` among them. The ladder is in
[CLAUDE.md](../../CLAUDE.md#never-answer-mastra-from-memory).

## Two sources, and why the distinction matters

| Source | Tools | Reads |
|--------|-------|-------|
| **Local packages** | `listMastraPackages`, `searchMastraDocs`, `readMastraDocs`, `getMastraExports`, `getMastraExportDetails` | `node_modules/@mastra/*` in this repo — matches the code that actually runs |
| **Remote** | `mastraDocs`, `mastraMigration` | the published documentation — latest release, which may be ahead of your installed version |

The local tools tell you what the code does. The remote tools tell you what the
docs claim it does. When those disagree, the disagreement is the finding, not a
detail to smooth over. A docstring describing behaviour the code cannot perform
is a reportable bug.

There are also five course tools (`startMastraCourse`, `getMastraCourseStatus`,
`startMastraCourseLesson`, `nextMastraCourseStep`, `clearMastraCourseHistory`).
They run an interactive tutorial and are not used for verification.

## Install

Nothing to do in this repository: `@mastra/mcp-docs-server` is already a
devDependency (`package.json:48`), so `npm install` installs it, and
`.mcp.json` is checked in. This section records how it was set up, for another
project.

The package is installed rather than launched with `npx`:

```bash
npm i -D @mastra/mcp-docs-server
```

and `.mcp.json` at the repo root calls `node` on it:

```json
{
  "mcpServers": {
    "mastra-docs": {
      "type": "stdio",
      "command": "node",
      "args": ["node_modules/@mastra/mcp-docs-server/dist/stdio.js"]
    }
  }
}
```

Restart your agent host so it picks up the server.

### Why not `npx`

A configuration like this looks simpler and does not work reliably:

```json
{ "command": "npx", "args": ["-y", "@mastra/mcp-docs-server@latest"] }
```

`npx -y ...@latest` re-resolves the package from the registry every time the
server starts, and `npx` itself is the cost even without `@latest`. Measured
from spawn to a valid `initialize` response, as recorded in
[CLAUDE.md](../../CLAUDE.md#setting-up-the-tooling): `npx mcp-docs-server`
took **35.1 s** cold and 2.0–2.5 s warm. Claude Code gives a server about
**30 seconds** to connect, so the cold start fails, and because the failure
happens at client startup it usually cannot be reconnected without restarting
the whole session. A manual retest hits a warm cache and passes, which hides
the problem.

Called with `node` on the installed file, the same server answered `initialize`
in 0.7–0.9 s in that measurement, and in 2.8 s on the first start and
0.56–0.58 s after that when re-measured on 2026-10-08 (Windows 11, Node
24.16.0, three consecutive starts).
It reports 13 tools.

### Requirements

Node.js **>= 22.13.0** (`engines` in the package manifest).

## `projectPath` is required on every local-packages tool

`listMastraPackages`, `searchMastraDocs`, `readMastraDocs`, `getMastraExports`,
`getMastraExportDetails` and `getMastraHelp` all take a required `projectPath`:
an **absolute** path to the repo root. The server searches upward from there for
a `node_modules` containing Mastra packages.

Omitting it fails the call. The two remote tools (`mastraDocs`,
`mastraMigration`) do not take it.

## Verifying a claim

Start with `getMastraHelp` — the package labels it "START HERE" and it explains
the two sources.

A normal verification pass:

```
listMastraPackages     { projectPath }
        -> which @mastra/* packages are installed, and at which versions

getMastraExports       { package: "@mastra/core", projectPath }
        -> every class, function, type and constant the package exports

getMastraExportDetails { package: "@mastra/core", exportName: "Agent",
                         projectPath, includeImplementation: true }
        -> type definitions, and the source if you ask for it

mastraDocs             { paths: ["reference/agents/agent"] }
        -> what the published documentation says about the same thing
```

Cite `file:line` under `node_modules/` for anything you assert about runtime
behaviour. A search hit is a lead, not an answer — open the source before
stating a fact.

## Claims that need more than this server

Reading the package is necessary but not always sufficient:

- **Check the built output, not only the source.** The bundler folds
  `process.env.NODE_ENV` at build time, so a branch that reads one way in source
  can compile to a constant and behave differently.
- **Never report an absence from a single search.** Prove the search finds a
  known-present case first. In this project, HTTP status codes are not evidence
  of whether a route exists: unknown `/auth/*` paths return the SPA's HTML and
  unknown `/api/*` paths return 401.
- **Run it.** Type-checking proves nothing about runtime behaviour.

## If the server will not connect

- Confirm Node is 22.13.0 or newer: `node --version`.
- Confirm the file exists:
  `ls node_modules/@mastra/mcp-docs-server/dist/stdio.js`.
- Confirm the package installed completely — a partial install leaves the
  directory present but the binary missing.

Do not fall back to answering from memory. If the server is unavailable, say so.
