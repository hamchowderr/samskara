# Turso

Production keeps its data in two Turso databases: one for the app and one for
vectors. This page covers which region they live in and why, how to check a
region before using it, how to move a database to another group, and the two
code paths that reduce the number of round trips to Turso. Tracked in beads
`samskara-lx1` and `samskara-ee3`.

| Database | Group | Region | Infisical keys |
|---|---|---|---|
| `samskara-use1` | `cultured-matter` | `aws-us-east-1` | `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` |
| `samskara-vectors-use1` | `cultured-matter` | `aws-us-east-1` | `TURSO_VECTOR_DATABASE_URL`, `TURSO_VECTOR_AUTH_TOKEN` |

The boot log prints the hosts in use, in the `[storage]` line.

## Region

A Turso group has one primary region, and every database in the group lives
there. Production first used group `default` in `aws-us-west-2`, the region
closest to the VPS in Phoenix. On 2026-10-08 it moved to group
`cultured-matter` in `aws-us-east-1`, because of the stalls below. The old
databases (`samskara` and `samskara-vectors`) were deleted after the move was
confirmed.

### What was measured in aws-us-west-2

- Every connection stalled for about 1.02-1.10s every 6.00s. A query that
  started during a stall waited for it to end.
- The stall appeared with every client tried: `@libsql/client`,
  `@tursodatabase/serverless`, and raw HTTP requests to the `/v2/pipeline` and
  `/v3/pipeline` endpoints.
- On stalled requests the server reported `query_duration_ms` below 1ms. The
  time was spent outside query execution.
- Empty databases with no other traffic stalled the same way, each at its own
  phase. The app's own traffic did not cause it.
- Databases in `aws-us-east-1`, measured the same way, showed no stalls.

From the Phoenix VPS, with the same 10-query page load repeated:

| Region | Median | p95 | Pages at 1s or more |
|---|---|---|---|
| `aws-us-west-2` | 397ms | 1385ms | 19% |
| `aws-us-east-1` | 571ms | 585ms | 0% |

`aws-us-east-1` is further away, so each query takes longer, but the times are
consistent.

This has not been reported to Turso by this project. On the Free plan, support
is community only: Discord at <https://tur.so/discord>, or email
<info@turso.tech>.

## Measuring a region before using it

Round-trip time alone does not show a stall. Check for one before creating
production databases in a region:

1. Create an empty throwaway database in the candidate group.
2. Run a loop that sends `select 1` back to back, with no delay between
   queries, for 40-60 seconds. Record the start time and duration of each
   query.
3. List every query that took 300ms or more, with its time offset from the
   start and the gap since the previous slow one.
4. A healthy region shows a few scattered slow queries. A stalling region
   shows slow queries of similar length at a fixed interval, for example
   about 1s every 6s.
5. Delete the throwaway database and confirm a `GET` on it returns 404.

Run the loop from the machine that will host the app as well as from a
laptop. A stall seen from both is on the Turso side. The scripts used on
2026-10-08 are kept outside the repository in `~/samskara-repros/lx1`.

## Moving a database to another group

The Turso Platform API's create-database call with
`seed: { type: "database" }` returns 404 when the source database is in a
different group (tested 2026-10-08). The supported path is the official Turso
CLI:

- [`turso db export`](https://docs.turso.tech/cli/db/export) writes a
  snapshot of a database to a local SQLite file.
- [`turso db import`](https://docs.turso.tech/cli/db/import), or
  [`turso db create --from-file`](https://docs.turso.tech/cli/db/create),
  creates a database from that file. Both take `--group`.
- The upload API is described at
  <https://docs.turso.tech/api-reference/databases/upload>.

Install the official CLI and use it. The command named `turso` on a machine
may be the local `tursodb` shell instead; `turso --help` shows which one it
is. The 2026-10-08 migration used a hand-ported exporter because the official
CLI was not installed. That is not the recommended route.

Turso's docs note that an export may not contain the latest changes, so stop
the app first. The steps:

1. Back up and stop the app, so nothing writes during the copy.
2. Export both databases.
3. Verify the exported files: row counts per table, and a hash of each
   table's contents, compared with the source.
4. Import each file into the target group.
5. Mint new database tokens with no expiry.
6. Update the four Infisical keys: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`,
   `TURSO_VECTOR_DATABASE_URL`, `TURSO_VECTOR_AUTH_TOKEN`.
7. Restart the app.
8. Verify: the `[storage]` line names the new hosts, sign-in works, and the
   data is present.
9. Keep the old databases until the move is confirmed, then delete them.

## Keep-alive and session cache

Two code paths reduce the cost of each round trip to Turso:

- **Keep-alive.** `@libsql/client` sends queries through Node's global
  `fetch`, which closes an idle connection after 4 seconds. A query after a
  longer gap opens a new TLS connection, which costs about 150-400ms.
  `keepOutboundConnectionsAlive()` in `src/mastra/keep-alive.ts` keeps idle
  connections open for 20 seconds. With 6-second gaps between queries, the
  median was 217ms without it and 43.5ms with it.
- **Session cache.** The Factory auth gate checks the session on every
  request, with two queries each time. A short in-process cache answers
  repeat checks without a query. See [session-cache.md](session-cache.md).
