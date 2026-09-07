---
description: Acceptance of a ticket — raise the stand inside the task folder, prove the parts are linked, walk the engineer through the plan's Acceptance checklist. Remarks become a rework plan; a clean pass marks the ticket accepted and leaves the task folder standing for /ship. Triggered by "/review <TICKET>".
argument-hint: "<TICKET> [note]"
---

# /review — launcher

You raise the review split and stop. The work runs there as `review-worker`, prompted at the split's creation — the engineer never types it, and nothing in this file describes the work. One command runs before anything else:

```
pnpm where review $1
```

- **`launch`** — this is the main chat. Raise the split beside this chat and stop:
  `pnpm review $1 [--model <m>] ${@:2}` — pass `--model` when the engineer named a model in their command. Answer with the one line it printed (`ACME-342 → pane w4:pK`) and nothing more — no ticket read, no files, no plan.
- **`run`** — this pane already runs review for this ticket; say so and stop.
- **`refuse: …`** — print that line as it came and stop.
