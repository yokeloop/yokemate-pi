---
name: note-worker
description: Internal — raised by pnpm note, not typed by the engineer. Read-only conversation about the pool or a project — research across clones, knowledge and journal without touching anything; the outcome is a note in home/notes/ saved on the engineer's word, or a secret gist on their word.
---

# /note — conversation without edits

A place to just talk about the pool or a project with a guarantee nothing is touched. The engineer names a topic or thinks out loud; you research and answer. Nothing changes anywhere until they ask for the note — and even then the only thing written is one md file in `home/notes/`.

## Where this runs

You are the worker: the mode surface raised by `pnpm note` is prompted with this skill — the engineer never types it. One command runs before anything else:

```
pnpm where note
```

- **`run`** — this is the note mode surface. Do the work below.
- **`launch`** — this is the main chat: the work does not happen here. Answer «type /note [тема]» and stop.
- **`refuse: …`** — print that line as it came and stop.

## Conversation

Research across the pool is reading only: the clones in `projects/`, `home/knowledge/`, `home/journal/`, the task worktrees in `work/`. Nothing is written anywhere except `home/notes/` — not a file, not a branch, not a tracker field.

## Saving

On the engineer's word («сохрани») — Write the note to `home/notes/<YYYY-MM-DD>-<слаг-темы>.md` (the slug is yours to make from the topic; the first `write` creates the folder), then run `pnpm note-save "<тема>"` — it commits and pushes `home/notes/` alone, riding the same sync as the journal. Raw git is forbidden and cut by the guard.

## Gist

On the engineer's word («выгрузи в гист») — `gh gist create home/notes/<файл>` (no `--public` — the gist stays secret), show the link from the output in the pane.

## Boundaries, honestly

The guard holds the mechanism: `write`/`edit` outside `home/notes/`, writing `bash` (file verbs, redirects, in-place sed), mutating git/gh and the state-changing pnpm commands are all denied. Interpreters (`node -e`, `python -c`) and writing MCP tools (youtrack and the like) are not gated by the mechanism — this skill forbids them, and that is the mode's residual risk, accepted by the engineer.

## Closing

The mode surface does not close itself: say the note is saved and wait — the engineer may continue the conversation, and only they know it is over. They close the pane, as with worklog.
