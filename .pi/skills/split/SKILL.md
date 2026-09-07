---
name: split
description: Raise a mode in an explicit split of the main chat's pane — today only /plan, for parallel plannings on a big screen. Triggered by "/split plan <arguments>". Never runs on its own initiative.
---

# /split — launcher prefix

You raise an explicit split and stop. The first word of the arguments names the mode; the only mode with a split is plan — anything else gets one line, «сплит есть только у plan», and you stand down. The work runs in the pane as `/plan`, prompted at the split's creation — nothing in this file describes the work: no repository, no tracker, no questions here.

One command runs before anything else:

```
pnpm where plan [KEY]
```

— with the key when the arguments after `plan` start with one (`ACME-342`), without one when they are a problem statement.

- **`launch`** — this is the main chat. Call `ListAgents` and take the bare name from its "This session is X [ref]" line — the ref stays out of the stamp. Then raise the split beside this chat and stop:
  `YOKEMATE_PARENT_AGENT="X" pnpm split plan [--model <m>] <the arguments after plan, verbatim>` — the whole tail travels as it came, key or problem statement, including the paths of any screenshots attached; pass `--model` when the engineer named a model in their command. Answer with the one line it printed (`… → pane w4:pK`) and nothing more. The command itself refuses without `YOKEMATE_PARENT_AGENT`: a skipped step ends in a printed refusal with the hint, not a silent pane without a return address. The pane is conversational — the engineer closes it themselves when the talk is done.
- **`run`** — this pane already runs plan; say so and stop.
- **`refuse: …`** — print that line as it came and stop.
