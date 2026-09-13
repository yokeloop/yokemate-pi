// Record a task's result in the DB: parts with their PRs, stage → review. The
// task tab runs this itself, from the task folder root, the moment its PRs are
// open and green — the stop guard reads the stage this command writes. The
// unstamped main chat keeps it as a repair entry. The command checks the
// stamp, the legal move and the current stage (src/transitions.ts); a repeat
// with the same parts is idempotent — rework replaces. The result is recorded
// only through a passed gate: a `pnpm ready` receipt on the PR head, the local
// branch on that same head, the base inside the head, every required CI job green.
//
// Usage:
//   pnpm record-report ACME-347 \
//     --part acme/acme-ui-kit:library:ACME-347:https://github.com/.../pull/34 \
//     --part acme/acme-subscription-page:app:ACME-347:https://github.com/.../pull/213

import { gatherGateFacts, verifyGate } from "./coordinator-result.ts";
import { dataRoot } from "./data-root.ts";
import { openDb } from "./db.ts";
import { syncPush } from "./git-sync.ts";
import { logMove } from "./move-log.ts";
import { applyMove, type MoveEnv } from "./transitions.ts";
import { join, resolve } from "node:path";

export interface Part {
  repo: string;
  role: string;
  branch: string;
  pr: string;
}

const prLabel = (url: string) => {
  const m = /(\d+)\/?$/.exec(url);
  return m ? `PR #${m[1]}` : url;
};

export function recordReport(
  root: string,
  ticket: string,
  parts: Part[],
  env: MoveEnv,
  deps: Partial<{ gather: typeof gatherGateFacts; push: typeof syncPush }> = {},
): { repeat: boolean } {
  const verdict = verifyGate((deps.gather ?? gatherGateFacts)(root, ticket, parts.map((p) => ({ repo: p.repo, selector: p.pr }))));
  if (!verdict.ok) throw new Error(verdict.reason);
  const db = openDb(join(root, "yokemate.db"));
  const out = applyMove(db, "record-report", env, ticket, () => {
    const work = db.prepare("SELECT id FROM work WHERE ticket = ?").get(ticket) as { id: number } | undefined;
    if (!work) throw new Error(`${ticket}: cannot record a report without a work row`);
    db.prepare("DELETE FROM part WHERE work_id = ?").run(work.id); // rework replaces
    const ins = db.prepare(
      "INSERT INTO part (work_id, repo, role, branch, pr) VALUES (?, ?, ?, ?, ?)",
    );
    for (const p of parts) ins.run(work.id, p.repo, p.role, p.branch, p.pr);
    db.prepare(
      `UPDATE work SET stage = 'review', pr = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(parts.map((p) => p.pr).join(" "), work.id);
  });
  if (!out.ok) throw new Error(out.refuse);
  const data = dataRoot(root);
  logMove(data, ticket, "сделано", parts.map((p) => prLabel(p.pr)).join(", "));
  (deps.push ?? syncPush)(data, `${ticket} сделано`);
  return { repeat: out.repeat };
}

if (import.meta.filename === process.argv[1]) {
  const ROOT = resolve(new URL("..", import.meta.url).pathname);

  function fail(msg: string): never {
    console.error(msg);
    process.exit(1);
  }

  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const ticket = argv[0] ?? fail("usage: record-report <TICKET> --part <repo>:<role>:<branch>:<pr-url> [...]");

  const parts: Part[] = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] !== "--part") fail(`unknown argument ${argv[i]} — known: --part <repo>:<role>:<branch>:<pr-url>`);
    const raw = argv[++i];
    const m = raw.match(/^([^:]+):([^:]+):([^:]+):(.+)$/);
    if (!m) fail(`cannot parse --part "${raw}" — expected <org/repo>:<role>:<branch>:<pr-url>`);
    parts.push({ repo: m[1], role: m[2], branch: m[3], pr: m[4] });
  }
  if (parts.length === 0) fail("at least one --part is required: a report without PRs is not a report");

  let out: { repeat: boolean };
  try {
    out = recordReport(ROOT, ticket, parts, process.env as MoveEnv);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  console.log(
    `${ticket} → review${out.repeat ? " (repeat)" : ""}, ${parts.length} part(s): ` +
      parts.map((p) => p.repo).join(", "),
  );
}
