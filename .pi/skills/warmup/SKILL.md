---
name: warmup
description: Print the pool digest on demand — queue, live work/ folders, journal tail — the same one the SessionStart hook injects at session start. Triggered by "/warmup". Runs inline in the main chat, no pane, no worker.
---

# /warmup — the pool digest on demand

Run `pnpm warmup` and print its output to the chat as is. That is the whole command: no pane, no worker, no database write.

The digest is the local projection — `yokemate.db`, `work/`, the journal tail — deliberately without a tracker sync; `pnpm queue` and `pnpm on-me` sync at the moment of action.

## When the engineer asks deeper

The digest is an index, not the memory. «Что было по ACME-358?» — read the full entries in `home/journal/YYYY-MM.md` and the plans and reports in `home/knowledge/<org>/<project>/ai/<slug>/` by the paths the entries name. Never retell from the digest or from memory what a file states.
