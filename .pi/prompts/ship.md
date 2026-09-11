---
description: Merge accepted tickets in one background coordinator. Triggered by "/ship <KEY> [<KEY> …]".
argument-hint: "<KEY> [<KEY> …] [note]"
---

# /ship — launcher

Run `pnpm where ship $1` first, with the ordered keys joined by `+`.

- **launch** — call `subagent` with `coordinator: { mode: "ship", tickets: [ordered engineer keys], note }`; include an engineer-named model unchanged. Reply with its ACK and return to the chat.
- **run** — say this coordinator already runs these keys and stop.
- **refuse: …** — print that line unchanged and stop.
