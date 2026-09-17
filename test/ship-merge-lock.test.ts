import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { remoteFromPr } from "../src/ship-merge.ts";
import { runWithShipLock, shipLockPath } from "../src/ship-merge-lock.ts";

test("ship lock serializes contenders for the same remote and base", async () => {
  const root = mkdtempSync(join(tmpdir(), "yokemate-ship-lock-"));
  const log = join(root, "events");
  const child = join(import.meta.dirname, "fixtures", "ship-lock-child.mjs");
  try {
    const results = await Promise.all([
      runWithShipLock(root, "github.com/org/repo", "main", process.execPath, [child, log, "one"]),
      runWithShipLock(root, "github.com/org/repo", "main", process.execPath, [child, log, "two"]),
    ]);
    assert.deepEqual(results.map((result) => result.exit), [0, 0]);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    assert.ok([
      "start one,end one,start two,end two",
      "start two,end two,start one,end one",
    ].includes(lines.join(",")), lines.join(","));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ship lock identity and PR remote include the target repository and base", () => {
  assert.equal(remoteFromPr("https://github.com/org/repo/pull/17"), "github.com/org/repo");
  assert.notEqual(shipLockPath("/root", "github.com/org/repo", "main"), shipLockPath("/root", "github.com/org/repo", "release"));
  assert.notEqual(shipLockPath("/root", "github.com/org/repo", "main"), shipLockPath("/root", "github.com/org/other", "main"));
});
