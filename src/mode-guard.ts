// Where am I? (second half of R4.21). A mode skill is one file that can be
// entered two ways: the engineer types `/review ACME-342` in the main chat, or
// the mode's own pane was raised and prompted with the same line. The skill
// must do different things in each case, and cwd cannot tell them apart —
// `mode-tab.ts` runs review and worklog from the yokemate root, where the
// main chat already sits.
//
// The pane is raised with `herdr tab create --env`, so the mode and its ticket
// are in the environment of everything inside it. The main chat has neither.
//
// Usage: pnpm where <mode> <TICKET>   → prints `launch`, `run`, or `refuse: …`
//        pnpm where do|ship <KEY> [<KEY> …]|<KEY1+KEY2>
//        pnpm where plan [KEY …]        → /plan can run before a ticket exists

import { readRuntimeSettings, type RuntimeSettings } from "./guard-policy.ts";
import { assertMandatoryBoundary } from "./workflow-boundaries.ts";
import { parseKeyList, parseShipArgs } from "./ship-args.ts";

export const MODES = ["plan", "review", "do", "ship", "worklog", "note", "research"] as const;

/** Modes that run before a ticket exists, so their pane may carry no ticket. */
export const TICKETLESS: readonly Mode[] = ["plan", "note", "research"];
export type Mode = (typeof MODES)[number];

export type Decision =
  | { kind: "launch" }                    // main chat: raise the tab, say one line, stop
  | { kind: "run" }                       // the mode's own tab: do the work
  | { kind: "refuse"; reason: string };   // someone else's tab

export interface ModeEnv {
  YOKEMATE_MODE?: string;
  YOKEMATE_TICKET?: string;
}

/**
 * No environment at all means the main chat — the only session nobody stamped.
 * A stamp that matches is the mode's own tab. A stamp that does not is the tab
 * of another ticket or another mode: doing the work there would write one
 * ticket's plan while wearing another ticket's name.
 */
export function decide(env: ModeEnv, mode: Mode, ticket?: string, settings: RuntimeSettings = readRuntimeSettings()): Decision {
  const ticketParts = ticket ? ticket.split(mode === "plan" ? " " : mode === "do" || mode === "ship" ? "+" : "\0") : [];
  assertMandatoryBoundary("workflow.target-identity", MODES.includes(mode) && ticketParts.every((part) => /^[A-Z][A-Z0-9]*-\d+$/.test(part)), "invalid mode target identity");
  const { policy } = settings;
  const here = env.YOKEMATE_MODE;
  if (!here) return { kind: "launch" };
  // A ticketless mode matches on the mode alone — both sides carry no key.
  if (here === mode && (env.YOKEMATE_TICKET ?? "") === (ticket ?? "")) return { kind: "run" };
  if (!policy.guards.modeOwnership) return { kind: "launch" };
  const asked = ticket ? `${mode} ${ticket}` : mode;
  return {
    kind: "refuse",
    reason:
      `this tab is ${here} ${env.YOKEMATE_TICKET ?? "?"}, not ${asked} — ` +
      `ask for ${asked} in the main chat instead`,
  };
}

if (import.meta.filename === process.argv[1]) {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const mode = argv[0] as Mode;
  const parsed = parseKeyList(argv.slice(1), true);
  if (mode === "do") {
    for (let index = 0; index < parsed.tail.length; index += 1) {
      const word = parsed.tail[index];
      if ((word === "--plan" || word === "--model") && parsed.tail[index + 1]) { index += 1; continue; }
      console.error(`usage: where do <KEY> [<KEY> …] — unexpected ${word}`);
      process.exit(1);
    }
    if (!parsed.keys.length) {
      console.error("usage: where do <KEY> [<KEY> …]");
      process.exit(1);
    }
  }
  const ticket = mode === "plan" ? parsed.keys.join(" ") : mode === "do" ? parsed.keys.join("+") : mode === "ship" ? parseShipArgs(argv.slice(1), true).ticket : argv[1];
  if (!MODES.includes(mode) || (!ticket && !TICKETLESS.includes(mode))) {
    console.error(`usage: where <${MODES.join("|")}> <TICKET>`);
    process.exit(1);
  }
  let d: Decision;
  try { d = decide(process.env as ModeEnv, mode, ticket); }
  catch (error) { console.error((error as Error).message); process.exit(1); }
  console.log(d.kind === "refuse" ? `refuse: ${d.reason}` : d.kind);
  process.exit(d.kind === "refuse" ? 1 : 0);
}
