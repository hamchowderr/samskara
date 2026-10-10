---
name: factory-beads-decision
description: Research an open decision bead and write the decision into it with the beads_* tools, for a person to approve by moving its card to Done
---

# Factory Beads Decision

Use this skill when a decision card enters Planning. The card stands for an open `decision` bead: a question the project has to settle. Your job is to research it and write the answer into the bead. A person approves it.

You are working in a bound Factory session. Do the whole pass in one run. The `factory-beads` skill's rules apply too: read and write beads only with the `beads_*` tools, and never write private names into a bead.

## What you do not do

- Do not write, change or commit code. Do not open a branch or a pull request.
- Do not close the bead and do not set its status. Moving its card to Done is the approval, and only a person makes that move.
- Do not call `factory_transition_work_item` and do not call `submit_plan`. The board refuses to move a decision card to Building, Review or Done for an agent, and auto-approved plans do not change that.
- Do not file a docs file or a plan file. The write-up lives in the bead only.

## 1. Read the bead

Call `beads_show` for the bead named in the arguments. Pass `repository` when the project links more than one repository. Read the description, design, notes and dependencies, and the card's feed. The original question is the description's text before `## Decision`; keep it word for word. The three sections may already be there, empty or marked `Open.`: bd requires them when a decision is filed.

If the bead is closed, or is not a `decision`, stop and say so.

## 2. Research the options

Find every option worth considering, including keeping things as they are.

- **The codebase**: the code the decision touches, its history (`git log` on the files involved), and earlier decisions (`beads_list` with `type` `decision` and `status` `open` and `closed`). Follow the codebase's grain.
- **Documentation**: the vendor's own documentation for any library or service involved, at the version the repository uses. Read the security notes as well as the API.
- **The web**, when a tool for it is available.

Compare the options on what matters for this decision: correctness, cost, risk, how much has to change, how it fits what already exists, and what it closes off later. Every claim needs a source you read in this run: a file and line, a page, a command's output. Label anything you could not check as unverified.

## 3. Write the decision into the bead

Call `beads_update` once with `description`, and with `design` and `append_notes` where they help. bd requires these three sections in a decision's description:

```
<the original question, unchanged>

## Decision

The option chosen, in one or two sentences.

## Rationale

Why this option: the evidence, with sources, and the trade-offs accepted.

## Alternatives Considered

- Option B: what it is, and why it was not chosen.
- Option C: ...
```

- **description**: the original question first, unchanged, then the three sections, replacing any empty or placeholder ones. `description` replaces the whole field, so include the question.
- **design**: how the chosen option would be carried out, when that is not obvious from the decision. It is not an implementation plan.
- **append_notes**: what you checked and could not check, and the open questions only a person can answer. Notes are appended, never replaced.

If the evidence does not settle the question, still recommend the option it best supports, and say in the Rationale what would change the answer.

Follow-up work the decision implies is not filed now. Name it in the notes; it is filed after approval.

## 4. Hand off to a person

End the run with a short final message in this conversation:

- the decision in one sentence;
- the main reason;
- anything unverified or open;
- what the person does next: **review the decision in the bead and move the card to Done to approve it**, which closes the bead. To ask for changes, a person leaves feedback on the card and moves it back into Planning (for example to Intake, then Planning). Each entry into Planning runs this skill again; read the feedback in the card's feed and revise the write-up.

Then stop. The card stays in Planning until a person moves it.
