---
description: Log the engineer's hours into an organization's YouTrack for any period they name in the conversation — a day, a week, a month. Hours are proposed from the traces (journal, commits, calendar) and written only as the engineer confirms them. Triggered by "/worklog [--split] <org> [note]" — runs in a split beside the main chat.
argument-hint: "[--split] <org> [note]"
---

# /worklog — launcher

Open a new tab by default; only `--split` before the first `--` opens a split of the calling pane. The work runs there as `worklog-worker`; the engineer closes the conversational mode surface.

Before anything else run `pnpm where worklog <org>`, using the first ordinary word before `--`, not a control or its value. Preserve the full input separately.

- `launch` — run `pnpm worklog $@` and return its one output line, then stop. Preserve argument order and the literal tail; an explicitly named model becomes `--model <m>` before the separator.
- `run` — this mode surface already runs worklog; say so and stop.
- `refuse: …` — print the refusal unchanged and stop.

The launcher does no worker work, reads no tickets and edits no files.
