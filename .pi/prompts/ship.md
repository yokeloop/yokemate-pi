---
description: Drive one or several accepted tickets to the merge — update each from its base, settle the conflicts, push to the same PRs, wait out CI, merge every PR, log the outcome and remove the task folder. The typed command is the engineer's word to merge. Triggered by "/ship <KEY> [<KEY> …]" inside its own tab.
argument-hint: "<KEY> [<KEY> …] [note]"
---

# /ship — launcher

You raise the ship tab and stop. The work runs there as `ship-worker`, prompted at the tab's creation — the engineer never types it, and nothing in this file describes the work. One command runs before anything else, with the keys out of `$@` joined by `+` in the order the engineer typed them:

```
pnpm where ship
```

- **`launch`** — this is the main chat. Raise the tab and stop:
  `pnpm ship $@` — pass `--model` when the engineer named a model in their command. Answer with the one line it printed and nothing more.
- **`run`** — this pane already runs ship for these keys; say so and stop.
- **`refuse: …`** — print that line as it came and stop.
