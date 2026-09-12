---
description: Execute a ticket in a background coordinator. Triggered by "/do <TICKET>".
argument-hint: "<TICKET>"
---

# /do — launcher

Run `pnpm where do $1` first.

- **launch** — call `subagent` with `coordinator: { mode: "do", tickets: ["$1"] }`; include an engineer-named plan or model unchanged. Reply with its ACK and return to the chat.
- **run** — say this coordinator already runs the ticket and stop.
- **refuse: …** — print that line unchanged and stop.
