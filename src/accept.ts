// Acceptance outcome, recorded by the review pane itself at the engineer's
// verdict (the unstamped main chat keeps it as a repair entry). Remarks → the
// ticket returns to planned with the rework plan, folder stays. Clean → the
// accepted row is removed right here — sync deletes nothing — while the task
// folder stays for /ship to work in: cleanup is /ship's ending. The command
// checks the stamp, the legal move and the current stage (src/transitions.ts);
// repeats are no-ops.
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { dataRoot } from "./data-root.ts";
import { openDb } from "./db.ts";
import { syncPush } from "./git-sync.ts";
import { logMove } from "./move-log.ts";
import { readRuntimeSettings } from "./guard-policy.ts";
import { applyMove, type MoveEnv } from "./transitions.ts";

export interface AcceptOptions {
  reworkPlan?: string; // path to the rework plan → remarks path
}

export function accept(
  db: DatabaseSync,
  root: string,
  ticket: string,
  opts: AcceptOptions = {},
  env: MoveEnv = {},
) {
  const settings = readRuntimeSettings(root);
  const row = db.prepare("SELECT folder FROM work WHERE ticket = ?").get(ticket) as
    | { folder: string | null }
    | undefined;

  if (opts.reworkPlan) {
    // Remarks: back to planned, same folder, same branches, same PRs.
    const planAbs = resolve(opts.reworkPlan);
    const out = applyMove(db, "accept-rework", env, ticket, () => {
      db.prepare(
        `UPDATE work SET stage = 'planned', plan = ?, updated_at = datetime('now') WHERE ticket = ?`,
      ).run(planAbs, ticket);
    }, { settings });
    if (!out.ok) throw new Error(out.refuse);
    return { outcome: "rework" as const, folder: row?.folder ?? null };
  }

  // The row already gone means a done accept: repeats stay no-ops.
  if (!row) return { outcome: "noop" as const, folder: null };

  // Clean pass: stage accepted, then the row goes — the folder stays where it
  // is, /ship works in it and removes it after the merge.
  const out = applyMove(db, "accept", env, ticket, () => {
    db.prepare(
      `UPDATE work SET stage = 'accepted', updated_at = datetime('now') WHERE ticket = ?`,
    ).run(ticket);
  }, { settings });
  if (!out.ok) throw new Error(out.refuse);
  db.prepare("DELETE FROM work WHERE ticket = ?").run(ticket);
  const folder = row.folder ?? join(root, "work", ticket);
  return { outcome: "accepted" as const, folder };
}

// CLI: pnpm accept ACME-347 [--rework <plan-path>]
// The review pane passes the rework plan's path outright — it is the file the
// pane itself just wrote, so there is nothing to search the disk for.
if (import.meta.url === `file://${process.argv[1]}`) {
  const ROOT = resolve(new URL("..", import.meta.url).pathname);
  const DATA = dataRoot(ROOT);
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const ticket = argv[0];
  if (!ticket) {
    console.error("usage: accept <TICKET> [--rework <plan-path>]");
    process.exit(1);
  }
  let reworkPlan: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--rework") {
      reworkPlan = argv[i + 1];
      if (!reworkPlan || reworkPlan.startsWith("--")) {
        console.error("--rework needs the rework plan's path — the review pane names the file it wrote");
        process.exit(1);
      }
      i++;
    } else {
      console.error(`unknown argument ${argv[i]} — known: --rework <plan-path>`);
      process.exit(1);
    }
  }
  if (reworkPlan && !existsSync(resolve(reworkPlan))) {
    console.error(`rework plan not found: ${resolve(reworkPlan)}`);
    process.exit(1);
  }
  const db = openDb(join(ROOT, "yokemate.db"));
  let r: ReturnType<typeof accept>;
  try {
    r = accept(db, ROOT, ticket, { reworkPlan }, process.env as MoveEnv);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  if (r.outcome === "noop") {
    console.log(`${ticket} уже принят, строки в очереди нет`);
    process.exit(0);
  }
  if (r.outcome === "rework") {
    logMove(DATA, ticket, "на доработку", reworkPlan ? basename(reworkPlan, ".md") : "");
    syncPush(DATA, `${ticket} на доработку`);
  } else {
    logMove(DATA, ticket, "принято");
    syncPush(DATA, `${ticket} принято`);
  }
  console.log(
    r.outcome === "rework"
      ? `${ticket} → planned (rework), plan: ${resolve(reworkPlan!)}, folder kept: ${r.folder}`
      : `${ticket} → accepted, folder kept for /ship: ${r.folder}`,
  );
}
