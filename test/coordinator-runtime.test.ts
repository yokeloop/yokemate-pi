import { test } from "node:test";
import assert from "node:assert/strict";
import { CoordinatorRegistry, IDLE_NUDGE_LIMIT, ShipPermitStore, idleVerdict } from "../src/coordinator-runtime.ts";

test("coordinator registry reserves ticket batches atomically and releases terminal runs", () => {
  const registry = new CoordinatorRegistry();
  const first = registry.reserve({ mode: "ship", tickets: ["ACME-1", "ACME-2"] }, {}, "main", "model", "/root", ["acme/a"]);
  assert.throws(() => registry.reserve({ mode: "ship", tickets: ["ACME-2"] }, {}, "main", "model", "/root", ["acme/a"]), /already runs/);
  registry.finalize(first.identity.runId, "blocked", "stopped");
  assert.doesNotThrow(() => registry.reserve({ mode: "ship", tickets: ["ACME-2"] }, {}, "main", "model", "/root", ["acme/a"]));
});

test("a failed preparing reservation finalizes once and can be reserved again", () => {
  const registry = new CoordinatorRegistry();
  const request = { mode: "do" as const, tickets: ["YM-1"] };
  const run = registry.reserve(request, {}, "main", "pending", "/root", []);
  assert.equal(run.state, "preparing");
  assert.equal(registry.active().length, 1);
  const blocked = registry.finalize(run.identity.runId, "blocked", "plan not found");
  assert.deepEqual(registry.active(), []);
  assert.equal(registry.finalize(run.identity.runId, "blocked", "second failure"), blocked);
  assert.equal(blocked.reason, "plan not found");
  const retry = registry.reserve(request, {}, "main", "pending", "/root", []);
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
