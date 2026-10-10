---
name: factory-beads
description: Plan, file and update beads (bd issues) with the beads_* tools, and write commits and pull requests that trace back to them
---

# Factory Beads

Use this skill whenever you read, plan or file work in a repository that tracks it with beads, and whenever you commit or open a pull request for a bead.

Beads is the source of truth for trackable work. The point is a clean, detailed back-trace to any decision, not a list of one-line titles. Two questions decide everything: *is this trackable work?* and *could someone resume it in two weeks from the bead alone?*

## Use the tools, never bd

Read and write beads only through the `beads_*` tools. They run bd on the Factory host, which is the only writer to the repository's beads data, and they publish every write. Do not install or run `bd` in the sandbox, and do not edit `.beads/` files.

| Tool | Use it to |
|---|---|
| `beads_ready` | see what is ready to work on (open, no open blockers) |
| `beads_list` | find beads by status, type, parent, label, priority or title |
| `beads_show` | read one bead in full before acting on it |
| `beads_create` | file a new bead (bd validates it) |
| `beads_update` | edit fields, set status, append notes |
| `beads_dep_add` | link two beads |
| `beads_formula_list`, `beads_pour` | start a workflow formula as linked beads |
| `beads_init` | supervisor only: start beads in a repository that has none, only when a person asked |

When the project links more than one repository, pass `repository` as `owner/name`.

There is no close and no delete. A bead is closed when its card reaches Done. Never set a status to `closed`; the tool refuses it. A closed bead is never edited or reopened: file follow-up work as a new bead and link it. Do not change a bead's status unless the work behind it actually changed.

Only the supervisor has `beads_init`. In any other session, if a repository has no beads yet, say so in your handoff instead of working around it.

## What goes in a bead

| It is... | Home |
|---|---|
| Trackable work: a feature, bug, fix, task, chore or epic, and the decisions behind it | a bead |
| A durable fact or insight that is not work | not a bead |
| A checklist for this run only | your own plan, not a bead |

Do not over-file. If nobody would need it two weeks from now, it is not a bead.

## Before you create: search

Search before filing so you never create a duplicate: `beads_list` with `title_contains`, and `beads_ready`. If the work already exists, link to it with `beads_dep_add` instead of filing it again. Do not start work that is already claimed (`in_progress`) or already has an open pull request.

## One deliverable per bead

Each bead is one deliverable that can be finished, reviewed and closed on its own. Apply the "and" test: if you cannot name it without saying "and", it is two beads. Larger work is an epic with child beads.

## Fill every field

Every bead you create has all four fields, each with its own job:

- **Title**: specific and action-oriented, for example `Fix: auth token expires before refresh`, not `Fix bug`.
- **Description**: the problem and why it matters.
- **Design**: how, and the trade-offs. This is the decision record: "chose X over Y because ...". It may change later. Always pass it, even when the type does not require it.
- **Acceptance**: what success looks like. Outcome-focused; each criterion a definite yes or no; not steps.
- **Notes**: a running log and handoff for the next person. Append with `beads_update` `append_notes`; notes are never replaced.

The design-versus-acceptance test: if you rewrote the solution a different way and a criterion no longer applied, it was design, not acceptance. "Use JWT" is design; "sessions survive a restart" is acceptance.

Capture the *why* in the design as you decide, not only what you did.

## Issue types

`beads_create` refuses an unknown type and a bead missing its type's required sections. bd's types:

| Type | Use it for | Required by bd |
|---|---|---|
| `task` | a general unit of work (the default) | Acceptance |
| `bug` | a defect: something that worked or should work and does not | a `## Steps to Reproduce` section in the description, and Acceptance |
| `feature` | a new capability or enhancement | Acceptance |
| `chore` | maintenance or housekeeping with no behaviour change | nothing |
| `epic` | a large body of work that holds child beads | Acceptance (its success criteria) |
| `decision` | an architecture decision record | `## Decision`, `## Rationale`, `## Alternatives Considered` sections in the description |
| `spike` | a timeboxed investigation before committing to the work | `## Goal` and `## Findings` sections in the description |
| `story` | a feature described from the user's side | Acceptance |
| `milestone` | marks completion of a set of beads; holds no work itself | nothing |

