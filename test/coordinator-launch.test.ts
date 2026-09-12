import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { markDoRunning, prepareDo, validateCoordinatorRequest } from "../src/coordinator-launch.ts";

function root(): string {
  const root = mkdtempSync(join(tmpdir(), "coordinator-launch-"));
  mkdirSync(join(root, ".pi", "agents", "do"), { recursive: true });
  mkdirSync(join(root, "home", "knowledge", "org", "repo", "ai", "YM-1-work"), { recursive: true });
  writeFileSync(join(root, ".pi", "settings.json"), "{}");
  writeFileSync(join(root, "home", "knowledge", "org", "repo", "ai", "YM-1-work", "YM-1-work-plan.md"), "# YM-1\n\n## Affected repositories\n- `org/repo` — app\n");
  const db = openDb(join(root, "yokemate.db"));
  db.prepare("INSERT INTO project (org, repo, path, tracker, tracker_key, model) VALUES ('org','repo', ?, 'x', 'YM', 'test/model')").run(join(root, "clone"));
  return root;
}

test("do preparation resolves exact plan parts and CAS prevents stale running write", () => {
  const dir = root();
  try {
    const plan = join(dir, "home", "knowledge", "org", "repo", "ai", "YM-1-work", "YM-1-work-plan.md");
    const prepared = prepareDo(dir, { mode: "do", tickets: ["YM-1"], plan }, {});
    assert.equal(prepared.parts[0]?.repo, "org/repo");
    assert.equal(prepared.model, "test/model");
    const db = openDb(join(dir, "yokemate.db"));
    db.prepare("INSERT INTO work (ticket, url, stage) VALUES ('YM-1','u','review')").run();
    assert.throws(() => markDoRunning(dir, prepared, { YOKEMATE_MODE: "do", YOKEMATE_TICKET: "YM-1", YOKEMATE_ROLE: "coordinator" }), /changed from absent to review/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("do preparation preserves an explicit model without a thinking setting", () => {
  const dir = root();
  try {
    const plan = join(dir, "home", "knowledge", "org", "repo", "ai", "YM-1-work", "YM-1-work-plan.md");
    const prepared = prepareDo(dir, { mode: "do", tickets: ["YM-1"], plan, model: "test/model:high" }, {});
    assert.equal(prepared.model, "test/model:high");
    const settings = JSON.parse(readFileSync(join(prepared.cwd, ".pi", "settings.json"), "utf8"));
    assert.equal("thinkingLevel" in settings, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("coordinator requests reject malformed keys, duplicate batches and multi-ticket do", () => {
  assert.throws(() => validateCoordinatorRequest({ mode: "do", tickets: ["YM-1", "YM-2"] }), /exactly one/);
  assert.throws(() => validateCoordinatorRequest({ mode: "ship", tickets: ["YM-1", "YM-1"] }), /duplicates/);
  assert.throws(() => validateCoordinatorRequest({ mode: "do", tickets: ["../YM-1"] }), /invalid/);
});
