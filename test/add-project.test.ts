import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

function fixture(pool?: string) {
  const root = mkdtempSync(join(tmpdir(), "add-project-"));
  cpSync(join(import.meta.dirname, "..", "src"), join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  mkdirSync(join(root, "home"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  symlinkSync("/usr/bin/git", join(bin, "git"));
  // assertModel -> piList must never fall through to a system Pi installation.
  writeFileSync(join(bin, "pi"), `#!${process.execPath}
import fs from "node:fs";
if (process.argv[2] !== "--offline" || process.argv[3] !== "--list-models") process.exit(1);
fs.appendFileSync(${JSON.stringify(join(root, "pi-calls.jsonl"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log("provider model context max-out thinking images\\ntest pool-do 1 1 yes yes\\ntest review-override 1 1 yes yes\\ntest explicit 1 1 yes yes");
`, { mode: 0o755 });
  assert.equal(realpathSync(join(bin, "pi")), join(bin, "pi"));
  if (pool !== undefined) writeFileSync(join(root, "home", "pool.json"), pool);
  const clone = join(root, "clone");
  mkdirSync(clone);
  execFileSync("git", ["-C", clone, "init", "-q"]);
  execFileSync("git", ["-C", clone, "remote", "add", "origin", "https://github.com/demo/example.git"]);
  return { root, clone };
}

function run(root: string, clone: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", join(root, "src", "add-project.ts"), clone, "--tracker", "github:DEMO", ...args],
    { cwd: root, env: { PATH: join(root, "bin"), HOME: root }, encoding: "utf8", timeout: 10000 },
  );
}

function recorded(root: string) {
  const db = new DatabaseSync(join(root, "yokemate.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT model, mode_models FROM project").get() as { model: string; mode_models: string | null };
    const manifest = JSON.parse(readFileSync(join(root, "home", "projects.json"), "utf8"));
    return { row, manifest: manifest[0] as { model: string; mode_models: Record<string, string> | null } };
  } finally {
    db.close();
  }
}

test("add-project seeds its concrete default from pool.do", () => {
  const { root, clone } = fixture('{"do":"pool-do"}');
  try {
    const out = run(root, clone, ["--model", "review=review-override"]);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(readFileSync(join(root, "pi-calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)), [
      ["--offline", "--list-models", "pool-do"], ["--offline", "--list-models", "review-override"],
    ]);
    const { row, manifest } = recorded(root);
    assert.equal(row.model, "pool-do");
    assert.equal(manifest.model, "pool-do");
    assert.deepEqual(JSON.parse(row.mode_models!), { review: "review-override" });
    assert.deepEqual(manifest.mode_models, { review: "review-override" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add-project explicit scalar model does not read the pool", () => {
  for (const pool of [undefined, "not json"] as const) {
    const { root, clone } = fixture(pool);
    try {
      const out = run(root, clone, ["--model", "explicit"]);
      assert.equal(out.status, 0, out.stderr);
      const { row, manifest } = recorded(root);
      assert.equal(row.model, "explicit");
      assert.equal(manifest.model, "explicit");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("add-project refuses a partial pool without do before writing", () => {
  const { root, clone } = fixture('{"review":"only-review"}');
  try {
    const out = run(root, clone, []);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, new RegExp(`no do model in ${join(root, "home", "pool.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.equal(existsSync(join(root, "yokemate.db")), false);
    assert.equal(existsSync(join(root, "home", "projects.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
