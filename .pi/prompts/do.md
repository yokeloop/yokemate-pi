---
description: Execute tickets in a background coordinator. Triggered by "/do <TICKET> [<TICKET> …]".
argument-hint: "<TICKET> [<TICKET> …]"
---

# /do — launcher

Entered command: `/do $@`

Run `pnpm where do $@` first.

- **launch** — call `subagent` once with `coordinator: { mode: "do", tickets: [ordered engineer keys] }`. Do not pass top-level `agent` or `task`. Omit `plan` and `model` unless their literal values appear in the entered command; when explicitly supplied, pass those values unchanged inside `coordinator`. Never use words from these instructions as parameter values. Reply with every accepted ACK and every `refused <KEY>: <reason>` in input order, then return to the chat; never claim a refused key launched.
- **run** — say this coordinator already runs these keys and stop.
- **refuse: …** — print that line unchanged and stop.
