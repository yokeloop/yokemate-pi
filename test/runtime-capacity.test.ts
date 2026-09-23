import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processStarttime } from "../src/coordinator-control.ts";
import { availableRuntimeCapacity, releaseRuntimeCapacity, reserveRuntimeCapacity } from "../src/runtime-capacity.ts";

test("shared runtime capacity serializes independent owners and releases exact leases", () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-capacity-"));
  const db = join(root, "state.db");
  const starttime = processStarttime(process.pid)!;
  reserveRuntimeCapacity(db, { ownerId: "detached:a", pid: process.pid, starttime, units: 2 }, 3);
  assert.equal(availableRuntimeCapacity(db, 3, "detached"), 1);
  assert.throws(() => reserveRuntimeCapacity(db, { ownerId: "detached:b", pid: process.pid, starttime, units: 2 }, 3), /capacity exhausted/);
  reserveRuntimeCapacity(db, { ownerId: "running:b", pid: process.pid, starttime, units: 2 }, 3);
  releaseRuntimeCapacity(db, "detached:a");
  reserveRuntimeCapacity(db, { ownerId: "detached:b", pid: process.pid, starttime, units: 2 }, 3);
  assert.equal(availableRuntimeCapacity(db, 3, "detached"), 1);
  rmSync(root, { recursive: true, force: true });
});

test("dead process leases are pruned before admission", () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-capacity-dead-"));
  const db = join(root, "state.db");
  reserveRuntimeCapacity(db, { ownerId: "running:dead", pid: 999999, starttime: "missing", units: 1 }, 1);
  assert.equal(availableRuntimeCapacity(db, 1, "running"), 1);
  rmSync(root, { recursive: true, force: true });
});
