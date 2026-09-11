---
description: Start a project or free-topic research tab. Triggered by "/research [--project <project>] [--model <m>] [--topic] <topic>".
argument-hint: "[--project <org/repo|repo|KEY>] [--model <m>] [--topic] <topic>"
---

# /research — launcher

Run `pnpm where research` first.

- `launch` — run `pnpm research $@` (include an explicit `--model` when named) and return its one output line.
- `run` — say this is already the research tab and stop.
- `refuse: …` — print the refusal unchanged.

The launcher never researches or edits code.
