# @samskara/factory-beads

Beads (`bd`) intake and write-back for Mastra Factory: ready beads in each
linked GitHub repository become Work cards, and a card reaching Done closes its
bead and publishes it to the repository's `refs/dolt/data`. A private workspace
package of Samskara; it is not published to npm.

How it works, setup, credentials, the single-writer rule, failure handling and
limitations: [docs/operations/beads.md](../../docs/operations/beads.md).

## Exports (`src/index.ts`)

- `BeadsIntegration` — the Factory integration; Samskara constructs it in
  `src/mastra/index.ts`.
- `createBeadsDoneRule` — the `manual` `onEnter` handler for the Done phase
  (`src/mastra/boards/requests-board.ts`).
- `beadsSetting`, `beadsStartupLine` — the on/off switch and its startup line.
- `BdRunner`, `BdRepo`, `BeadsSyncWorker` and helpers — the `bd`/`git` runner,
  the per-repository copy and the leased sync worker.

## Environment

The package reads no environment variables itself; Samskara reads these in
`src/mastra/index.ts:480-494` and passes them in:

| Variable | Default | Effect |
|---|---|---|
| `BEADS_INTEGRATION` | on | `0`, `false`, `off` or `no` (any case) turns it off |
| `BEADS_POLL_INTERVAL_MS` | `60000` | Sweep interval |
| `BEADS_CACHE_DIR` | `<tmpdir>/factory-beads` | Where the per-repository copies live |
| `BEADS_BD_PATH` | `bd` on `PATH` | The `bd` executable |

Tests: `npm test` runs `test/*.test.ts` against a fake `bd`.
`test/real-bd.test.ts` runs a real `bd` when one is on `PATH`; set
`FACTORY_BEADS_REAL_BD=0` to skip it.
