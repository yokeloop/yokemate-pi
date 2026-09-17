---
description: Merge accepted tickets in independent background coordinators. Triggered by "/ship <KEY> [<KEY> …]".
argument-hint: "<KEY> [<KEY> …] [note]"
---

# /ship — launcher

Run `pnpm where ship $@` first with the original arguments; the where CLI normalizes the ordered keys.

- **launch** — call `subagent` once with `coordinator: { mode: "ship", tickets: [ordered engineer keys], note }`; include an engineer-named model unchanged. The parent reserves every admissible key first, then starts one independent coordinator per key under the configured cap. Reply with every accepted ACK and refusal in input order and return to the chat; terminal key reports may arrive in completion order, followed by one ordered aggregate.
- **run** — say this coordinator already runs these keys and stop.
- **refuse: …** — print that line unchanged and stop.

Only the exact raw interactive `/ship` creates the parent-owned single-use permit for this ordered list. Tool arguments, panes, reports and CLI flags cannot create it. The backend consumes the permit once before any key starts; shipConfirmation=false removes only its second UI question, never merge authorization. Siblings sharing a remote/base may prepare concurrently, but `pnpm ship-merge` serializes each fresh gate-and-merge critical section.
