import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { openDb } from "./db.ts";
import type { PreparedCoordinator } from "./coordinator-launch.ts";

export interface CoordinatorOutcome { outcome: "done" | "blocked"; summary: string; reason?: string; passedTickets?: string[] }
export interface OutcomeVerification { ok: boolean; reason?: string; parts?: string[]; merged?: string[]; remaining?: string[] }

function gh(cwd: string, args: string[]): unknown { return JSON.parse(execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); }

export function verifyCoordinatorOutcome(root: string, prepared: PreparedCoordinator, outcome: CoordinatorOutcome, pending = 0): OutcomeVerification {
  if (outcome.outcome === "blocked") return { ok: true, reason: outcome.reason || "blocked", remaining: prepared.tickets.filter((ticket) => existsSync(join(root, "work", ticket))) };
  if (pending > 0) return { ok: false, reason: `${pending} child report(s) are pending` };
  try {
    if (prepared.mode === "do") {
      const ticket = prepared.tickets[0]!;
      const db = openDb(join(root, "yokemate.db"));
      const work = db.prepare("SELECT id, stage FROM work WHERE ticket = ?").get(ticket) as { id: number; stage: string } | undefined;
      if (!work || work.stage !== "review") return { ok: false, reason: `${ticket} is still ${work?.stage ?? "unrecorded"}` };
      const rows = db.prepare("SELECT repo, branch, pr FROM part WHERE work_id = ? ORDER BY repo").all(work.id) as { repo: string; branch: string; pr: string }[];
      if (rows.length !== prepared.parts.length) return { ok: false, reason: `recorded ${rows.length}/${prepared.parts.length} parts` };
      for (const expected of prepared.parts) {
        const row = rows.find((part) => part.repo === expected.repo && part.branch === ticket);
        if (!row?.pr) return { ok: false, reason: `missing recorded part ${expected.repo}` };
        const pr = gh(expected.path, ["pr", "view", row.pr, "--json", "state,headRefName,statusCheckRollup"] ) as { state: string; headRefName: string; statusCheckRollup?: { conclusion?: string | null }[] };
        if (pr.state !== "OPEN" || pr.headRefName !== ticket) return { ok: false, reason: `${expected.repo} PR is not open on ${ticket}` };
        const checks = pr.statusCheckRollup ?? [];
        if (checks.length === 0 || checks.some((check) => check.conclusion !== "SUCCESS" && check.conclusion !== "SKIPPED")) return { ok: false, reason: `${expected.repo} has pending or red PR checks` };
      }
      return { ok: true, parts: rows.map((row) => row.repo) };
    }
    const merged: string[] = [];
    const remaining: string[] = [];
    for (const part of prepared.parts) {
      if (!part.pr) return { ok: false, reason: `missing PR snapshot for ${part.repo}` };
      const pr = gh(part.path, ["pr", "view", part.pr, "--json", "state,mergedAt,headRefName,url"]) as { state: string; mergedAt?: string; headRefName: string; url: string };
      if (pr.state !== "MERGED" || !pr.mergedAt || pr.headRefName !== part.branch) return { ok: false, reason: `${part.repo} is not merged` };
      merged.push(pr.url);
    }
    for (const ticket of prepared.tickets) if (existsSync(join(root, "work", ticket))) remaining.push(ticket);
    return remaining.length ? { ok: false, reason: `task folders remain: ${remaining.join(", ")}`, merged, remaining } : { ok: true, merged, remaining };
  } catch (error) { return { ok: false, reason: (error as Error).message }; }
}
