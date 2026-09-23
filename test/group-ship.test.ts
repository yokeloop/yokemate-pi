import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { activateGroupRevision, createPlanningGroup, reserveMemberClaims } from "../src/group-state.ts";
import { shipGroup, prepareGroupShip, type GroupShipDeps } from "../src/group-ship.ts";
import type { GroupCandidate } from "../src/group-review.ts";

const treeHash = "a".repeat(64);
const revisionHash = "b".repeat(64);
const base = "c".repeat(40);
const head1 = "d".repeat(40);
const head2 = "e".repeat(40);
const mergeCommit = "f".repeat(40);

function fixture(repos = ["one/repo", "two/repo"]) {
  const db = openDb(":memory:");
  const groupId = createPlanningGroup(db, { id: "g", rootIdentity: "yt:YM-1", rootTicket: "YM-1", ownerProject: "one/repo" });
  reserveMemberClaims(db, { groupId, treeHash, members: ["yt:YM-1", "yt:YM-2"], owners: [{ runtimeId: "r", runId: "x", sessionId: "s" }] });
  activateGroupRevision(db, { groupId, revisionHash, treeHash, manifest: {}, bindings: {}, compatibility: {}, approachReceiptId: "a", members: [{ identity: "yt:YM-1", ticket: "YM-1", parentIdentity: null, execution: "integrated", stage: "integrated" }, { identity: "yt:YM-2", ticket: "YM-2", parentIdentity: "yt:YM-1", execution: "integrated", stage: "integrated" }] });
  const parts = repos.map((repo, index) => ({ repo, pr: `https://github.com/${repo}/pull/1`, headSha: index ? head2 : head1, baseRef: "main", baseSha: base }));
  for (const part of parts) db.prepare(`INSERT INTO group_repository (group_id,revision_hash,repo,remote,role,integration_branch,external_base,base_sha,final_pr,head_sha,ship_state)
    VALUES (?,?,?,?,?,'YM-1','main',?,?,?,'ready')`).run(groupId, revisionHash, part.repo, `git@github.com:${part.repo}.git`, "app", base, part.pr, part.headSha);
  const candidate: GroupCandidate = { groupId, revisionHash, parts, obligationEvidence: [], candidateHash: "9".repeat(64) };
  db.prepare(`INSERT INTO group_acceptance (group_id,revision_hash,candidate_hash,candidate_json,evidence_json,review_source_json,state)
    VALUES (?,?,?,?, '{}','{}','current')`).run(groupId, revisionHash, candidate.candidateHash, JSON.stringify(candidate));
  db.prepare("UPDATE task_group SET phase='accepted' WHERE id=?").run(groupId);
  return { db, groupId, candidate };
}

function shippingDeps(mode: Record<string, "success" | "fail" | "unknown">, done: string[] = []): GroupShipDeps & { mergeCounts: Map<string, number> } {
  const snapshotCounts = new Map<string, number>();
  const mergeCounts = new Map<string, number>();
  return {
    mergeCounts,
    authorized: () => true,
    live: () => true,
    gate: async (part) => ({ ok: true, head: part.headSha }),
    snapshot: async (_cwd, pr) => {
      const repo = new URL(pr).pathname.split("/").slice(1, 3).join("/");
      const count = (snapshotCounts.get(repo) ?? 0) + 1;
      snapshotCounts.set(repo, count);
      const expectedHead = repo === "one/repo" ? head1 : head2;
      const successful = mode[repo] === "success" && count >= 3;
      return { url: pr, state: successful ? "MERGED" : "OPEN", headRefName: "YM-1", headRefOid: expectedHead, baseRefName: "main", ...(successful ? { mergedAt: "now", mergeCommit: { oid: mergeCommit } } : {}) };
    },
    merge: async (_cwd, request) => {
      const repo = new URL(request.pr).pathname.split("/").slice(1, 3).join("/");
      mergeCounts.set(repo, (mergeCounts.get(repo) ?? 0) + 1);
      return mode[repo] === "success" ? { exit: 0, output: "" } : { exit: 1, output: mode[repo] ?? "failed" };
    },
    ensureDone: async (ticket) => { done.push(ticket); },
  };
}

test("refuses without explicit ship and rejects stale accepted facts", async () => {
  const { db, groupId, candidate } = fixture(["one/repo"]);
  const deps = shippingDeps({ "one/repo": "success" });
  await assert.rejects(() => shipGroup(db, "/work/YM-1", groupId, candidate.candidateHash, { ...deps, authorized: () => false }), /explicit-ship/);
  db.prepare("UPDATE group_repository SET head_sha=?").run("0".repeat(40));
  assert.throws(() => prepareGroupShip(db, groupId, candidate.candidateHash), /changed after acceptance/);
});

test("partial multi-repo ship records merged and remaining without Done", async () => {
  const { db, groupId, candidate } = fixture();
  const done: string[] = [];
  const deps = shippingDeps({ "one/repo": "success", "two/repo": "fail" }, done);
  const outcome = await shipGroup(db, "/work/YM-1", groupId, candidate.candidateHash, deps);
  assert.deepEqual(outcome, { state: "partial", merged: ["one/repo"], remaining: ["two/repo"], unknown: [], trackerPending: [], cleanupPending: false });
  assert.deepEqual(done, []);
  assert.equal((db.prepare("SELECT phase FROM task_group WHERE id=?").get(groupId) as { phase: string }).phase, "shipping");
});

test("retry skips confirmed merge, finishes remaining repo, and marks children before root", async () => {
  const { db, groupId, candidate } = fixture();
  const first = shippingDeps({ "one/repo": "success", "two/repo": "fail" });
  await shipGroup(db, "/work/YM-1", groupId, candidate.candidateHash, first);
  const done: string[] = [];
  const retry = shippingDeps({ "one/repo": "success", "two/repo": "success" }, done);
  const outcome = await shipGroup(db, "/work/YM-1", groupId, candidate.candidateHash, retry);
  assert.equal(outcome.state, "done");
  assert.equal(retry.mergeCounts.get("one/repo") ?? 0, 0);
  assert.equal(retry.mergeCounts.get("two/repo"), 1);
  assert.deepEqual(done, ["YM-2", "YM-1"]);
  assert.equal((db.prepare("SELECT phase FROM task_group WHERE id=?").get(groupId) as { phase: string }).phase, "done");
});

test("all merged with tracker failure remains tracker pending", async () => {
  const { db, groupId, candidate } = fixture(["one/repo"]);
  const deps = shippingDeps({ "one/repo": "success" });
  deps.ensureDone = async (ticket) => { if (ticket === "YM-1") throw new Error("tracker unavailable"); };
  const outcome = await shipGroup(db, "/work/YM-1", groupId, candidate.candidateHash, deps);
  assert.deepEqual(outcome.state, "all_merged_tracker_pending");
  assert.deepEqual(outcome.trackerPending, ["YM-1"]);
  assert.equal((db.prepare("SELECT phase FROM task_group WHERE id=?").get(groupId) as { phase: string }).phase, "shipping");
});
