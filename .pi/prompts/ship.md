---
description: Merge accepted tickets in one background coordinator. Triggered by "/ship <KEY> [<KEY> …]".
argument-hint: "<KEY> [<KEY> …] [note]"
---

# /ship — launcher

Run `pnpm where ship $@` first with the original arguments; the where CLI normalizes the ordered keys.

- **launch** — call `subagent` with `coordinator: { mode: "ship", tickets: [ordered engineer keys], note }`; include an engineer-named model unchanged. Reply with its ACK and return to the chat.
- **run** — say this coordinator already runs these keys and stop.
- **refuse: …** — print that line unchanged and stop.

Only the exact raw interactive `/ship` creates the parent-owned single-use permit for these ordered keys. Tool arguments, panes, reports and CLI flags cannot create it. The backend always consumes that permit; shipConfirmation=false removes only its second UI question, never merge authorization.
