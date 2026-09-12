import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { gate } from "../src/gate.ts";
import { git, green, notify, stand, withShim, writePr, writeReceipt } from "./fixtures/gate-stand.ts";

test("gate reads the parts from the plan and checks the branch's PR", async () => {
  const s = stand();
  try {
    writeReceipt(s);
    const head = git(s.worktree, "rev-parse", "HEAD");
    await withShim(s, () => {
      writePr(s, "YM-9", [green("checks"), green("pi-loader-smoke"), notify]);
      assert.deepEqual(gate(s.root, "YM-9"), { ok: true, heads: { "org/repo": head } });
      writePr(s, "YM-9", [green("checks"), green("pi-loader-smoke"), notify], { headRefOid: "e".repeat(40) });
      const refused = gate(s.root, "YM-9");
      assert.equal(refused.ok, false);
      assert.match(refused.ok ? "" : refused.reason, /differs from local branch/);
    });
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("pnpm gate without a key prints its usage", () => {
  const out = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/gate.ts"], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /usage: gate/);
});
