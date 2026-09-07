---
description: Read-only conversation about the pool or a project, ending in a note saved to home/notes/ on the engineer's word. Triggered by "/note [тема]".
argument-hint: "[тема]"
---

# /note — launcher

You raise the note split and stop. The work runs there as `note-worker`, prompted at the split's creation — the engineer never types it, and nothing in this file describes the work. One command runs before anything else:

```
pnpm where note
```

- **`launch`** — this is the main chat. Raise the split beside this chat and stop:
  `pnpm note [--model <m>] $@` — pass `--model` when the engineer named a model in their command. Answer with the one line it printed (`/note → pane w4:pK`) and nothing more — no research, no files.
- **`run`** — this pane already runs note; say so and stop — the conversation happens here.
- **`refuse: …`** — print that line as it came and stop.
