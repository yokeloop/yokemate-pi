// Record that a ticket has a ready plan: stage → planned. The /plan flow runs
// this itself — a stamped /plan pane carries the mode, with or without a
// ticket (it can run before one exists), and the unstamped main chat is both
// the inline /plan and the repair entry. The command checks the stamp, the
// legal move and the current stage (src/transitions.ts).
//
// Usage: pnpm plan ACME-347 home/knowledge/acme/acme-ui-kit/ai/<slug>/<slug>-plan.md

import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { dataRoot } from "./data-root.ts";
import { openDb } from "./db.ts";
import { syncPush } from "./git-sync.ts";
import { logMove } from "./move-log.ts";
import { ticketUrl } from "./ticket-url.ts";
import { applyMove, type MoveEnv } from "./transitions.ts";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DATA = dataRoot(ROOT);

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const argv = process.argv.slice(2).filter((a) => a !== "--");
const ticket = argv[0] ?? fail("usage: plan <TICKET> <path-to-plan.md>");
const planPath = argv[1] ?? fail("usage: plan <TICKET> <path-to-plan.md>");
const planAbs = resolve(planPath);
if (!existsSync(planAbs)) fail(`plan not found: ${planAbs}`);

const db = openDb(join(ROOT, "yokemate.db"));
// The plan names the repositories, and there can be several — the row does not
// pick one. It records that a plan exists and where it lies.
const out = applyMove(db, "plan", process.env as MoveEnv, ticket, () => {
  db.prepare(
    `INSERT INTO work (ticket, url, stage, plan)
     VALUES (?, ?, 'planned', ?)
     ON CONFLICT (ticket) DO UPDATE SET stage = 'planned', plan = excluded.plan,
       updated_at = datetime('now')`,
  ).run(ticket, ticketUrl(db, ticket), planAbs);
});
if (!out.ok) fail(out.refuse);

logMove(DATA, ticket, "запланировано", `план ${basename(planAbs, ".md")}`);
syncPush(DATA, `${ticket} план`);
console.log(`${ticket} → planned${out.repeat ? " (repeat)" : ""}, plan: ${planAbs}`);
