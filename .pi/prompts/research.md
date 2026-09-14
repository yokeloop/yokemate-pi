---
description: Start a project or free-topic research tab. Triggered by "/research [--split] [--project <project>] [--model <m>] [--topic] <topic>".
argument-hint: "[--split] [--project <org/repo|repo|KEY>] [--model <m>] [--topic] <topic>"
---

# /research — launcher

Open a new tab by default; only `--split` before the first `--` opens a split of the calling pane. The work runs there as `research-worker`; the engineer closes the conversational mode surface.

Run `pnpm where research` before anything else.

- `launch` — run `pnpm research $@` and return its one output line, then stop. Preserve argument order and the literal tail; an explicitly named model becomes `--model <m>` before the separator.
- `run` — this mode surface already runs research; say so and stop.
- `refuse: …` — print the refusal unchanged and stop.

The launcher does no worker work, reads no tickets and edits no files.
