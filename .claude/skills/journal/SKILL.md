---
name: journal
description: Append a concise, newest-first entry about the session's real work to the pool-wide journal, one file per month, each entry naming its project. Triggered by "/journal", and written by the main chat itself as part of its reaction to a mode's courtesy message.
---

# /journal — record what happened

One journal for the whole pool: `<yokemate>/journal/YYYY-MM.md`, newest entry on top.

## When it writes itself

The main chat appends the narrative entry as part of its reaction to a mode's courtesy message — in the same turn as `pnpm close-mode do|ship <TICKET>` and as the reaction to an acceptance outcome. The material is the courtesy message itself plus the plan or report at the paths it names; the entry follows the format and rules below. The engineer types nothing for this — that is why the warmup digest at session start is always fresh.

Manual `/journal` stays for outcomes outside a stage move: conversations, decisions with no ticket, dead ends worth recording.

## Entry format

```markdown
## YYYY-MM-DD — <org>/<project> — <TICKET or "no ticket">

- what was actually done, one line per real outcome
- decisions made, each with its why in the same line when a future reader would ask
- links: PRs, plans, ADRs, reports in knowledge/<org>/<project>/ai/<slug>/
```

## Rules

- Record **real outcomes only**: code that landed, plans that closed, decisions that were made. No process narration, no intentions, no "discussed X".
- A dead end that cost real time is an outcome too — one line naming what was tried and why it failed, so nobody walks it again.
- Write for retrieval: name tickets, files and the fix so a search months later finds the entry — the journal answers «что мы делали и почему». Reference existing artifacts by path instead of retelling them.
- Fridge-list tone: short lines, no essay. Written in the same session, while the details are still cheap.
- Multiple projects touched in one session → one entry per project, same date.
- Create the month file when it does not exist. Never rewrite past entries.