A repository may define more types; the tool's error lists every type it accepts.

Priority runs from 0 (highest) to 4 (lowest); 2 is normal.

## Epics, children and dependencies

- Put child beads under an epic with `parent` on `beads_create`. An epic is a container that holds no work itself: once one of its children is ready it gets an overview card, and its children's cards are linked under it. An overview card is never moved into a working phase and cannot move to Done while a child is open. When its last child closes, the card moves to Done by itself and the epic is closed, so there is nothing to move or close by hand. A milestone and a poured molecule's root work the same way.
- Use `beads_dep_add` with type `blocks` (the default) when one bead cannot start before another closes. A blocked bead stays out of `beads_ready` and gets its card only after its blocker closes, so blocks edges set the build order.
- Found work in the middle of a task? Create it complete, then `beads_dep_add` it to the bead you were working on with type `discovered-from`, so the causal link survives.
- Reversed a decision? Link the old bead to the new one with type `supersedes` and say why in the notes. Never silently drop the old one: the trail must show why it changed.

## Workflows

`beads_formula_list` lists the repository's own workflow formulas (its `.beads/formulas`); nothing from elsewhere on the server is offered. `beads_pour` turns one into a molecule: a root bead of type `molecule` with linked, ordered step beads under it, its variables filled in. Preview with `dry_run` first. Poured steps skip the create-time check, so before work starts on a step, fill any missing design or acceptance with `beads_update`.

A formula is refused when it extends or composes with a formula that is not one of the repository's own, at any depth, and when it has gated steps, its own, inherited through `extends`, or in a formula it attaches through a hook or `on_complete`. A gate becomes a bead that only closing clears, and no tool closes beads, so its steps would never become ready. Ask a person to pour such a formula.

## No private data in beads

A repository's beads, notes included, are published to its `refs/dolt/data` ref and can be read by anyone who can read the repository. Deleting does not remove them: the history keeps every version. Never write real product names, client names, private repositories or internal business context into a bead, a note or a commit that links one. Name a private thing by its role instead: "a reference chat app", "the house style", "downstream products".

## New work lands in intake

A bead you create becomes a card on the board's intake and waits there for a person. Filing a bead is not permission to build it.

## Commits and pull requests

Commit messages use Conventional Commits:

```
type(scope)!: summary (<bead-id>)

What changed and why, wrapped at about 72 characters.

Agent-Signature: <runtime>-<model>-<reasoning> on behalf of <git user.name>
```

- Types: `feat` (new capability), `fix` (bug fix), `perf`, `refactor` (no behaviour change), `test`, `docs`, `build`, `ci`, `chore`, `style`, `revert`. A breaking change is `feat!:` or a `BREAKING CHANGE:` footer.
- Subject: 50 characters or fewer, imperative mood ("add", not "added"); read it as "if applied, this commit will ...".
- Body: what changed and why, not how. The diff already says how.
- Put the bead id in parentheses in the subject, so every commit traces to its bead and the bead to what shipped it.
- Add the `Agent-Signature` trailer on top of any `Co-Authored-By` trailer. Take the model and reasoning only from reliable session metadata; when you do not have them, write `unknown-model` and `unknown-reasoning`. Never guess them.
- One logical change per commit. Each commit builds and passes on its own. No `wip`, `fix typo` or `address review` commits: squash them before merge.
- Branch names start with `feature/`, `fix/` or `chore/`. Never commit or push to `main` or `master`.
- A pull request tells one story. Apply the "and" test to its title. Type it by its highest-impact commit: `feat` over `fix` over `refactor`/`perf` over `test`/`chore`/`docs`.
- Keep a pull request reviewable in one sitting: roughly 200 to 400 changed lines. Split larger work.
- Never merge a pull request and never promote to production. Done for an agent is: checks green on the pull request, and its preview deploy live where the project has one. Merging is a person's step.
