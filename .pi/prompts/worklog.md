---
description: Log the engineer's hours into an organization's YouTrack for any period they name in the conversation — a day, a week, a month. Hours are proposed from the traces (journal, commits, calendar) and written only as the engineer confirms them. Triggered by "/worklog <org> [note]" — runs in a split beside the main chat.
argument-hint: "<org> [note]"
---

# /worklog — launcher

You raise the worklog split and stop. The work runs there as `worklog-worker`, prompted at the split's creation — the engineer never types it, and nothing in this file describes the work. One command runs before anything else:

```
pnpm where worklog $1
```

- **`launch`** — this is the main chat. Raise the split beside this chat and stop:
  `pnpm worklog $1 [--model <m>] ${@:2}`. Answer with the one line it printed and nothing more.
- **`run`** — this pane already runs worklog for this org; say so and stop.
- **`refuse: …`** — print that line as it came and stop.
