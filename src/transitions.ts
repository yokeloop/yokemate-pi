// The protocol of stage moves. The old rule «one writer: the main chat» is
// retired: the mode where a result is born records it itself — /plan writes
// `planned`, the task tab writes `review`, the review pane writes the
// verdict — and what used to hold on a single writer now holds on four checks
// inside the command: identity by the pane's stamp, a table of legal moves,
// compare-and-set against the current stage, and idempotent repeats. An
// unstamped session is the main chat: every command runs there too, as the
// repair entry.
//
// The message a mode sends to the main chat afterwards is a courtesy: losing
// it costs an unclosed tab, never state.

import type { DatabaseSync } from "node:sqlite";
import type { Stage } from "./db.ts";
import { readGuardPolicy, type GuardPolicy } from "./guard-policy.ts";

export type Via = "stage" | "plan" | "spawn" | "record-report" | "accept" | "accept-rework" | "adopt";

export interface MoveEnv {
  YOKEMATE_MODE?: string;
  YOKEMATE_TICKET?: string;
}

export type From = Stage | "absent";

interface Seat {
  from: From[];
  /** The stamp may carry no ticket — /plan can run before one exists. */
  ticketless?: boolean;
}

interface Rule {
  to: Stage;
  stamped: Record<string, Seat>;
  unstamped: From[];
}

// `scouted` stays for old rows; recording it is the main chat's unstamped
// move alone — /plan goes straight to `planned`.
const SCOUT_FROM: From[] = ["absent", "new", "scouted", "planned"];
const PLAN_FROM: From[] = ["absent", "new", "scouted", "planned"];

const RULES: Record<Via, Rule> = {
  stage: { to: "scouted", stamped: {}, unstamped: SCOUT_FROM },
  plan: {
    to: "planned",
    stamped: { plan: { from: PLAN_FROM, ticketless: true } },
    unstamped: PLAN_FROM,
  },
  // spawn raises tabs, so it runs in the main chat alone; a fresh row (a ticket
  // never queued) is legal only when the caller names the plan outright.
  spawn: { to: "running", stamped: {}, unstamped: ["planned", "running"] },
  "record-report": {
    to: "review",
    stamped: { do: { from: ["running", "review"] } },
    unstamped: ["running", "review"],
  },
  accept: { to: "accepted", stamped: { review: { from: ["review", "accepted"] } }, unstamped: ["review", "accepted"] },
  "accept-rework": {
    to: "planned",
    stamped: { review: { from: ["review", "planned"] } },
    unstamped: ["review", "planned"],
  },
  // adopt rebuilds the review row from observable facts on a machine where
  // /do never ran: the row lands straight in `review`. The review pane calls
  // it itself when the stand is missing; the main chat is the repair entry.
  adopt: {
    to: "review",
    stamped: { review: { from: ["absent", "review"] } },
    unstamped: ["absent", "review"],
  },
};

export type Verdict = { ok: true; repeat: boolean } | { ok: false; refuse: string };

/** Pure decision: may this caller move this ticket out of `current`? */
export function checkMove(
  via: Via,
  env: MoveEnv,
  ticket: string,
  current: From,
  opts: { allowFresh?: boolean; policy?: GuardPolicy } = {},
): Verdict {
  const rule = RULES[via];
  const policy = opts.policy ?? readGuardPolicy();
  const mode = env.YOKEMATE_MODE;
  const seat = mode ? rule.stamped[mode] : undefined;
  if (mode && policy.guards.transitionCaller && !seat) {
    const seats = Object.keys(rule.stamped);
    return { ok: false, refuse: `${via} is not ${mode}'s move — it belongs to ${seats.length ? seats.join("/") : "the main chat alone"}` };
  }
  if (mode && policy.guards.transitionTicket && seat && !seat.ticketless && env.YOKEMATE_TICKET !== ticket)
    return { ok: false, refuse: `this pane is stamped ${env.YOKEMATE_TICKET ?? "nothing"}, not ${ticket} — a mode moves only its own ticket` };
  const base = seat?.from ?? rule.unstamped;
  const from = opts.allowFresh ? [...new Set<From>([...base, "absent", "new"])] : base;
  if (policy.guards.transitionSource && !from.includes(current))
    return { ok: false, refuse: `${ticket} is at ${current}; ${via} moves from ${from.join("/")}` };
  return { ok: true, repeat: current === rule.to };
}

export type MoveOutcome = { ok: true; prev: From; repeat: boolean } | { ok: false; refuse: string };

/**
 * Check and write inside one BEGIN IMMEDIATE transaction, so the stage read
 * for the check cannot go stale before the write lands. `write` is the
 * command's own SQL; it runs only when the check passed.
 */
export function applyMove(
  db: DatabaseSync,
  via: Via,
  env: MoveEnv,
  ticket: string,
  write: (prev: From) => void,
  opts: { allowFresh?: boolean; expected?: From; policy?: GuardPolicy } = {},
): MoveOutcome {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT stage FROM work WHERE ticket = ?").get(ticket) as
      | { stage: Stage }
      | undefined;
    const prev: From = row?.stage ?? "absent";
    if (opts.expected !== undefined && prev !== opts.expected) {
      db.exec("ROLLBACK");
      return { ok: false, refuse: `${ticket} changed from expected ${opts.expected} to ${prev}` };
    }
    const v = checkMove(via, env, ticket, prev, opts);
    if (!v.ok) {
      db.exec("ROLLBACK");
      return v;
    }
    write(prev);
    db.exec("COMMIT");
    return { ok: true, prev, repeat: v.repeat };
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw e;
  }
}
