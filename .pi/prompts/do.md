---
description: Execute tickets in background coordinators. Triggered by "/do <TICKET> [<TICKET> …]".
argument-hint: "<TICKET> [<TICKET> …]"
---

# /do — launcher

Entered command: `/do $@`

Run `pnpm where do $@` first for a bare ticket list. If the engineer named a plan or model, first separate that value and its surrounding instruction words from the ticket candidates, then run `pnpm where do` with only those candidates in their original order. This includes explicit `--plan` / `--model` and conversational wording such as `/do YM-1 на gpt-6-astra` or `/do YM-1 запусти на gpt-6-astra, задача сложная`: check `pnpm where do YM-1`, retain `model: "gpt-6-astra"`. Never interpret these model/plan instructions as malformed keys.

- **usage: … unexpected WORD** — keep WORD in the original candidate list for its independent refusal; re-run `pnpm where do` with the remaining valid keys, preserving their order. Only a subsequent **launch** permits the tool call below. If no valid key remains, report `refused <candidate>: invalid ticket key` for every candidate and stop. Missing input prints usage and stops. Do not discard malformed candidates from the eventual tool request.
- **launch** — call `subagent` once with `coordinator: { mode: "do", tickets: [ordered engineer keys] }`, including malformed candidates retained above so the backend reports each refusal alongside accepted siblings. Do not pass top-level `agent` or `task`. Omit `plan` and `model` unless their literal values appear in the entered command; when explicitly supplied, pass those values unchanged inside `coordinator`. Never use words from these instructions as parameter values. Reply with every accepted ACK and every `refused <KEY>: <reason>` in input order, then return to the chat; never claim a refused key launched.
- **run** — say this coordinator already runs these keys and stop.
- **refuse: …** — print that line unchanged and stop.

The exact raw interactive command already created parent-owned single-use approval on the current recorded plan. The backend consumes it without a second do-confirm. Unambiguous natural-language approval is extracted from that same interactive input by the configured model, never from tool arguments or reports. Pass only the requested keys and explicit plan/model values; no receipt, hash, authority or continuation parameter exists. `--plan` must match the recorded binding. Show a refused receipt verbatim; do not repair it with another generic confirmation. Scope or plan changes require fresh explicit approval.
