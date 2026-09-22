import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { activateGroupRevision, createPlanningGroup, reserveMemberClaims } from "../src/group-state.ts";
import { integrateMemberPart, type GroupIntegrationDeps, type ReviewerEvidence } from "../src/group-integration.ts";
import { resolveGroupWorkScope } from "../src/group-scope.ts";
import type { MergeSnapshot } from "../src/coordinator-merge.ts";

const treeHash = "a".repeat(64);
const revisionHash = "b".repeat(64);
const head = "c".repeat(40);
const base = "d".repeat(40);
const mergeCommit = "e".repeat(40);
const pr = "https://github.com/one/repo/pull/7";

function fixture() {
  const db = openDb(":memory:");
  const groupId = createPlanningGroup(db, { id: "g", rootIdentity: "yt:YM-1", rootTicket: "YM-1", ownerProject: "one/repo" });
  reserveMemberClaims(db, { groupId, treeHash, members: ["yt:YM-1", "yt:YM-2"], owners: [{ runtimeId: "r", runId: "x", sessionId: "s" }] });
  activateGroupRevision(db, { groupId, revisionHash, treeHash, manifest: {}, bindings: {}, compatibility: {}, approachReceiptId: "a", members: [{ identity: "yt:YM-1", ticket: "YM-1", parentIdentity: null }, { identity: "yt:YM-2", ticket: "YM-2", parentIdentity: "yt:YM-1", execution: "ready", stage: "review" }] });
  db.prepare("UPDATE task_group SET phase='running' WHERE id=?").run(groupId);
  db.prepare(`INSERT INTO group_repository (group_id,revision_hash,repo,remote,role,integration_branch,external_base,base_sha)
    VALUES (?,?,?,?,?,'YM-1','main',?)`).run(groupId, revisionHash, "one/repo", "git@github.com:one/repo.git", "app", base);
  const evidence: ReviewerEvidence = { runId: "review", ownerRunId: "owner", taskHash: "task", member: "yt:YM-2", repo: "one/repo", baseSha: base, headSha: head, verdict: "approved", artifactHash: "f".repeat(64), observedDelivery: true };
  db.prepare(`INSERT INTO group_part (group_id,revision_hash,member_identity,repo,remote,role,source_ref,target_ref,pr_identity,head_sha,base_sha,readiness_json,reviewer_json)
    VALUES (?,?,?,?,?,'app','YM-2','YM-1',?,?,?,?,?)`).run(groupId, revisionHash, "yt:YM-2", "one/repo", "git@github.com:one/repo.git", pr, head, base, JSON.stringify({ ok: true, headSha: head, baseSha: base }), JSON.stringify(evidence));
  const scope = resolveGroupWorkScope(db, "/work/YM-1", { groupId, revisionHash, memberIdentity: "yt:YM-2", kind: "member", repo: "one/repo" });
  return { db, groupId, scope, evidence };
}

function deps(overrides: Partial<GroupIntegrationDeps> = {}) {
  let snapshots = 0;
  let merges = 0;
  let tracker = 0;
  const value: GroupIntegrationDeps & { counts(): { snapshots: number; merges: number; tracker: number } } = {
    live: () => true,
    gate: async () => ({ ok: true, head }),
    snapshot: async () => {
      snapshots++;
      const merged = snapshots >= 3;
      return { url: pr, state: merged ? "MERGED" : "OPEN", headRefName: "YM-2", headRefOid: head, baseRefName: "YM-1", ...(merged ? { mergedAt: "now", mergeCommit: { oid: mergeCommit } } : {}) };
    },
    merge: async () => { merges++; return { exit: 0, output: "" }; },
    trackerToVerify: async () => { tracker++; },
    ...overrides,
    counts: () => ({ snapshots, merges, tracker }),
  };
  return value;
}

test("integrates only exact ready and reviewer evidence then records To Verify", async () => {
  const { db, scope, evidence } = fixture();
  const operations = deps();
  const result = await integrateMemberPart(db, scope, evidence, head, operations);
  assert.deepEqual(result, { state: "integrated", repeated: false, mergeCommit, tracker: "confirmed" });
  assert.equal(operations.counts().merges, 1);
  assert.equal(operations.counts().tracker, 1);
  const member = db.prepare("SELECT execution,stage FROM group_member WHERE ticket='YM-2'").get() as { execution: string; stage: string };
  assert.deepEqual({ ...member }, { execution: "integrated", stage: "integrated" });
  const repeat = await integrateMemberPart(db, scope, evidence, head, operations);
  assert.equal(repeat.repeated, true);
  assert.equal(operations.counts().merges, 1);
});

test("stale reviewer, readiness, head and dead owner fail before merge", async () => {
  const { db, scope, evidence } = fixture();
  const operations = deps();
  await assert.rejects(() => integrateMemberPart(db, scope, { ...evidence, headSha: "0".repeat(40) }, head, operations), /expected head|reviewer/);
  db.prepare("UPDATE group_part SET readiness_json=?").run(JSON.stringify({ ok: true, headSha: "0".repeat(40), baseSha: base }));
  await assert.rejects(() => integrateMemberPart(db, scope, evidence, head, operations), /readiness/);
  assert.equal(operations.counts().merges, 0);
});

test("unknown merge is reconciled without a blind second merge", async () => {
  const { db, scope, evidence } = fixture();
  let mergedCalls = 0;
  const unknown = deps({
    snapshot: async () => ({ url: pr, state: "OPEN", headRefName: "YM-2", headRefOid: head, baseRefName: "YM-1" } as MergeSnapshot),
    merge: async () => { mergedCalls++; return { exit: 0, output: "lost" }; },
  });
  const first = await integrateMemberPart(db, scope, evidence, head, unknown);
  assert.equal(first.state, "unknown");
  assert.equal(mergedCalls, 1);
  const second = await integrateMemberPart(db, scope, evidence, head, unknown);
  assert.deepEqual({ state: second.state, repeated: second.repeated }, { state: "unknown", repeated: true });
  assert.equal(mergedCalls, 1);
});

test("multi-part member reaches integrated only after every part", async () => {
  const { db, groupId, scope, evidence } = fixture();
  db.prepare(`INSERT INTO group_repository (group_id,revision_hash,repo,remote,role,integration_branch,external_base,base_sha)
    VALUES (?,?,?,?,?,'YM-1','main',?)`).run(groupId, revisionHash, "two/repo", "git@github.com:two/repo.git", "app", base);
  db.prepare(`INSERT INTO group_part (group_id,revision_hash,member_identity,repo,remote,role,source_ref,target_ref,outcome)
    VALUES (?,?,?,?,?,'app','YM-2','YM-1','pending')`).run(groupId, revisionHash, "yt:YM-2", "two/repo", "git@github.com:two/repo.git");
  const operations = deps();
  const result = await integrateMemberPart(db, scope, evidence, head, operations);
  assert.equal(result.tracker, "pending");
  assert.equal(operations.counts().tracker, 0);
  const member = db.prepare("SELECT execution FROM group_member WHERE ticket='YM-2'").get() as { execution: string };
  assert.equal(member.execution, "ready");
});
