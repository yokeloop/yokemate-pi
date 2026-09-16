---
description: Acceptance of a ticket — raise the stand inside the task folder, prove the parts are linked, walk the engineer through the plan's Acceptance checklist. Remarks become a rework plan; a clean pass marks the ticket accepted and leaves the task folder standing for /ship. Triggered by "/review [--split] <TICKET>".
argument-hint: "[--split] <TICKET> [note]"
---

# /review — launcher

Open a new tab by default; only `--split` before the first `--` opens a split of the calling pane. The work runs there as `review-worker`; the engineer closes the conversational mode surface.

Before anything else run `pnpm where review <ticket>`, using the first ordinary word before `--`, not a control or its value. Preserve the full input separately.

- `launch` — run `pnpm review $@` and return its one output line, then stop. Preserve argument order and the literal tail; an explicitly named model becomes `--model <m>` before the separator.
- `run` — this mode surface already runs review; say so and stop.
- `refuse: …` — print the refusal unchanged and stop.

The launcher does no worker work, reads no tickets and edits no files.
