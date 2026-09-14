---
description: Take existing tickets or a problem to ready plans inline in this chat; --split explicitly opens beside it. Triggered by "/plan [--split] <KEY …|problem>".
argument-hint: "[--split] <KEY …|problem>"
---

# /plan — inline by default

Ticket or problem: $@

Run `pnpm where plan [KEY …]` first, with every key before the first `--` in input order (excluding control values), or no keys for a problem statement. Preserve the full input separately as the original arguments. Only `--split` before the first `--`, outside a `--model` value, is a surface control; the literal suffix is note/problem context, never planning keys or launch controls.

- `launch` without an explicit `--split` before the first `--` — read `.pi/skills/plan/SKILL.md` in full and continue inline in this same chat. Questions stay here; reconnaissance and plan-writing use scout/writer subagents. Do not run a launcher.
- `launch` only with an explicit `--split` before the first `--` — run `pnpm split plan <original arguments>`, preserving input order, model controls and the literal tail unchanged; return its one output line and stop. An explicitly named launch model becomes `--model <m>` before the separator. The engineer closes this explicit split.
- `run` — read `.pi/skills/plan/SKILL.md` in full and follow it here, using the stamped identity.
- `refuse: …` — print the refusal unchanged and stop.

Inline planning uses the model of the current main Pi chat. `--model` is a launch control only for explicit split. Inline completion reports here, without a parent report or a surface to close.
