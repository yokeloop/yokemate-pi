import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { freshMerge, type CoordinatorMergeDeps, type MergeSnapshot } from "./coordinator-merge.ts";
import type { GroupCandidate, GroupCandidatePart } from "./group-review.ts";
import { applyGroupMove, confirmGroupEffect, recordGroupEffect } from "./group-state.ts";
import { assertMandatoryBoundary } from "./workflow-boundaries.ts";

export interface GroupShipDeps {
  authorized(): boolean;
  live(): boolean;
  gate(part: GroupCandidatePart): Promise<{ ok: boolean; reason?: string; head?: string }>;
  snapshot(cwd: string, pr: string): Promise<MergeSnapshot & { mergeCommit?: { oid?: string } }>;
  merge: CoordinatorMergeDeps["merge"];
  ensureDone(ticket: string): Promise<void>;
  cleanup?(): Promise<void>;
}
export interface GroupShipOutcome {
  state: "done" | "partial" | "all_merged_tracker_pending";
  merged: string[];
  remaining: string[];
  unknown: string[];
  trackerPending: string[];
  cleanupPending: boolean;
}

interface RepositoryRow { repo: string; remote: string; integration_branch: string; external_base: string; final_pr: string | null; head_sha: string | null; base_sha: string; merge_commit: string | null; ship_state: string }

function currentAcceptance(db: DatabaseSync, groupId: string, revisionHash: string): GroupCandidate {
  const row = db.prepare("SELECT candidate_json FROM group_acceptance WHERE group_id=? AND revision_hash=? AND state='current'").get(groupId, revisionHash) as { candidate_json: string } | undefined;
  if (!row) throw new Error("group ship requires a current group acceptance");
  return JSON.parse(row.candidate_json) as GroupCandidate;
}

export function prepareGroupShip(db: DatabaseSync, groupId: string, candidateHash: string): { candidate: GroupCandidate; repositories: RepositoryRow[] } {
  const group = db.prepare("SELECT active_revision,phase FROM task_group WHERE id=?").get(groupId) as { active_revision: string | null; phase: string } | undefined;
  if (!group || !group.active_revision || !["accepted", "shipping", "done"].includes(group.phase)) throw new Error("group is not accepted for ship or cleanup recovery");
  const candidate = currentAcceptance(db, groupId, group.active_revision);
  if (candidate.candidateHash !== candidateHash) throw new Error("group ship candidate is stale");
  const repositories = db.prepare("SELECT repo,remote,integration_branch,external_base,final_pr,head_sha,base_sha,merge_commit,ship_state FROM group_repository WHERE group_id=? AND revision_hash=? ORDER BY repo").all(groupId, group.active_revision) as unknown as RepositoryRow[];
  const current = repositories.map((row) => ({ repo: row.repo, pr: row.final_pr, headSha: row.head_sha, baseRef: row.external_base, baseSha: row.base_sha }));
  if (JSON.stringify(current) !== JSON.stringify(candidate.parts)) throw new Error("group ship repository facts changed after acceptance");
  return { candidate, repositories };
}

