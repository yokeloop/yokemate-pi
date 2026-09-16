---
description: Start a project or free-topic research tab. Triggered by "/research [--split] [--project <project>] [--model <m>] [--topic] <topic>".
argument-hint: "[--split] [--project <org/repo|repo|KEY>] [--model <m>] [--topic] <topic>"
---

# /research — launcher

Open a new tab by default; only `--split` before the first `--` opens a split of the calling pane. The work runs there as `research-worker`; the engineer closes the conversational mode surface.

Run `pnpm where research` before anything else.

- `launch` — run `pnpm research $@`. Preserve argument order and the literal tail; an explicitly named model becomes `--model <m>` before the separator. On success, return its one output line unchanged. On failure, return the full relevant multiline CLI diagnostics unchanged, including available Pi terminal output and cleanup result; do not reduce it to `Command failed` or ELIFECYCLE. Then stop.
- `run` — this mode surface already runs research; say so and stop.
- `refuse: …` — print the refusal unchanged and stop.

The launcher does no worker work, reads no tickets and edits no files.
