// Record a stage. `scouted` stays for old rows and is the main chat's own
// unstamped move — legal without --force, plan path in the same call
// (`spawn` reads the plan from the row and nothing else records it). The
// command checks the caller's stamp, the legal move and the current stage
// (src/transitions.ts), so a pane that went stale overwrites nothing.
//
// Every other stage is the main chat's repair entry and takes --force: the
// legitimate moves are made by their own commands (`plan`, `spawn`,
// `record-report`, `accept`). A repair writes no outcome line — it fixes
// state, it is not a result.
//
// Usage: pnpm stage ACME-342 scouted [path-to-plan.md]
//        pnpm stage ACME-342 planned --force        # repair, main chat only

import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { dataRoot } from "./data-root.ts";
import { openDb, STAGES, type Stage } from "./db.ts";
import { logMove } from "./move-log.ts";
import { ticketUrl } from "./ticket-url.ts";
import { applyMove, type From, type MoveEnv } from "./transitions.ts";
import { readRuntimeSettings } from "./guard-policy.ts";
import { assertMandatoryBoundary } from "./workflow-boundaries.ts";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DATA = dataRoot(ROOT);

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const argv = process.argv.slice(2).filter((a) => a !== "--");
const force = argv.includes("--force");
const rest = argv.filter((a) => a !== "--force");
const ticket = rest[0] ?? fail(`usage: stage <TICKET> <${STAGES.join("|")}> [plan-path] [--force]`);
try { assertMandatoryBoundary("workflow.target-identity", /^[A-Z][A-Z0-9]*-\d+$/.test(ticket), "invalid stage ticket identity"); }
catch (error) { fail((error as Error).message); }
const stage = rest[1] as Stage;
if (!STAGES.includes(stage)) fail(`unknown stage ${rest[1] ?? ""} — known: ${STAGES.join(", ")}`);
const planAbs = rest[2] ? resolve(rest[2]) : undefined;
if (planAbs && !existsSync(planAbs)) fail(`plan not found: ${planAbs}`);

const env = process.env as MoveEnv;
const settings = (() => { try { return readRuntimeSettings(ROOT); } catch (e) { return fail((e as Error).message); } })();
const db = openDb(join(ROOT, "yokemate.db"));

// A move without a path leaves the recorded plan alone: not every stage comes
// with one, and none of them retracts it. A ticket can reach a stage before it
// ever hit the queue — scouting a fresh ticket is exactly that.
function write(prev: From): void {
  if (prev === "absent") {
    db.prepare("INSERT INTO work (ticket, url, stage, plan) VALUES (?, ?, ?, ?)").run(
      ticket,
      ticketUrl(db, ticket),
      stage,
      planAbs ?? null,
    );
  } else if (planAbs) {
    db.prepare(
      "UPDATE work SET stage = ?, plan = ?, updated_at = datetime('now') WHERE ticket = ?",
    ).run(stage, planAbs, ticket);
  } else {
    db.prepare("UPDATE work SET stage = ?, updated_at = datetime('now') WHERE ticket = ?").run(
      stage,
      ticket,
    );
  }
}

if (stage === "scouted") {
  if (force) fail("--force does not apply to scouted — it is a legal move, let the checks run");
  const out = applyMove(db, "stage", env, ticket, write, { settings });
  if (!out.ok) fail(out.refuse);
  logMove(DATA, ticket, "разведано", planAbs ? `план ${basename(planAbs, ".md")}` : "");
  console.log(
    `${ticket}: ${out.prev} → scouted` +
      (out.repeat ? " (repeat)" : "") +
      (planAbs ? `, plan: ${planAbs}` : ""),
  );
} else {
  // Repair path: unstamped and explicit, loud in the output, silent in the
  // journal — the journal records results, not fixes.
  if (settings.policy.guards.stageCaller && env.YOKEMATE_MODE)
    fail(`${stage} is the main chat's repair — a mode records its result through its own command`);
  if (settings.policy.guards.stageForce && !force) fail(`moving to ${stage} by hand is a repair — add --force`);
  db.exec("BEGIN IMMEDIATE");
  try {
    const prev =
      (db.prepare("SELECT stage FROM work WHERE ticket = ?").get(ticket) as
        | { stage: string }
        | undefined)?.stage ?? "absent";
    write(prev as From);
    db.exec("COMMIT");
    console.log(`${ticket}: forced ${prev} → ${stage}` + (planAbs ? `, plan: ${planAbs}` : ""));
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}