export async function shipGroup(db: DatabaseSync, taskRoot: string, groupId: string, candidateHash: string, deps: GroupShipDeps): Promise<GroupShipOutcome> {
  assertMandatoryBoundary("workflow.explicit-ship", deps.authorized(), "group ship requires an exact interactive ship permit");
  const prepared = prepareGroupShip(db, groupId, candidateHash);
  const group = db.prepare("SELECT active_revision,phase,root_ticket FROM task_group WHERE id=?").get(groupId) as { active_revision: string; phase: "accepted" | "shipping" | "done"; root_ticket: string };
  if (group.phase === "accepted") {
    const moved = applyGroupMove(db, { groupId, revisionHash: group.active_revision, expectedPhase: "accepted", toPhase: "shipping", idempotencyKey: `ship-start:${groupId}:${candidateHash}` });
    if (!moved.ok) throw new Error(moved.refuse);
  }
  for (const repository of prepared.repositories) {
    if (repository.ship_state === "merged") continue;
    if (!repository.final_pr || !repository.head_sha) throw new Error(`${repository.repo}: final PR is incomplete`);
    const effectKey = `ship:${groupId}:${group.active_revision}:${repository.repo}:${repository.final_pr}:${repository.head_sha}:${repository.external_base}`;
    const prior = db.prepare("SELECT state FROM group_effect WHERE effect_key=?").get(effectKey) as { state: string } | undefined;
    const [org, repo] = repository.repo.split("/");
    const cwd = join(resolve(taskRoot), "integration", org!, repo!);
    if (prior?.state === "unknown") {
      const observed = await deps.snapshot(cwd, repository.final_pr);
      if (observed.state !== "MERGED" || observed.headRefOid !== repository.head_sha || observed.headRefName !== repository.integration_branch || observed.baseRefName !== repository.external_base || !observed.mergeCommit?.oid) continue;
    }
    recordGroupEffect(db, { key: effectKey, groupId, revisionHash: group.active_revision, type: "ship", scope: { repo: repository.repo, pr: repository.final_pr }, input: { head: repository.head_sha, target: repository.external_base, candidateHash }, state: "intent" });
    const part = prepared.candidate.parts.find((candidatePart) => candidatePart.repo === repository.repo)!;
    const result = await freshMerge({ repo: repository.repo, cwd, remote: repository.remote, sourceBranch: repository.integration_branch, targetBranch: repository.external_base, pr: repository.final_pr, expectedHead: repository.head_sha, live: deps.live, gate: () => deps.gate(part) }, "merge", { snapshot: deps.snapshot, merge: deps.merge });
    if (result.state !== "merged") {
      confirmGroupEffect(db, effectKey, result.state === "unknown" ? "unknown" : "failed", result);
      db.prepare("UPDATE group_repository SET ship_state=? WHERE group_id=? AND revision_hash=? AND repo=?").run(result.state === "unknown" ? "unknown" : "failed", groupId, group.active_revision, repository.repo);
      continue;
    }
    const observed = await deps.snapshot(cwd, repository.final_pr);
    const mergeCommit = observed.mergeCommit?.oid;
    if (!mergeCommit || !/^[0-9a-f]{40}$/.test(mergeCommit)) {
      confirmGroupEffect(db, effectKey, "unknown", { ...result, reason: "merge commit is unavailable" });
      db.prepare("UPDATE group_repository SET ship_state='unknown' WHERE group_id=? AND revision_hash=? AND repo=?").run(groupId, group.active_revision, repository.repo);
      continue;
    }
    confirmGroupEffect(db, effectKey, "confirmed", { pr: repository.final_pr, head: repository.head_sha, target: repository.external_base, mergeCommit });
    db.prepare("UPDATE group_repository SET ship_state='merged',merge_commit=? WHERE group_id=? AND revision_hash=? AND repo=?").run(mergeCommit, groupId, group.active_revision, repository.repo);
  }
  const after = db.prepare("SELECT repo,ship_state FROM group_repository WHERE group_id=? AND revision_hash=? ORDER BY repo").all(groupId, group.active_revision) as unknown as { repo: string; ship_state: string }[];
  const merged = after.filter((row) => row.ship_state === "merged").map((row) => row.repo);
  const unknown = after.filter((row) => row.ship_state === "unknown").map((row) => row.repo);
  const remaining = after.filter((row) => row.ship_state !== "merged" && row.ship_state !== "unknown").map((row) => row.repo);
  if (merged.length !== after.length) return { state: "partial", merged, remaining, unknown, trackerPending: [], cleanupPending: false };
  const members = db.prepare("SELECT member_identity,ticket,parent_identity,tracker_state FROM group_member WHERE group_id=? AND revision_hash=?").all(groupId, group.active_revision) as unknown as { member_identity: string; ticket: string; parent_identity: string | null; tracker_state: string | null }[];
  const byIdentity = new Map(members.map((member) => [member.member_identity, member]));
  const depth = (member: typeof members[number]): number => {
    let value = 0;
    let current = member;
    const seen = new Set<string>();
    while (current.parent_identity) {
      if (seen.has(current.member_identity)) throw new Error("group member parent cycle during ship finalization");
      seen.add(current.member_identity);
      const parent = byIdentity.get(current.parent_identity);
      if (!parent) throw new Error(`${current.ticket}: missing parent during ship finalization`);
      value++;
      current = parent;
    }
    return value;
  };
  const ordered = [...members].sort((left, right) => depth(right) - depth(left) || (left.ticket === group.root_ticket ? 1 : right.ticket === group.root_ticket ? -1 : left.ticket.localeCompare(right.ticket)));
  const trackerPending: string[] = [];
  for (const member of ordered) {
    const key = `done:${groupId}:${group.active_revision}:${member.member_identity}`;
    const effect = db.prepare("SELECT state FROM group_effect WHERE effect_key=?").get(key) as { state: string } | undefined;
    if (effect?.state === "confirmed") continue;
    try {
      recordGroupEffect(db, { key, groupId, revisionHash: group.active_revision, type: "done", scope: { member: member.member_identity, ticket: member.ticket }, input: { state: "Done", candidateHash }, state: "intent" });
      await deps.ensureDone(member.ticket);
      confirmGroupEffect(db, key, "confirmed", { state: "Done" });
    } catch (error) {
      confirmGroupEffect(db, key, "failed", { error: error instanceof Error ? error.message : String(error) });
      trackerPending.push(member.ticket);
    }
  }
  if (trackerPending.length) return { state: "all_merged_tracker_pending", merged, remaining: [], unknown: [], trackerPending, cleanupPending: false };
  if (group.phase !== "done") {
    const moved = applyGroupMove(db, { groupId, revisionHash: group.active_revision, expectedPhase: "shipping", toPhase: "done", idempotencyKey: `ship-done:${groupId}:${candidateHash}` });
    if (!moved.ok) throw new Error(moved.refuse);
  }
  let cleanupPending = false;
  if (deps.cleanup) {
    const key = `cleanup:${groupId}:${group.active_revision}`;
    try {
      recordGroupEffect(db, { key, groupId, revisionHash: group.active_revision, type: "cleanup", scope: { taskRoot }, input: { candidateHash }, state: "intent" });
      await deps.cleanup();
      confirmGroupEffect(db, key, "confirmed", { removed: true });
    } catch (error) {
      confirmGroupEffect(db, key, "failed", { error: error instanceof Error ? error.message : String(error) });
      cleanupPending = true;
    }
  }
  return { state: "done", merged, remaining: [], unknown: [], trackerPending: [], cleanupPending };
}
