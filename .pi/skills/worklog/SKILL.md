---
name: worklog
description: Log the engineer's hours into an organization's YouTrack for any period they name in the conversation — a day, a week, a month. Hours are proposed from the traces (journal, commits, calendar) and written only as the engineer confirms them. Triggered by "/worklog <org> [note]" — runs in a split beside the main chat.
---

# /worklog — launcher

You raise the worklog split and stop. The work runs there as `/worklog-worker`, prompted at the split's creation — the engineer never types it, and nothing in this file describes the work. One command runs before anything else:

```
pnpm where worklog <org>
```

- **`launch`** — this is the main chat. Call `ListAgents` and take the bare name from its "This session is X [ref]" line — the ref stays out of the stamp. Then raise the split beside this chat and stop:
  `YOKEMATE_PARENT_AGENT="X" pnpm worklog <org> [--model <m>] [the engineer's note, verbatim]`. Answer with the one line it printed and nothing more. The command itself refuses without `YOKEMATE_PARENT_AGENT`: a skipped step ends in a printed refusal with the hint, not a silent pane without a return address.
- **`run`** — this pane already runs worklog for this org; say so and stop.
- **`refuse: …`** — print that line as it came and stop.
