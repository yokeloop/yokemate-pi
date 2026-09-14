---
description: Compatibility alias for /plan --split only. Triggered by "/split plan <arguments>".
argument-hint: "plan [arguments]"
---

# /split — compatibility launcher

The first word `$1` must be `plan`; otherwise say «use /<mode> --split» and stop. This alias supports no other modes. Prefer `/plan --split`.

Run `pnpm where plan [KEY …]` before anything else, with every key before the first `--` in `${@:2}` in input order, excluding control values; use no keys for a problem statement.

- `launch` — run `pnpm split plan --split ${@:2}`, return its output lines and stop. The alias control stays before the whole user tail so a user's `--` cannot turn it into text. Pass any explicitly named model before that separator too.
- `run` — this mode surface already runs plan; say so and stop.
- `refuse: …` — print the refusal unchanged and stop.

The same launcher defaults to a tab without `--split`. The engineer closes the conversational surface. No planning work runs in this launcher.
