---
description: Take existing tickets or a problem to ready plans in a new tab by default; --split opens beside the calling chat. Triggered by "/plan [--split] <KEY …|problem>".
argument-hint: "[--split] <KEY …|problem>"
---

# /plan — launcher

Ticket or problem: $@

Run `pnpm where plan [KEY …]` first, with every key before the first `--` in input order (excluding control values), or no keys for a problem statement. Preserve the full input separately.

- `launch` — run `pnpm split plan $@` and return its one output line, then stop. A new tab is the default; only `--split` before `--` opens a split of the calling pane. Preserve argument order and the literal tail; an explicitly named model becomes `--model <m>` before the separator.
- `run` — read `.pi/skills/plan/SKILL.md` in full and follow it in this mode surface.
- `refuse: …` — print the refusal unchanged and stop.

No tracker reads, reconnaissance or planning in the main chat. The engineer closes the conversational surface.
