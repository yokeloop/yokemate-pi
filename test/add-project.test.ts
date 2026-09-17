import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

function fixture(pool?: string) {
  const root = mkdtempSync(join(tmpdir(), "add-project-"));
  cpSync(join(import.meta.dirname, "..", "src"), join(root, "src"), { recursive: true });
  mkdirSync(join(root, "home"));
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
    { cwd: root, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" },
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
