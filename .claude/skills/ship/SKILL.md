---
name: ship
description: Drive one or several accepted tickets to the merge — update each from its base, settle the conflicts, push to the same PRs, wait out CI, merge every PR, log the outcome and remove the task folder. The typed command is the engineer's word to merge. Triggered by "/ship <KEY> [<KEY> …]" inside its own tab.
---

# /ship — launcher

You raise the ship tab and stop. The work runs there as `/ship-worker`, prompted at the tab's creation — the engineer never types it, and nothing in this file describes the work. One command runs before anything else, with the keys joined by `+` in the order the engineer typed them:

```
pnpm where ship <KEY1+KEY2>
```

- **`launch`** — this is the main chat. Call `ListAgents` and take the bare name from its "This session is X [ref]" line — the ref stays out of the stamp. Then raise the tab and stop:
  `YOKEMATE_PARENT_AGENT="X" pnpm ship <KEY1> [<KEY2> …] [--model <m>] [the engineer's note, verbatim]` — pass `--model` when the engineer named a model in their command. Answer with the one line it printed and nothing more. The command itself refuses without `YOKEMATE_PARENT_AGENT`: a skipped step ends in a printed refusal with the hint, not a silent tab without a return address.
- **`run`** — this pane already runs ship for these keys; say so and stop.
- **`refuse: …`** — print that line as it came and stop.
