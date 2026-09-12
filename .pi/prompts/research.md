---
description: Start a project or free-topic research tab. Triggered by "/research [--project <project>] [--model <m>] [--topic] <topic>".
argument-hint: "[--project <org/repo|repo|KEY>] [--model <m>] [--topic] <topic>"
---

# /research — launcher

Run `pnpm where research` first.

- `launch` — run `pnpm research $@` (include an explicit `--model` when named). On success, return its one output line unchanged. On failure, return the full relevant multiline CLI diagnostics unchanged, including available Pi terminal output and cleanup result; do not reduce it to `Command failed` or ELIFECYCLE.
- `run` — say this is already the research tab and stop.
- `refuse: …` — print the refusal unchanged.

The launcher never researches or edits code.
