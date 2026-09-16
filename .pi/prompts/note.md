---
description: Read-only conversation about the pool or a project, ending in a note saved to home/notes/ on the engineer's word. Triggered by "/note [--split] [тема]".
argument-hint: "[--split] [тема]"
---

# /note — launcher

Open a new tab by default; only `--split` before the first `--` opens a split of the calling pane. The work runs there as `note-worker`; the engineer closes the conversational mode surface.

Run `pnpm where note` before anything else.

- `launch` — run `pnpm note $@` and return its one output line, then stop. Preserve argument order and the literal tail; an explicitly named model becomes `--model <m>` before the separator.
- `run` — this mode surface already runs note; say so and stop.
- `refuse: …` — print the refusal unchanged and stop.

The launcher does no worker work, reads no tickets and edits no files.
