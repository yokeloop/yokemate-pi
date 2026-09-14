---
description: Compatibility alias for /plan --split only. Triggered by "/split plan <arguments>".
argument-hint: "plan [arguments]"
---

# /split — compatibility launcher

The first word `$1` must be `plan`; otherwise say «use /<mode> --split» and stop. This alias supports no other modes. Prefer `/plan --split`.

Ticket or problem: --split ${@:2}

Run `pnpm where plan [KEY …]` before anything else, with every key before the first `--` in the input above in input order, excluding control values; use no keys for a problem statement. Preserve that input as the original arguments. The alias control stays before the whole user tail so a user's `--` cannot turn it into text.

- `launch` only with an explicit `--split` before the first `--` — run `pnpm split plan <original arguments>`, preserving input order, model controls and the literal tail unchanged; return its one output line and stop. An explicitly named launch model becomes `--model <m>` before the separator.
- `run` — this mode surface already runs plan; say so and stop.
- `refuse: …` — print the refusal unchanged and stop.

The launcher requires explicit split; ordinary `/plan` stays inline. The engineer closes the conversational split. No planning work runs in this launcher.
