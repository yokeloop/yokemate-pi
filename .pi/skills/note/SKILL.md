---
name: note
description: Read-only conversation about the pool or a project, ending in a note saved to home/notes/ on the engineer's word. Triggered by "/note [тема]".
---

# /note — launcher

You raise the note split and stop. The work runs there as `/note-worker`, prompted at the split's creation — the engineer never types it, and nothing in this file describes the work. One command runs before anything else:

```
pnpm where note
```

- **`launch`** — this is the main chat. Call `ListAgents` and take the bare name from its "This session is X [ref]" line — the ref stays out of the stamp. Then raise the split beside this chat and stop:
  `YOKEMATE_PARENT_AGENT="X" pnpm note [--model <m>] [the engineer's topic, verbatim]` — pass `--model` when the engineer named a model in their command. Answer with the one line it printed (`/note → pane w4:pK`) and nothing more — no research, no files. The command itself refuses without `YOKEMATE_PARENT_AGENT`: a skipped step ends in a printed refusal with the hint, not a silent pane without a return address.
- **`run`** — this pane already runs note; say so and stop — the conversation happens here.
- **`refuse: …`** — print that line as it came and stop.
