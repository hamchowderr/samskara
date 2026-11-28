# @samskara/factory-app-intake

Outside-app intake (beads `samskara-rvq`). Tickets that a platform admin sends from an outside app become beads in that app's repository. The beads integration then puts them on the board, and the app is told "fixed" when the bead closes.

It runs as a `BeadsRepoHook` inside `@samskara/factory-beads`' sweep. For the contract, configuration and how to add an app, see [docs/operations/app-intake.md](../../docs/operations/app-intake.md).
