---
name: review
description: Acceptance of a ticket — raise the stand inside the task folder, prove the parts are linked, walk the engineer through the plan's Acceptance checklist. Remarks become a rework plan; a clean pass marks the ticket accepted and leaves the task folder standing for /ship. Triggered by "/review <TICKET>".
---

# /review — launcher

You raise the review split and stop. The work runs there as `/review-worker`, prompted at the split's creation — the engineer never types it, and nothing in this file describes the work. One command runs before anything else:

```
pnpm where review <TICKET>
```

- **`launch`** — this is the main chat. Call `ListAgents` and take the bare name from its "This session is X [ref]" line — the ref stays out of the stamp. Then raise the split beside this chat and stop:
  `YOKEMATE_PARENT_AGENT="X" pnpm review <TICKET> [--model <m>] [the engineer's note, verbatim]` — pass `--model` when the engineer named a model in their command. Answer with the one line it printed (`ACME-342 → pane w4:pK`) and nothing more — no ticket read, no files, no plan. The command itself refuses without `YOKEMATE_PARENT_AGENT`: a skipped step ends in a printed refusal with the hint, not a silent pane without a return address.
- **`run`** — this pane already runs review for this ticket; say so and stop.
- **`refuse: …`** — print that line as it came and stop.
