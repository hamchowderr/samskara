# Architecture

Samskara is `@mastra/factory` plus one configuration file. Almost everything
that makes this deployment what it is lives in `src/mastra/index.ts`.

```
src/mastra/
  index.ts                  the whole configuration surface
  boards/requests-board.ts  the one custom board
  auth/                     Better Auth instance, its migrations, and the mailer
  team/                     the team and invitation pages
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

**Authentication.** Better Auth, self-hosted. Constructed early so a
misconfiguration fails before anything else initialises.

**Storage.** A `LibSQLFactoryStorage` instance, pointed at a local file or at
Turso. `DATABASE_URL` is read only to warn that it is being ignored: deploy
platforms inject it automatically, and honouring it would repoint the entire
backend at a database nobody chose.

**Vector.** A `LibSQLVector` instance, passed explicitly. It has to be — the
SDK's default-vector resolution is gated on `storageConfig`, which is undefined
whenever a storage *instance* is injected, and the Factory always injects one.
Omitting it yields no vector store rather than a default. Its URL falls back to
the app database when Turso is configured without a separate vector URL.

**Sandbox.** A function returning one of three implementations, chosen by
`FACTORY_SANDBOX_PROVIDER` and validated at startup. An explicitly requested
provider whose credentials are missing throws rather than falling back to a less
isolated one. See [boards.md](boards.md) for the board wiring and
[troubleshooting.md](troubleshooting.md) for the isolation caveats.

## Principles the file follows

**Fail at startup, not at runtime.** A missing credential, an unknown provider
name, an auth token absent for a remote database — each throws during
initialisation. The alternative is discovering it when an agent run behaves
strangely.

**Never silently substitute.** Where a choice was made explicitly, a missing
prerequisite is an error. Where nothing was chosen, auto-detection applies and
says what it picked.

**Say what was chosen.** Every decision prints one line at startup: auth
provider, storage targets, integrations, sandbox provider and isolation backend.
Diagnosing a deployment starts by reading those five lines.

**Keep durable state out of build output.** `mastra build` deletes the whole
`.mastra/` directory. The database lives in `data/` and backups outside the
repository because an earlier layout lost both.

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
| Boards and phase handlers | [docs/boards.md](boards.md) |
| Backups, upgrades | [docs/operations/](operations/) |
| Known failure modes | [docs/troubleshooting.md](troubleshooting.md) |
| Agent verification rules | `CLAUDE.md`, `AGENTS.md` |
