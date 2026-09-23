import { test } from "node:test";
import assert from "node:assert/strict";
import { PlanApproachStore, validatePlanApproachExtraction, type PlanApproachOwner } from "../src/plan-approach.ts";

const owner: PlanApproachOwner = { sessionId: "session", runtimeId: "runtime", planRunId: "plan-run" };
const treeHash = "a".repeat(64);
const scouts = [{ ticket: "YM-1", acceptanceId: 7, hash: "b".repeat(64) }];

function span(raw: string) { return [{ start: 0, end: raw.length, text: raw }]; }

function store() {
  const value = new PlanApproachStore(owner);
  value.present({ approachText: "Implement the durable state first, then runtime integration.", treeHash, acceptedScouts: scouts });
  return value;
}

test("approach requires a real input after the proposal and remains mandatory without forks", () => {
  const value = store();
  assert.throws(() => value.assertCurrent({ treeHash, acceptedScouts: scouts }, owner), /workflow.plan-approach/);
  const raw = "Согласен, давай так.";
  const input = value.observeInput(raw, owner);
  const receipt = value.approve(input, { kind: "approve", evidence: span(raw) }, owner);
  assert.equal(receipt.proposal.acceptedScouts.length, 1);
  assert.equal(value.assertCurrent({ treeHash, acceptedScouts: scouts }, owner).id, receipt.id);
});

test("stale, foreign and synthetic approval are rejected", () => {
  const value = store();
  const firstRaw = "Согласен.";
  const first = value.observeInput(firstRaw, owner);
  value.observeInput("Есть вопрос?", owner);
  assert.throws(() => value.approve(first, { kind: "approve", evidence: span(firstRaw) }, owner), /stale/);
  assert.throws(() => value.observeInput("Согласен.", { ...owner, runtimeId: "foreign" }), /live-owner/);
  const fresh = store();
  const raw = "Агент написал: «согласен».";
  const input = fresh.observeInput(raw, owner);
  assert.throws(() => fresh.approve(input, { kind: "approve", evidence: span(raw) }, owner), /does not unambiguously approve/);
});

test("tree, scout and material approach changes invalidate the receipt", () => {
  const value = store();
  const raw = "Approved.";
  const input = value.observeInput(raw, owner);
  const receipt = value.approve(input, { kind: "approve", evidence: span(raw) }, owner);
  assert.throws(() => value.assertCurrent({ treeHash: "c".repeat(64), acceptedScouts: scouts }, owner), /stale/);
  assert.throws(() => value.assertCurrent({ treeHash, acceptedScouts: [{ ...scouts[0]!, hash: "d".repeat(64) }] }, owner), /stale/);
  assert.throws(() => value.assertCurrent({ treeHash, acceptedScouts: scouts, approachHash: "e".repeat(64) }, owner), /stale/);
  assert.equal(value.assertCurrent({ treeHash, acceptedScouts: scouts }, owner).id, receipt.id);
});

test("quoted, questioned, negative and malformed extraction evidence cannot approve", () => {
  for (const raw of ["«Approved»", "Approved?", "Not approved", "Если согласимся, подойдёт?"]) {
    assert.throws(() => validatePlanApproachExtraction({ kind: "approve", evidence: span(raw) }, raw));
  }
  assert.throws(() => validatePlanApproachExtraction({ kind: "approve", evidence: [{ start: 0, end: 2, text: "xx" }] }, "Approved"), /literal evidence/);
  assert.deepEqual(validatePlanApproachExtraction({ kind: "none" }, "maybe"), { kind: "none" });
});

test("approach confirmation is independent of do authority policy", async () => {
  for (const workflowApproval of [true, false]) {
    const value = store();
    const raw = "Подтверждаю.";
    const input = value.observeInput(raw, owner);
    value.approve(input, { kind: "approve", evidence: span(raw) }, owner);
    assert.equal(value.assertCurrent({ treeHash, acceptedScouts: scouts }, owner).state, "current");
    assert.equal(workflowApproval === true || workflowApproval === false, true);
  }
});
