import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findPlan, parseAffected } from "./adopt.ts";
import { gatherGateFacts, verifyGate, type GateVerdict } from "./coordinator-result.ts";
import { dataRoot } from "./data-root.ts";
import { openDb } from "./db.ts";

export function gate(root: string, ticket: string, deps: Partial<{ gather: typeof gatherGateFacts }> = {}): GateVerdict {
  try {
    const plan = findPlan(dataRoot(root), ticket);
    if (!plan) return { ok: false, reason: `${ticket}: no plan in knowledge` };
    const planned = parseAffected(readFileSync(plan, "utf8"));
    if (planned.length === 0) return { ok: false, reason: `${ticket}: the plan ${plan} names no affected repositories` };
    const db = openDb(join(root, "yokemate.db"));
    const parts = planned.map((part) => {
      const [org, repo] = part.repo.includes("/") ? part.repo.split("/", 2) : [null, part.repo];
      const rows = (
        org
          ? db.prepare("SELECT org, repo, path FROM project WHERE org = ? AND repo = ?").all(org, repo)
          : db.prepare("SELECT org, repo, path FROM project WHERE repo = ?").all(repo)
      ) as unknown as { org: string; repo: string }[];
      if (rows.length !== 1) throw new Error(`${ticket}: ${part.repo} has ${rows.length} passports`);
      return { repo: `${rows[0]!.org}/${rows[0]!.repo}`, selector: ticket };
    });
    return verifyGate((deps.gather ?? gatherGateFacts)(root, ticket, parts));
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

if (import.meta.filename === process.argv[1]) {
  const ticket = process.argv.slice(2).filter((a) => a !== "--")[0];
  if (!ticket) {
    console.error("usage: gate <TICKET>");
    process.exit(1);
  }
  const verdict = gate(resolve(new URL("..", import.meta.url).pathname), ticket);
  if (!verdict.ok) {
    console.error(`gate: ${verdict.reason}`);
    process.exit(1);
  }
  for (const [repo, head] of Object.entries(verdict.heads)) console.log(`${repo} ${head} ok`);
}
