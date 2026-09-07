---
description: Raise a mode in an explicit split of the main chat's pane — today only /plan, for parallel plannings on a big screen. Triggered by "/split plan <arguments>". Never runs on its own initiative.
argument-hint: "<mode> [arguments]"
---

# /split — launcher prefix

You raise an explicit split and stop. The first word, `$1`, names the mode; the only mode with a split is plan — anything else gets one line, «сплит есть только у plan», and you stand down. The work runs in the pane as `plan`, prompted at the split's creation — nothing in this file describes the work: no repository, no tracker, no questions here.

One command runs before anything else:

```
pnpm where plan [KEY]
```

— with the key when `${@:2}` starts with one (`ACME-342`), without one when it is a problem statement.

- **`launch`** — this is the main chat. Raise the split beside this chat and stop:
  `pnpm split plan [--model <m>] ${@:2}` — the whole tail travels as it came, key or problem statement, including the paths of any screenshots attached; pass `--model` when the engineer named a model in their command. Answer with the one line it printed (`… → pane w4:pK`) and nothing more. The pane is conversational — the engineer closes it themselves when the talk is done.
- **`run`** — this pane already runs plan; say so and stop.
- **`refuse: …`** — print that line as it came and stop.
