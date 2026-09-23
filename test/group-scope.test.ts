import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { activateGroupRevision, createPlanningGroup, reserveMemberClaims } from "../src/group-state.ts";
import { resolveGroupWorkScope } from "../src/group-scope.ts";

const treeHash = "a".repeat(64);
const revisionHash = "b".repeat(64);

function fixture() {
  const db = openDb(":memory:");
  const groupId = createPlanningGroup(db, { id: "g", rootIdentity: "yt:YM-1", rootTicket: "YM-1", ownerProject: "o/r" });
  reserveMemberClaims(db, { groupId, treeHash, members: ["yt:YM-1", "yt:YM-2"], owners: [{ runtimeId: "r", runId: "x", sessionId: "s" }] });
  activateGroupRevision(db, { groupId, revisionHash, treeHash, manifest: {}, bindings: {}, compatibility: {}, approachReceiptId: "a", members: [{ identity: "yt:YM-1", ticket: "YM-1", parentIdentity: null }, { identity: "yt:YM-2", ticket: "YM-2", parentIdentity: "yt:YM-1" }] });
  for (const repo of ["one/shared", "two/shared"]) db.prepare(`INSERT INTO group_repository (group_id,revision_hash,repo,remote,role,integration_branch,external_base,base_sha)
    VALUES (?,?,?,?,?,'YM-1','main',?)`).run(groupId, revisionHash, repo, `git@github.com:${repo}.git`, "app", "c".repeat(40));
  db.prepare(`INSERT INTO group_part (group_id,revision_hash,member_identity,repo,remote,role,source_ref,target_ref)
    VALUES (?,?,?,?,?,'app','YM-1-own','YM-1')`).run(groupId, revisionHash, "yt:YM-1", "one/shared", "git@github.com:one/shared.git");
  db.prepare(`INSERT INTO group_part (group_id,revision_hash,member_identity,repo,remote,role,source_ref,target_ref)
    VALUES (?,?,?,?,?,'app','YM-2','YM-1')`).run(groupId, revisionHash, "yt:YM-2", "two/shared", "git@github.com:two/shared.git");
  return { db, groupId };
}

test("root own and integration scopes are distinct", () => {
  const { db, groupId } = fixture();
  const integration = resolveGroupWorkScope(db, "/work/YM-1", { groupId, revisionHash, memberIdentity: "yt:YM-1", kind: "integration", repo: "one/shared" });
  const own = resolveGroupWorkScope(db, "/work/YM-1", { groupId, revisionHash, memberIdentity: "yt:YM-1", kind: "root-own", repo: "one/shared" });
  assert.equal(integration.branch, "YM-1");
  assert.equal(own.branch, "YM-1-own");
  assert.notEqual(integration.worktree, own.worktree);
  assert.notEqual(integration.scopeId, own.scopeId);
});

test("same repository names in different organizations do not collide", () => {
  const { db, groupId } = fixture();
  const one = resolveGroupWorkScope(db, "/work/YM-1", { groupId, revisionHash, memberIdentity: "yt:YM-1", kind: "integration", repo: "one/shared" });
  const two = resolveGroupWorkScope(db, "/work/YM-1", { groupId, revisionHash, memberIdentity: "yt:YM-1", kind: "integration", repo: "two/shared" });
  assert.match(one.worktree!, /integration\/one\/shared$/);
  assert.match(two.worktree!, /integration\/two\/shared$/);
});

test("member target, root kind and foreign revision fail closed", () => {
  const { db, groupId } = fixture();
  const member = resolveGroupWorkScope(db, "/work/YM-1", { groupId, revisionHash, memberIdentity: "yt:YM-2", kind: "member", repo: "two/shared" });
  assert.equal(member.targetBranch, "YM-1");
  assert.throws(() => resolveGroupWorkScope(db, "/work/YM-1", { groupId, revisionHash, memberIdentity: "yt:YM-2", kind: "root-own", repo: "two/shared" }), /group root/);
  assert.throws(() => resolveGroupWorkScope(db, "/work/YM-1", { groupId, revisionHash: "f".repeat(64), memberIdentity: "yt:YM-2", kind: "member", repo: "two/shared" }), /inactive/);
});

test("coordination-only has no fake git scope", () => {
  const { db, groupId } = fixture();
  const scope = resolveGroupWorkScope(db, "/work/YM-1", { groupId, revisionHash, memberIdentity: "yt:YM-1", kind: "coordination" });
  assert.equal(scope.repo, null);
  assert.equal(scope.worktree, null);
  assert.equal(scope.pr, null);
});
