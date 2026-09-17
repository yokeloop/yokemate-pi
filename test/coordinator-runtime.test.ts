import { test } from "node:test";
import assert from "node:assert/strict";
import { CoordinatorRegistry, IDLE_NUDGE_LIMIT, ShipPermitStore, idleVerdict } from "../src/coordinator-runtime.ts";

test("coordinator registry reserves ticket batches atomically and releases terminal runs", () => {
  const registry = new CoordinatorRegistry();
  const first = registry.reserve({ mode: "ship", tickets: ["ACME-1", "ACME-2"] }, {}, "main", "model", "/root", ["acme/a"], true);
  assert.throws(() => registry.reserve({ mode: "ship", tickets: ["ACME-2"] }, {}, "main", "model", "/root", ["acme/a"], true), /already runs/);
  registry.finalize(first.identity.runId, "blocked", "stopped");
  assert.doesNotThrow(() => registry.reserve({ mode: "ship", tickets: ["ACME-2"] }, {}, "main", "model", "/root", ["acme/a"], true));
});

test("a failed preparing reservation finalizes once and can be reserved again", () => {
  const registry = new CoordinatorRegistry();
  const request = { mode: "do" as const, tickets: ["YM-1"] };
  const run = registry.reserve(request, {}, "main", "pending", "/root", [], true);
  assert.equal(run.state, "preparing");
  assert.equal(registry.active().length, 1);
  const blocked = registry.finalize(run.identity.runId, "blocked", "plan not found");
  assert.deepEqual(registry.active(), []);
  assert.equal(registry.finalize(run.identity.runId, "blocked", "second failure"), blocked);
  assert.equal(blocked.reason, "plan not found");
  const retry = registry.reserve(request, {}, "main", "pending", "/root", [], true);
  assert.notEqual(retry.identity.runId, run.identity.runId);
  assert.deepEqual(registry.active(), [retry]);
});

test("ship permit is exact, single-use and invalidated by later input", () => {
  const permits = new ShipPermitStore();
  permits.observeInteractiveShip(["ACME-1", "ACME-2"], "main");
  assert.equal(permits.consume(["ACME-2", "ACME-1"], "main"), false);
  assert.equal(permits.consume(["ACME-1", "ACME-2"], "other"), false);
  assert.equal(permits.consume(["ACME-1", "ACME-2"], "main"), true);
  assert.equal(permits.consume(["ACME-1", "ACME-2"], "main"), false);
  permits.observeInteractiveShip(["ACME-3"], "main");
  permits.invalidate();
  assert.equal(permits.consume(["ACME-3"], "main"), false);
});

test("idle verdict waits on live children, nudges a bounded number of times, then blocks", () => {
  assert.equal(idleVerdict({ nudges: 0, hasChildren: true }), "wait");
  assert.equal(idleVerdict({ nudges: 99, hasChildren: true }), "wait");
  assert.equal(idleVerdict({ nudges: 0, hasChildren: false }), "nudge");
  assert.equal(idleVerdict({ nudges: IDLE_NUDGE_LIMIT - 1, hasChildren: false }), "nudge");
  assert.equal(idleVerdict({ nudges: IDLE_NUDGE_LIMIT, hasChildren: false }), "blocked");
});

test("coordinator checks use the same policy and limits as ordinary admission", async () => {
  const { coordinatorChecks } = await import("../src/coordinator-runtime.ts");
  const { resolveRuntimeSettings } = await import("../src/guard-policy.ts");
  const on = coordinatorChecks(resolveRuntimeSettings({ subagent: { maxParallelTasks: 1, maxConcurrency: 1, maxDetached: 1 } }));
  const off = coordinatorChecks(resolveRuntimeSettings({ guardPolicy: { yolo: true } }));
  for (const mode of ["do", "ship"] as const) {
    assert.equal(on.rejectDuplicate(mode), true);
    assert.equal(off.rejectDuplicate(mode), false);
  }
  assert.match(on.checkCaller({ YOKEMATE_MODE: "plan" }, { mode: "do", tickets: ["YM-1"] }) ?? "", /main chat/);
  assert.equal(off.checkCaller({ YOKEMATE_MODE: "review" }, { mode: "do", tickets: ["YM-1"] }), undefined);
  assert.match(on.checkAdmission(1) ?? "", /Too many detached/);
  assert.equal(off.checkAdmission(100), undefined);
  assert.equal(on.needsShipConfirmation({}), true);
  assert.equal(off.needsShipConfirmation({}), false);
});

test("duplicate off keeps independent atomic reservations and release does not hide siblings", () => {
  for (const mode of ["do", "ship"] as const) {
    const registry = new CoordinatorRegistry();
    const request = { mode, tickets: ["YM-1"] };
    const first = registry.reserve(request, {}, "main", "model", "/root", [], false);
    const second = registry.reserve(request, {}, "main", "model", "/root", [], false);
    assert.notEqual(first.identity.runId, second.identity.runId);
    registry.finalize(first.identity.runId, "blocked", "stopped");
    assert.throws(() => registry.reserve(request, {}, "main", "model", "/root", [], true), /already runs/);
    assert.deepEqual(registry.active(), [second]);
    registry.finalize(second.identity.runId, "blocked", "stopped");
    assert.doesNotThrow(() => registry.reserve(request, {}, "main", "model", "/root", [], true));
  }
});
