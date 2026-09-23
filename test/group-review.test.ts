import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { activateGroupRevision, canonicalHash, createPlanningGroup, reserveMemberClaims } from "../src/group-state.ts";
import { acceptGroupCandidate, assertGroupRework, bindGroupRework, prepareGroupReview } from "../src/group-review.ts";
import type { GroupAcceptanceObligation } from "../src/group-plan.ts";

const treeHash = "a".repeat(64);
const revisionHash = "b".repeat(64);
const head = "c".repeat(40);
const base = "d".repeat(40);
const obligation: GroupAcceptanceObligation = { id: "A", members: ["YM-1", "YM-2"], repos: ["one/repo"], criterion: "assembled", evidenceRequired: "green" };
const evidence = { id: "A", evidence: { green: true }, hash: canonicalHash({ green: true }) };

function fixture(repos = ["one/repo"]) {
  const db = openDb(":memory:");
  const groupId = createPlanningGroup(db, { id: "g", rootIdentity: "yt:YM-1", rootTicket: "YM-1", ownerProject: "one/repo" });
  reserveMemberClaims(db, { groupId, treeHash, members: ["yt:YM-1", "yt:YM-2"], owners: [{ runtimeId: "r", runId: "x", sessionId: "s" }] });
  activateGroupRevision(db, { groupId, revisionHash, treeHash, manifest: {}, bindings: {}, compatibility: {}, approachReceiptId: "a", members: [{ identity: "yt:YM-1", ticket: "YM-1", parentIdentity: null, execution: "integrated", stage: "integrated" }, { identity: "yt:YM-2", ticket: "YM-2", parentIdentity: "yt:YM-1", execution: "integrated", stage: "integrated" }] });
  db.prepare("UPDATE task_group SET phase='review' WHERE id=?").run(groupId);
  for (const repo of repos) db.prepare(`INSERT INTO group_repository (group_id,revision_hash,repo,remote,role,integration_branch,external_base,base_sha,final_pr,head_sha,ship_state)
    VALUES (?,?,?,?,?,'YM-1','main',?,?,?,'ready')`).run(groupId, revisionHash, repo, `git@github.com:${repo}.git`, "app", base, `https://github.com/${repo}/pull/1`, head);
  return { db, groupId };
}

const deps = {
  verifyRepository: async () => ({ ok: true }),
  verifyObligation: async () => ({ ok: true }),
};

test("prepares and accepts an exact assembled candidate", async () => {
  const { db, groupId } = fixture();
  const candidate = await prepareGroupReview(db, { groupId, revisionHash, obligations: [obligation], evidence: [evidence] }, deps);
  assert.match(candidate.candidateHash, /^[a-f0-9]{64}$/);
  acceptGroupCandidate(db, candidate, { reviewSource: { runId: "review", runtimeId: "runtime", sessionId: "session", candidateHash: candidate.candidateHash }, evidence: { verdict: "accepted" } });
  const group = db.prepare("SELECT phase FROM task_group WHERE id=?").get(groupId) as { phase: string };
  assert.equal(group.phase, "accepted");
  const accepted = db.prepare("SELECT candidate_hash,state FROM group_acceptance").get() as { candidate_hash: string; state: string };
  assert.deepEqual({ ...accepted }, { candidate_hash: candidate.candidateHash, state: "current" });
});

test("semantic candidate review is mandatory when the production dependency requires it", async () => {
  const { db, groupId } = fixture();
  await assert.rejects(() => prepareGroupReview(db, { groupId, revisionHash, obligations: [obligation], evidence: [evidence] }, { ...deps, verifyCandidate: async () => ({ ok: false, reason: "semantic evidence rejected" }) }), /semantic evidence rejected/);
});

test("one changed repository head makes the verdict stale", async () => {
  const { db, groupId } = fixture();
  const candidate = await prepareGroupReview(db, { groupId, revisionHash, obligations: [obligation], evidence: [evidence] }, deps);
  db.prepare("UPDATE group_repository SET head_sha=?").run("e".repeat(40));
  assert.throws(() => acceptGroupCandidate(db, candidate, { reviewSource: { runId: "review", runtimeId: "runtime", sessionId: "session", candidateHash: candidate.candidateHash }, evidence: {} }), /changed/);
});

test("incomplete members, tracker pending and assembled incompatibility block review", async () => {
  const incomplete = fixture();
  incomplete.db.prepare("UPDATE group_member SET execution='ready' WHERE ticket='YM-2'").run();
  await assert.rejects(() => prepareGroupReview(incomplete.db, { groupId: incomplete.groupId, revisionHash, obligations: [obligation], evidence: [evidence] }, deps), /blocked by/);
  const pending = fixture();
  pending.db.prepare(`INSERT INTO group_effect (effect_key,group_id,revision_hash,scope_json,type,input_json,state) VALUES ('t',?,?,'{}','to_verify','{}','failed')`).run(pending.groupId, revisionHash);
  await assert.rejects(() => prepareGroupReview(pending.db, { groupId: pending.groupId, revisionHash, obligations: [obligation], evidence: [evidence] }, deps), /tracker effects/);
  const incompatible = fixture(["one/repo", "two/repo"]);
  await assert.rejects(() => prepareGroupReview(incompatible.db, { groupId: incompatible.groupId, revisionHash, obligations: [obligation], evidence: [evidence] }, { ...deps, verifyRepository: async (part) => ({ ok: part.repo !== "two/repo", reason: "contract mismatch" }) }), /contract mismatch/);
});

test("rework stays bound to the whole candidate and root plan", async () => {
  const { db, groupId } = fixture();
  const candidate = await prepareGroupReview(db, { groupId, revisionHash, obligations: [obligation], evidence: [evidence] }, deps);
  const plan = { ticket: "YM-1", path: "/p", contentHash: "1".repeat(64), scopeHash: "2".repeat(64), repositories: ["one/repo"] };
  const binding = bindGroupRework(candidate, plan, "YM-1");
  assert.doesNotThrow(() => assertGroupRework(candidate, binding, plan));
  assert.throws(() => assertGroupRework({ ...candidate, candidateHash: "0".repeat(64) }, binding, plan), /stale/);
  assert.throws(() => bindGroupRework(candidate, { ...plan, ticket: "YM-2" }, "YM-1"), /root/);
});
