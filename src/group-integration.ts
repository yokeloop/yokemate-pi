import type { DatabaseSync } from "node:sqlite";
import { canonicalHash, confirmGroupEffect, recordGroupEffect } from "./group-state.ts";
import type { WorkScope } from "./group-scope.ts";
import { freshMerge, type CoordinatorMergeDeps, type MergeSnapshot } from "./coordinator-merge.ts";

export interface ReviewerEvidence {
  runId: string;
  ownerRunId: string;
  taskHash: string;
  member: string;
  repo: string;
  baseSha: string;
  headSha: string;
  verdict: "approved" | "changes_required";
  artifactHash: string;
  observedDelivery: boolean;
}
export interface GroupIntegrationDeps {
  live(): boolean;
  gate(scope: WorkScope): Promise<{ ok: boolean; reason?: string; head?: string }>;
  snapshot(cwd: string, pr: string): Promise<MergeSnapshot & { mergeCommit?: { oid?: string } }>;
  merge: CoordinatorMergeDeps["merge"];
  trackerToVerify?(ticket: string): Promise<void>;
}
export interface GroupIntegrationResult { state: "integrated" | "open" | "unknown"; repeated: boolean; mergeCommit?: string; tracker: "confirmed" | "pending" }

function exactEvidence(evidence: ReviewerEvidence, input: { member: string; repo: string; baseSha: string; headSha: string }): void {
  if (!evidence.runId || !evidence.ownerRunId || !evidence.taskHash || !/^[a-f0-9]{64}$/.test(evidence.artifactHash) || evidence.member !== input.member || evidence.repo !== input.repo || evidence.baseSha !== input.baseSha || evidence.headSha !== input.headSha || evidence.verdict !== "approved" || !evidence.observedDelivery) throw new Error("independent reviewer evidence does not approve this exact member diff");
}

