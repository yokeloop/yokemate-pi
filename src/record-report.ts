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

import { gatherGateFacts, gatherScopedGateFacts, verifyGate } from "./coordinator-result.ts";
import { dataRoot } from "./data-root.ts";
import { openDb } from "./db.ts";
import { syncPush } from "./git-sync.ts";
import { logMove } from "./move-log.ts";
import { readRuntimeSettings } from "./guard-policy.ts";
import { applyMove, type MoveEnv } from "./transitions.ts";
import { join, resolve } from "node:path";
import { assertMandatoryBoundary } from "./workflow-boundaries.ts";
import { resolveGroupWorkScope } from "./group-scope.ts";

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
  const groupEnv = env as MoveEnv & { YOKEMATE_GROUP_ID?: string; YOKEMATE_GROUP_REVISION?: string; YOKEMATE_GROUP_ROOT?: string; YOKEMATE_GROUP_MEMBER?: string };
  if (groupEnv.YOKEMATE_GROUP_ID && groupEnv.YOKEMATE_GROUP_REVISION && groupEnv.YOKEMATE_GROUP_ROOT && groupEnv.YOKEMATE_GROUP_MEMBER === ticket) {
    const db = openDb(join(root, "yokemate.db"));
    try {
      const member = db.prepare("SELECT member_identity,execution FROM group_member WHERE group_id=? AND revision_hash=? AND ticket=?").get(groupEnv.YOKEMATE_GROUP_ID, groupEnv.YOKEMATE_GROUP_REVISION, ticket) as { member_identity: string; execution: string } | undefined;
      if (!member || member.execution !== "running") throw new Error(`${ticket}: group member is not running in this owned revision`);
      const rows = db.prepare("SELECT repo,role,source_ref,target_ref FROM group_part WHERE group_id=? AND revision_hash=? AND member_identity=? ORDER BY repo").all(groupEnv.YOKEMATE_GROUP_ID, groupEnv.YOKEMATE_GROUP_REVISION, member.member_identity) as unknown as { repo: string; role: string; source_ref: string; target_ref: string }[];
      if (rows.length !== parts.length || rows.some((row) => !parts.some((part) => part.repo === row.repo && part.role === row.role && part.branch === row.source_ref))) throw new Error(`${ticket}: report parts differ from the immutable group scope`);
      const scopes = parts.map((part) => {
        const kind = ticket === groupEnv.YOKEMATE_GROUP_ROOT ? "root-own" : "member";
        const scope = resolveGroupWorkScope(db, join(root, "work", groupEnv.YOKEMATE_GROUP_ROOT!), { groupId: groupEnv.YOKEMATE_GROUP_ID!, revisionHash: groupEnv.YOKEMATE_GROUP_REVISION!, memberIdentity: member.member_identity, kind, repo: part.repo });
        return { part, scope };
      });
      const facts = gatherScopedGateFacts(ticket, scopes.map(({ part, scope }) => ({ repo: part.repo, selector: part.pr, worktree: scope.worktree!, branch: scope.branch!, targetBranch: scope.targetBranch!, receiptPath: scope.receiptPath!, expectedScopeId: scope.scopeId })));
      const verdict = verifyGate(facts);
      assertMandatoryBoundary("workflow.quality-gates", verdict.ok, verdict.ok ? undefined : verdict.reason);
      assertMandatoryBoundary("workflow.ready-pr-report", verdict.ok, verdict.ok ? undefined : verdict.reason);
      for (const fact of facts.parts) db.prepare("UPDATE group_part SET pr_identity=?,head_sha=?,base_sha=?,readiness_json=?,outcome=NULL WHERE group_id=? AND revision_hash=? AND member_identity=? AND repo=?").run(fact.pr.url, fact.pr.headRefOid, fact.pr.baseRefOid, JSON.stringify({ ok: true, headSha: fact.pr.headRefOid, baseSha: fact.pr.baseRefOid, scopeId: scopes.find(({ part }) => part.repo === fact.repo)!.scope.scopeId }), groupEnv.YOKEMATE_GROUP_ID, groupEnv.YOKEMATE_GROUP_REVISION, member.member_identity, fact.repo);
      return { repeat: false };
    } finally { db.close(); }
  }
  const settings = readRuntimeSettings(root);
  const verdict = verifyGate((deps.gather ?? gatherGateFacts)(root, ticket, parts.map((p) => ({ repo: p.repo, selector: p.pr }))));
  assertMandatoryBoundary("workflow.quality-gates", verdict.ok, verdict.ok ? undefined : verdict.reason);
  assertMandatoryBoundary("workflow.ready-pr-report", verdict.ok, verdict.ok ? undefined : verdict.reason);
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
  }, { settings });
  if (!out.ok) throw new Error(out.refuse);
  const recorded = db.prepare("SELECT stage FROM work WHERE ticket=?").get(ticket) as { stage?: string } | undefined;
  assertMandatoryBoundary("workflow.truthful-outcome", recorded?.stage === "review", "recorded PR report did not reach review");
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
    `${ticket} → ${process.env.YOKEMATE_GROUP_ID ? "group member ready for coordinator verification" : "review"}${out.repeat ? " (repeat)" : ""}, ${parts.length} part(s): ` +
      parts.map((p) => p.repo).join(", "),
  );
}
