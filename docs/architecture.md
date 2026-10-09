# Architecture

Samskara is `@mastra/factory` plus one configuration file. Almost everything
that makes this deployment what it is lives in `src/mastra/index.ts`.

```
src/mastra/
  index.ts                  the whole configuration surface
  keep-alive.ts             keeps outbound connections open (see below)
  boards/requests-board.ts  our Work board (replaces the built-in by id)
  auth/                     Better Auth instance, its migrations, the mailer,
                            and session-cache.ts (the gate's session cache)
  team/                     the team and invitation pages
  public/                   the dev server's working directory, created by
                            `mastra factory dev`; public/factory/ is gitignored
packages/factory-beads/     beads intake and write-back (workspace package)
scripts/                    setup and maintenance, not runtime
docs/setup/                 runbooks, written to be followed by an agent
```

`auth/` exists because `@mastra/auth-better-auth` cannot pass
`sendInvitationEmail`, so this project builds the Better Auth instance itself.
`team/` exists because the Factory UI has no member-invite surface. See
[operations/team-invites.md](operations/team-invites.md). Beyond those, the
Factory supplies the agents, the boards, the UI, the API and the work-item
model; this repository decides which implementations they run against.

## The four things `index.ts` decides

Read in this order — each depends on the ones above it.

**Authentication.** Better Auth, self-hosted. The provider is *selected* first
(`index.ts:149-177`), but the Better Auth instance is *constructed* after
storage (`index.ts:336-354`), because it uses the app database handle
(`storage.authDatabase()`). The comment at `index.ts:145` records this. The
Factory gate's session lookups go through a short in-process cache; see
[operations/session-cache.md](operations/session-cache.md).

**Storage.** A `LibSQLFactoryStorage` instance, pointed at a local file or at
Turso. `DATABASE_URL` is read only to warn that it is being ignored: deploy
platforms inject it automatically, and honouring it would repoint the entire
backend at a database nobody chose. Region choice, stall measurement and
moving a database between groups are in
[operations/turso.md](operations/turso.md).

**Vector.** A `LibSQLVector` instance, passed explicitly. It has to be — the
SDK's default-vector resolution is gated on `storageConfig`, which is undefined
whenever a storage *instance* is injected, and the Factory always injects one.
Omitting it yields no vector store rather than a default. Locally it is a
second file named after the app database (`index.ts:419`). Its URL falls back
to the app database when Turso is configured without a separate vector URL.

**Sandbox.** A function returning one of three implementations, chosen by
`FACTORY_SANDBOX_PROVIDER` and validated at startup. An explicitly requested
provider whose credentials are missing throws rather than falling back to a less
isolated one. See [boards.md](boards.md) for the board wiring and
[troubleshooting.md](troubleshooting.md) for the isolation caveats.

Three settings sit outside those four:

- **`REDIS_URL`** (optional). When set, events and thread leases go through
  Redis Streams (`RedisStreamsPubSub`), so several server processes can share
  one event bus. Unset, the in-process default applies, which is what a single
  container needs. No deployment of Samskara sets it today.
- **HTTP keep-alive.** `keepOutboundConnectionsAlive()` (`keep-alive.ts`) runs
  before any client is created and keeps idle outbound connections open for
  20s. Without it every Turso query after 4s idle opens a new TLS connection.
- **`BEADS_INTEGRATION`** (on by default; `0`, `false`, `off` or `no` turns it
  off). Ready beads in linked repositories become Work cards and Done cards
  close their bead. The code is the `packages/factory-beads` workspace package.
  With more than one server process it requires `REDIS_URL`. See
  [operations/beads.md](operations/beads.md).

## Principles the file follows

**Fail at startup, not at runtime.** A missing credential, an unknown provider
name, an auth token absent for a remote database — each throws during
initialisation. The alternative is discovering it when an agent run behaves
strangely.

**Never silently substitute.** Where a choice was made explicitly, a missing
prerequisite is an error. Where nothing was chosen, auto-detection applies and
says what it picked.

**Say what was chosen.** Startup prints one line per decision, in this order:
`[auth] provider=`, `[mail]`, `[storage]`, `[beads]`, `[integrations]`,
`[sandbox] provider=`, and, for the `local` provider, `[sandbox] isolation=`.
`[PubSub]` appears first when `REDIS_URL` is set, a `[storage] No
TURSO_DATABASE_URL` warning precedes `[auth]` on a local file, and the Better
Auth migration step logs its own `[auth]` line (`auth/migrate.ts:61`, `:73`)
before the provider line. Diagnosing
a deployment starts by reading those lines.

**Keep durable state out of build output.** `mastra build` deletes the whole
`.mastra/` directory. The database lives in `data/` when `MASTRA_DB_PATH` points
there (set it to an absolute path; see `.env.example`), and backups live outside
the repository, because an earlier layout lost both. Unset, `MASTRA_DB_PATH`
leaves the database at the Mastra Code CLI's shared
`<appdata>/mastracode/mastra.db` (`@mastra/code-sdk`
`dist/utils/project.js:150-153`).

## Editing `index.ts`

It is one long file of configuration with substantial comments explaining why
each decision is what it is. The comments are load-bearing — several record
behaviour that is not obvious from the API and was established by reading the
installed package.

Edit it with anchored scripts that assert each anchor matches exactly once.
Loose string slicing has silently deleted whole blocks here.

## Where the rest lives

| Concern | Where |
|---------|-------|
| Getting a deployment running | [docs/setup/](setup/) |
| Starting a new project on a running deployment | [docs/setup/new-project.md](setup/new-project.md) |
| Boards and phase handlers | [docs/boards.md](boards.md) |
| Backups, upgrades, beads, mail, Turso | [docs/operations/](operations/) |
| Known failure modes | [docs/troubleshooting.md](troubleshooting.md) |
| Agent verification rules | `CLAUDE.md`, `AGENTS.md` |
