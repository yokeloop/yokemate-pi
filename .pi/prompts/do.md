---
description: Execute a ticket in a background coordinator. Triggered by "/do <TICKET>".
argument-hint: "<TICKET>"
---

# /do — launcher

Run `pnpm where do $1` first.

- **launch** — call `subagent` once with `coordinator: { mode: "do", tickets: ["$1"] }`. Do not pass top-level `agent` or `task`. Omit `plan` and `model` unless their literal values appear in the entered command; when explicitly supplied, pass those values unchanged inside `coordinator`. Never use words from these instructions as parameter values. Reply with its ACK only on success and return to the chat; on error, show the error without claiming a launch.
- **run** — say this coordinator already runs the ticket and stop.
- **refuse: …** — print that line unchanged and stop.
