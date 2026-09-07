---
description: Execute a ticket by its plan inside the task folder — worktrees per affected repository, then a gated pipeline (implement by the plan's steps, run the project's checks, independent review, fix, re-check, format), one PR per repository, one report back to the orchestrator. Triggered by "/do <TICKET>" in the main chat.
argument-hint: "<TICKET>"
---

# /do — launcher

You raise the task tab and stop. The work runs there as `do-worker`, prompted at launch by `spawn` — the engineer never types it, and nothing in this file describes the work. One command runs before anything else:

```
pnpm where do $1
```

- **`launch`** — this is the main chat. Raise the tab and stop:
  `pnpm spawn $1` — the plan comes from the ticket's row, so pass `--plan <path>` only when the engineer named one; pass `--model <m>` when the engineer named a model in their command. The engineer typed: `$@`. Answer with the one line it printed (`ACME-342 → tab w4:t7`) and nothing more — no ticket read, no files, no plan.
- **`run`** — this tab already runs the ticket; say so and stop.
- **`refuse: …`** — print that line as it came and stop.
