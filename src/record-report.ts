// Record a task's result in the DB: parts with their PRs, stage → review. The
// task tab runs this itself, from the task folder root, the moment its PRs are
// open and green — the stop guard reads the stage this command writes. The
// unstamped main chat keeps it as a repair entry. The command checks the
// stamp, the legal move and the current stage (src/transitions.ts); a repeat
// with the same parts is idempotent — rework replaces.
//
// Usage:
//   pnpm record-report ACME-347 \
//     --part acme/acme-ui-kit:library:ACME-347:https://github.com/.../pull/34 \
//     --part acme/acme-subscription-page:app:ACME-347:https://github.com/.../pull/213

import { dataRoot } from "./data-root.ts";
import { openDb } from "./db.ts";
import { syncPush } from "./git-sync.ts";
import { logMove } from "./move-log.ts";
import { applyMove, type MoveEnv } from "./transitions.ts";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DATA = dataRoot(ROOT);

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const argv = process.argv.slice(2).filter((a) => a !== "--");
const ticket = argv[0] ?? fail("usage: record-report <TICKET> --part <repo>:<role>:<branch>:<pr-url> [...]");

interface Part {
  repo: string;
  role: string;
  branch: string;
  pr: string;
}
const parts: Part[] = [];
for (let i = 1; i < argv.length; i++) {
  if (argv[i] !== "--part") fail(`unknown argument ${argv[i]} — known: --part <repo>:<role>:<branch>:<pr-url>`);
  const raw = argv[++i];
  const m = raw.match(/^([^:]+):([^:]+):([^:]+):(.+)$/);
  if (!m) fail(`cannot parse --part "${raw}" — expected <org/repo>:<role>:<branch>:<pr-url>`);
  parts.push({ repo: m[1], role: m[2], branch: m[3], pr: m[4] });
}
if (parts.length === 0) fail("at least one --part is required: a report without PRs is not a report");

const db = openDb(join(ROOT, "yokemate.db"));
const out = applyMove(db, "record-report", process.env as MoveEnv, ticket, () => {
  const work = db.prepare("SELECT id FROM work WHERE ticket = ?").get(ticket) as { id: number };
  db.prepare("DELETE FROM part WHERE work_id = ?").run(work.id); // rework replaces
  const ins = db.prepare(
    "INSERT INTO part (work_id, repo, role, branch, pr) VALUES (?, ?, ?, ?, ?)",
  );
  for (const p of parts) ins.run(work.id, p.repo, p.role, p.branch, p.pr);
  db.prepare(
    `UPDATE work SET stage = 'review', pr = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(parts.map((p) => p.pr).join(" "), work.id);
});
if (!out.ok) fail(out.refuse);

const prLabel = (url: string) => {
  const m = /(\d+)\/?$/.exec(url);
  return m ? `PR #${m[1]}` : url;
};
logMove(DATA, ticket, "сделано", parts.map((p) => prLabel(p.pr)).join(", "));
syncPush(DATA, `${ticket} сделано`);
console.log(
  `${ticket} → review${out.repeat ? " (repeat)" : ""}, ${parts.length} part(s): ` +
    parts.map((p) => p.repo).join(", "),
);
