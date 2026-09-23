import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { activateGroupRevision, createPlanningGroup, recordGroupEffect, reserveMemberClaims } from "../src/group-state.ts";
import { startGroupDo, type GroupDelegateRequest, type GroupMemberLaunch } from "../src/group-runtime.ts";
import type { GroupExecutionManifest } from "../src/group-plan.ts";

const treeHash = "a".repeat(64);
const revisionHash = "b".repeat(64);
const members = ["YM-1", "YM-2", "YM-3", "YM-4"];
const manifest: GroupExecutionManifest = {
  version: 1, root: "YM-1", ownerProject: "o/r",
  members: members.map((ticket, index) => ({ ticket, parent: index ? "YM-1" : null, ownWork: "coordination-only", implementationRepos: [], requirements: [`R${index + 1}`] })),
  requirements: members.map((ticket, index) => ({ id: `R${index + 1}`, sourceTicket: ticket, text: ticket, owner: ticket, planStep: "1", acceptance: "done" })),
  contracts: [{ id: "C", providers: ["YM-2"], consumers: ["YM-4"], specification: "v1", verification: "test" }],
  startDependencies: [{ before: "YM-2", after: "YM-3", when: "integrated" }, { before: "YM-2", after: "YM-4", when: "contract-approved", contractId: "C" }],
  acceptanceObligations: [{ id: "A", members, repos: [], criterion: "all", evidenceRequired: "review" }], repositories: [], planRefs: members.map((ticket) => ({ ticket, path: `ai/${ticket}-x/${ticket}-x-plan.md` })),
};

function fixture(delegate: (request: GroupDelegateRequest) => Promise<GroupMemberLaunch>, capacity: number | (() => number) = 2) {
  const db = openDb(":memory:");
  const groupId = createPlanningGroup(db, { id: "g", rootIdentity: "yt:YM-1", rootTicket: "YM-1", ownerProject: "o/r" });
  reserveMemberClaims(db, { groupId, treeHash, members: members.map((ticket) => `yt:${ticket}`), owners: [{ runtimeId: "r", runId: "x", sessionId: "s" }] });
  activateGroupRevision(db, { groupId, revisionHash, treeHash, manifest, bindings: {}, compatibility: {}, approachReceiptId: "a", members: members.map((ticket, index) => ({ identity: `yt:${ticket}`, ticket, parentIdentity: index ? "yt:YM-1" : null })) });
  const runtime = startGroupDo(db, groupId, revisionHash, manifest, { capacity: typeof capacity === "function" ? capacity : () => capacity, delegate });
  return { db, groupId, runtime };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("resume completes a fully integrated group only after every tracker effect is confirmed", () => {
  const db = openDb(":memory:");
  const groupId = createPlanningGroup(db, { id: "g-resume", rootIdentity: "yt:YM-1", rootTicket: "YM-1", ownerProject: "o/r" });
  reserveMemberClaims(db, { groupId, treeHash, members: members.map((ticket) => `yt:${ticket}`), owners: [{ runtimeId: "r", runId: "x", sessionId: "s" }] });
  activateGroupRevision(db, { groupId, revisionHash, treeHash, manifest, bindings: {}, compatibility: {}, approachReceiptId: "a", members: members.map((ticket, index) => ({ identity: `yt:${ticket}`, ticket, parentIdentity: index ? "yt:YM-1" : null, execution: "integrated", stage: "integrated" })) });
  db.prepare("UPDATE task_group SET phase='running' WHERE id=?").run(groupId);
  for (const ticket of members) recordGroupEffect(db, { key: `to-verify:${groupId}:${revisionHash}:${ticket}`, groupId, revisionHash, type: "to_verify", scope: { member: `yt:${ticket}`, ticket }, input: { state: "To Verify" }, state: "confirmed", outcome: { state: "To Verify" } });
  const runtime = startGroupDo(db, groupId, revisionHash, manifest, { capacity: () => 2, delegate: async () => { throw new Error("unexpected delegation"); } });
  assert.equal(runtime.snapshot().state, "complete");
  assert.equal((db.prepare("SELECT phase FROM task_group WHERE id=?").get(groupId) as { phase: string }).phase, "review");
});

test("starts independent members up to capacity and retains overflow queued", async () => {
  const launched: string[] = [];
  const { runtime } = fixture(async (request) => { launched.push(request.member); return { runId: `run-${request.member}`, cancel() {} }; });
  await tick();
  assert.deepEqual(launched, ["YM-1", "YM-2"]);
  assert.deepEqual(runtime.snapshot().queued, ["YM-3", "YM-4"]);
});

test("capacity admission refusal returns a member to the queue for a later pump", async () => {
  let available = 1;
  let attempts = 0;
  const { db, runtime } = fixture(async (request) => {
    attempts++;
    if (attempts === 1) throw new Error("coordinator capacity exhausted");
    return { runId: request.member, cancel() {} };
  }, () => available);
  await tick();
  assert.equal((db.prepare("SELECT execution FROM group_member WHERE ticket='YM-1'").get() as { execution: string }).execution, "queued");
  available = 2;
  runtime.contractApproved("C");
  await tick();
  assert.ok(runtime.snapshot().active.length > 0);
});

test("an integrated dependency releases a child before an unrelated member finishes", async () => {
  const launched: string[] = [];
  const { runtime } = fixture(async (request) => { launched.push(request.member); return { runId: request.member, cancel() {} }; });
  await tick();
  runtime.memberReady("YM-2", { ok: true });
  runtime.memberIntegrated("YM-2");
  await tick();
  assert.deepEqual(launched, ["YM-1", "YM-2", "YM-3"]);
  assert.equal(runtime.snapshot().active.some((item) => item.member === "YM-1"), true);
});

test("contract approval releases only its declared edge", async () => {
  const launched: string[] = [];
  const { runtime } = fixture(async (request) => { launched.push(request.member); return { runId: request.member, cancel() {} }; }, 3);
  await tick();
  assert.deepEqual(launched, ["YM-1", "YM-2"]);
  runtime.contractApproved("C");
  await tick();
  assert.deepEqual(launched, ["YM-1", "YM-2", "YM-4"]);
});

test("failure blocks dependent predicates while independent work continues", async () => {
  const launched: string[] = [];
  const { db, runtime } = fixture(async (request) => {
    launched.push(request.member);
    if (request.member === "YM-2") throw new Error("failed check");
    return { runId: request.member, cancel() {} };
  });
  await tick();
  await tick();
  assert.deepEqual(launched, ["YM-1", "YM-2"]);
  const rows = db.prepare("SELECT ticket,execution,blocker FROM group_member WHERE group_id='g' ORDER BY ticket").all() as unknown as { ticket: string; execution: string; blocker: string | null }[];
  assert.equal(rows.find((row) => row.ticket === "YM-2")?.execution, "blocked");
  assert.match(rows.find((row) => row.ticket === "YM-3")?.blocker ?? "", /blocked YM-2/);
});

test("stop fences late launch ACKs and never starts another queued member", async () => {
  let resolveLaunch!: (launch: GroupMemberLaunch) => void;
  const launched: string[] = [];
  let cancelled = 0;
  const { runtime } = fixture((request) => { launched.push(request.member); return new Promise((resolve) => { if (!resolveLaunch) resolveLaunch = resolve; }); }, 1);
  await tick();
  const stopping = runtime.stop("engineer stopped");
  resolveLaunch({ runId: "late", cancel() { cancelled++; } });
  await stopping;
  await tick();
  assert.deepEqual(launched, ["YM-1"]);
  assert.equal(cancelled, 1);
  assert.equal(runtime.snapshot().state, "blocked");
});
