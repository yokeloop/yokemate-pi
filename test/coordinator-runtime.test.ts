import { test } from "node:test";
import assert from "node:assert/strict";
import { CoordinatorRegistry, ShipPermitStore } from "../src/coordinator-runtime.ts";

test("coordinator registry reserves ticket batches atomically and releases terminal runs", () => {
  const registry = new CoordinatorRegistry();
  const first = registry.reserve({ mode: "ship", tickets: ["ACME-1", "ACME-2"] }, {}, "main", "model", "/root", ["acme/a"]);
  assert.throws(() => registry.reserve({ mode: "ship", tickets: ["ACME-2"] }, {}, "main", "model", "/root", ["acme/a"]), /already runs/);
  registry.finalize(first.identity.runId, "blocked", "stopped");
  assert.doesNotThrow(() => registry.reserve({ mode: "ship", tickets: ["ACME-2"] }, {}, "main", "model", "/root", ["acme/a"]));
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
