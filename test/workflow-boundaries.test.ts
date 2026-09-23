import assert from "node:assert/strict";
import { test } from "node:test";
import { GUARD_IDS, GUARD_POLICY_BOUNDARIES, resolveGuardPolicy } from "../src/guard-policy.ts";
import {
  MANDATORY_WORKFLOW_BOUNDARIES,
  MANDATORY_WORKFLOW_BOUNDARY_IDS,
  RECOVERABLE_WORKFLOW_BOUNDARY,
  assertRecoveryBoundary,
  evaluateWorkflowBoundary,
  optionalBoundaryApplicable,
} from "../src/workflow-boundaries.ts";

test("workflow boundary registry keeps mandatory facts immutable and one recovery action eligible", () => {
  assert.deepEqual(Object.keys(MANDATORY_WORKFLOW_BOUNDARIES), [...MANDATORY_WORKFLOW_BOUNDARY_IDS]);
  for (const id of MANDATORY_WORKFLOW_BOUNDARY_IDS) {
    const boundary = MANDATORY_WORKFLOW_BOUNDARIES[id];
    assert.equal(boundary.class, "mandatory");
    assert.equal(boundary.defaultVerdict, "refuse");
    assert.ok(boundary.entrypoints.length > 0);
    assert.deepEqual(evaluateWorkflowBoundary(boundary, { satisfied: false, applicable: false }), {
      id,
      applicable: true,
      verdict: "refuse",
      reason: "boundary not satisfied",
    });
    assert.equal(optionalBoundaryApplicable(boundary), true);
  }
  assert.doesNotThrow(() => assertRecoveryBoundary("plan.scout.transport-input", "accept-plan-scout-input"));
  for (const value of [
    ["workflow.audit", "accept-plan-scout-input"],
    ["plan.scout.transport-input", "force"],
    ["unknown", "accept-plan-scout-input"],
  ]) assert.throws(() => assertRecoveryBoundary(value[0]!, value[1]!), /unknown or immutable/);
  assert.equal(evaluateWorkflowBoundary(RECOVERABLE_WORKFLOW_BOUNDARY, { satisfied: true, action: "force" }).verdict, "refuse");
});

test("each guard setting maps exhaustively to its own optional policy boundary", () => {
  assert.deepEqual(Object.keys(GUARD_POLICY_BOUNDARIES), [...GUARD_IDS]);
  for (const id of GUARD_IDS) {
    const boundary = GUARD_POLICY_BOUNDARIES[id];
    assert.equal(boundary.id, `policy.${id}`);
    assert.equal(boundary.class, "optional");
    assert.ok(boundary.entrypoints.length > 0);
    const on = resolveGuardPolicy({ guards: { [id]: true } });
    const off = resolveGuardPolicy({ guards: { [id]: false } });
    assert.equal(optionalBoundaryApplicable(boundary, on), true);
    assert.equal(optionalBoundaryApplicable(boundary, off), false);
    assert.equal(evaluateWorkflowBoundary(boundary, { satisfied: false, policy: on }).verdict, "refuse");
    assert.deepEqual(evaluateWorkflowBoundary(boundary, { satisfied: false, policy: off }), {
      id: `policy.${id}`,
      applicable: false,
      verdict: "allow",
      reason: "inapplicable",
    });
  }
});

test("boundary evaluator errors fail closed", () => {
  const boundary = { ...MANDATORY_WORKFLOW_BOUNDARIES["workflow.audit"] };
  Object.defineProperty(boundary, "class", { get() { throw new Error("fault"); } });
  assert.equal(evaluateWorkflowBoundary(boundary, { satisfied: true }).verdict, "refuse");
});
