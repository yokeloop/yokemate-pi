---
name: worklog-worker
description: Internal — raised by pnpm worklog, not typed by the engineer. Log the engineer's hours into an organization's YouTrack for any period they name in the conversation — a day, a week, a month. Hours are proposed from the traces (journal, commits, calendar) and written only as the engineer confirms them.
---

# /worklog — hours into the tracker

Time reaches the tracker from the traces the work left, not from memory. The engineer names the period in the conversation — «залогаем 15 августа», «за прошлую неделю», «за август» — you show what it contains per ticket, they correct, you write what they confirm. Nothing is logged without their word.

## Where this runs

You are the worker: the split raised by `pnpm worklog` is prompted with this skill — the engineer never types it. One command runs before anything else:

```
pnpm where worklog <org>
```

- **`run`** — this is the worklog split. Do the work below.
- **`launch`** — this is the main chat: the work does not happen here. Answer «type /worklog <org>» and stop.
- **`refuse: …`** — print that line as it came and stop.

## Traces

For the period the engineer named:

- `home/journal/YYYY-MM.md` — the outcome lines the commands append («дата тикет запланировано/сделано/принято»; в старых записях — «загрилено») and the narrative entries; the texts for the tracker start here.
- Commits in the org's clones (`projects/<org>/`) and its task worktrees (`work/<TICKET>/`): `git log --all --since "<from>" --until "<to>"` — the ticket key in the branch or the message says whose commit it is.
- The calendar for the meetings (Google Calendar). Keep only meetings the engineer took part in; the calendar not reachable from this split, or an event unclear — ask the engineer, do not guess.

## Layout and confirmation

- One row per ticket and work type: the hours you propose from the traces, the evidence in one line (commits, journal lines, meeting), the text for the tracker. Types are the project's own («Разработка», «Тестирование», «Встреча»).
- The text names what was concretely done and the PR («Секции шага по разделителю, кит 1.41.0, PR #34») — never the kitchen («прогнали гриль и три итерации ревью»).
- The engineer corrects the layout and adds what left no trace. A disagreement is named out loud once — «по этому тикету следов нет, а ты называешь три часа» — then their word is written: they see the whole picture and they answer for the report.

## Write

Confirmed rows one at a time through `log_work` on `youtrack-<org>`: issueId, durationMinutes, date, workType, description. No `workItemAttributes` — the reporting period fills itself. Name the target in the reply: «записано в youtrack-acme-eu». The tracker is the only record — nothing is written anywhere else.

## Boundaries

- The tracker gets time entries and nothing else: no transitions, no comments, no field edits.
- Clones and worktrees are read-only here.
- yokemate's own work (`yokeloop`) bills nobody unless the engineer says otherwise.
- This split is not closed for you: say the period is written and wait — the engineer may name the next one, and only they know the session is over.