export async function integrateMemberPart(db: DatabaseSync, scope: WorkScope, evidence: ReviewerEvidence, expectedHead: string, deps: GroupIntegrationDeps): Promise<GroupIntegrationResult> {
  if (scope.kind !== "member" && scope.kind !== "root-own") throw new Error("only implementation member scopes can be integrated");
  if (!scope.repo || !scope.remote || !scope.worktree || !scope.branch || !scope.targetBranch || !scope.pr) throw new Error("group integration scope is incomplete");
  if (scope.scopeId.length !== 64 || expectedHead !== evidence.headSha) throw new Error("group integration expected head mismatch");
  const part = db.prepare(`SELECT p.head_sha,p.base_sha,p.readiness_json,p.reviewer_json,m.ticket,m.execution
    FROM group_part p JOIN group_member m ON m.group_id=p.group_id AND m.revision_hash=p.revision_hash AND m.member_identity=p.member_identity
    WHERE p.group_id=? AND p.revision_hash=? AND p.member_identity=? AND p.repo=?`).get(scope.groupId, scope.revisionHash, scope.member, scope.repo) as { head_sha: string | null; base_sha: string | null; readiness_json: string | null; reviewer_json: string | null; ticket: string; execution: string } | undefined;
  if (!part || !["ready", "integrated"].includes(part.execution) || part.head_sha !== expectedHead || !part.base_sha) throw new Error("group member part is not ready at the expected head");
  exactEvidence(evidence, { member: scope.member, repo: scope.repo, baseSha: part.base_sha, headSha: expectedHead });
  const storedReviewer = part.reviewer_json ? JSON.parse(part.reviewer_json) as ReviewerEvidence : undefined;
  if (!storedReviewer || JSON.stringify(storedReviewer) !== JSON.stringify(evidence)) throw new Error("reviewer evidence is not the correlated stored terminal report");
  const readiness = part.readiness_json ? JSON.parse(part.readiness_json) as { ok?: boolean; headSha?: string; baseSha?: string } : undefined;
  if (!readiness?.ok || readiness.headSha !== expectedHead || readiness.baseSha !== part.base_sha) throw new Error("readiness evidence is stale for the member diff");
  const effectKey = `integrate:${scope.groupId}:${scope.revisionHash}:${scope.repo}:${scope.pr}:${expectedHead}:${scope.targetBranch}`;
  const existing = db.prepare("SELECT state,outcome_json FROM group_effect WHERE effect_key=?").get(effectKey) as { state: string; outcome_json: string | null } | undefined;
  if (existing?.state === "confirmed") {
    const outcome = JSON.parse(existing.outcome_json ?? "{}") as { mergeCommit?: string };
    return { state: "integrated", repeated: true, mergeCommit: outcome.mergeCommit, tracker: trackerEffectState(db, scope, part.ticket) };
  }
  if (part.execution !== "ready") throw new Error("integrated member has no confirmed matching integration effect");
  if (existing?.state === "unknown") {
    const observed = await deps.snapshot(scope.worktree, scope.pr);
    if (observed.state !== "MERGED" || observed.headRefOid !== expectedHead || observed.headRefName !== scope.branch || observed.baseRefName !== scope.targetBranch || !observed.mergeCommit?.oid) return { state: "unknown", repeated: true, tracker: "pending" };
  }
  recordGroupEffect(db, { key: effectKey, groupId: scope.groupId, revisionHash: scope.revisionHash, type: "integrate", scope: { member: scope.member, repo: scope.repo, pr: scope.pr }, input: { head: expectedHead, base: part.base_sha, target: scope.targetBranch, reviewerArtifact: evidence.artifactHash }, state: "intent" });
  const merged = await freshMerge({ repo: scope.repo, cwd: scope.worktree, remote: scope.remote, sourceBranch: scope.branch, targetBranch: scope.targetBranch, pr: scope.pr, expectedHead, live: deps.live, gate: () => deps.gate(scope) }, "merge", { snapshot: deps.snapshot, merge: deps.merge });
  if (merged.state !== "merged") {
    confirmGroupEffect(db, effectKey, merged.state === "unknown" ? "unknown" : "failed", merged);
    return { state: merged.state, repeated: false, tracker: "pending" };
  }
  const snapshot = await deps.snapshot(scope.worktree, scope.pr);
  const mergeCommit = snapshot.mergeCommit?.oid;
  if (!mergeCommit || !/^[0-9a-f]{40}$/.test(mergeCommit)) {
    confirmGroupEffect(db, effectKey, "unknown", { ...merged, reason: "merged PR has no verified merge commit" });
    return { state: "unknown", repeated: false, tracker: "pending" };
  }
  let memberIntegrated = false;
  db.exec("BEGIN IMMEDIATE");
  try {
    confirmGroupEffect(db, effectKey, "confirmed", { pr: scope.pr, head: expectedHead, target: scope.targetBranch, mergeCommit });
    db.prepare("UPDATE group_part SET merge_commit=?,outcome='merged' WHERE group_id=? AND revision_hash=? AND member_identity=? AND repo=?").run(mergeCommit, scope.groupId, scope.revisionHash, scope.member, scope.repo);
    const remaining = db.prepare("SELECT COUNT(*) count FROM group_part WHERE group_id=? AND revision_hash=? AND member_identity=? AND COALESCE(outcome,'')!='merged'").get(scope.groupId, scope.revisionHash, scope.member) as { count: number };
    if (remaining.count === 0) {
      db.prepare("UPDATE group_member SET execution='integrated',stage='integrated',updated_at=datetime('now') WHERE group_id=? AND revision_hash=? AND member_identity=?").run(scope.groupId, scope.revisionHash, scope.member);
      memberIntegrated = true;
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  let tracker: "confirmed" | "pending" = "pending";
  if (memberIntegrated && deps.trackerToVerify) {
    const trackerKey = `to-verify:${scope.groupId}:${scope.revisionHash}:${part.ticket}`;
    try {
      recordGroupEffect(db, { key: trackerKey, groupId: scope.groupId, revisionHash: scope.revisionHash, type: "to_verify", scope: { member: scope.member, ticket: part.ticket }, input: { state: "To Verify" }, state: "intent" });
      await deps.trackerToVerify(part.ticket);
      confirmGroupEffect(db, trackerKey, "confirmed", { state: "To Verify" });
      tracker = "confirmed";
    } catch (error) {
      confirmGroupEffect(db, trackerKey, "failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { state: "integrated", repeated: false, mergeCommit, tracker };
}

export function integrateCoordinationMember(db: DatabaseSync, input: { groupId: string; revisionHash: string; memberIdentity: string; resultHash: string; evidence: ReviewerEvidence }): void {
  if (!/^[a-f0-9]{64}$/.test(input.resultHash) || input.evidence.repo !== "coordination" || input.evidence.member !== input.memberIdentity || input.evidence.headSha !== input.resultHash || input.evidence.baseSha !== input.resultHash || input.evidence.verdict !== "approved" || !input.evidence.observedDelivery) throw new Error("coordination reviewer evidence is invalid");
  const row = db.prepare("SELECT execution,result_json FROM group_member WHERE group_id=? AND revision_hash=? AND member_identity=?").get(input.groupId, input.revisionHash, input.memberIdentity) as { execution: string; result_json: string | null } | undefined;
  if (!row || row.execution !== "ready" || !row.result_json || canonicalHash(JSON.parse(row.result_json)) !== input.resultHash) throw new Error("coordination result is not ready");
  db.prepare("UPDATE group_member SET execution='integrated',stage='integrated',blocker=NULL,updated_at=datetime('now') WHERE group_id=? AND revision_hash=? AND member_identity=?").run(input.groupId, input.revisionHash, input.memberIdentity);
}

function trackerEffectState(db: DatabaseSync, scope: WorkScope, ticket: string): "confirmed" | "pending" {
  const row = db.prepare("SELECT state FROM group_effect WHERE effect_key=?").get(`to-verify:${scope.groupId}:${scope.revisionHash}:${ticket}`) as { state: string } | undefined;
  return row?.state === "confirmed" ? "confirmed" : "pending";
}
