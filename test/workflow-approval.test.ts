import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { readRecordedPlanBinding, type PlanBinding } from "../src/plan-binding.ts";
import { DoAuthorityStore, validateExtraction } from "../src/workflow-approval.ts";

const binding: PlanBinding = { ticket: "YM-1", path: "/knowledge/plan.md", contentHash: "content", scopeHash: "scope", repositories: ["org/repo"] };
const parent = { sessionId: "session", runtimeId: "runtime" };

test("do authority binds exact parent, ticket, plan, generation and single-use cycle", () => {
  const store = new DoAuthorityStore(parent);
  const generation = store.beginInput("/do YM-1");
  store.approve("exact-do", "YM-1", binding, generation);
  for (const changed of [{ ticket: "YM-2" }, { path: "/other" }, { contentHash: "new" }, { scopeHash: "new" }, { repositories: ["org/other"] }]) {
    assert.throws(() => store.check("YM-1", { ...binding, ...changed }, parent), /approval/);
  }
  assert.throws(() => store.check("YM-1", binding, { ...parent, sessionId: "foreign" }), /parent/);
  assert.throws(() => store.check("YM-1", binding, { ...parent, runtimeId: "foreign" }), /parent/);
  const receipt = store.consume("YM-1", binding, parent, "run-1");
  assert.ok(receipt.id);
  assert.equal(receipt.source, "exact-do");
  assert.throws(() => store.consume("YM-1", binding, parent, "run-2"), /consumed/);
  store.checkCycle("run-1", binding);
  assert.throws(() => store.checkCycle("foreign", binding), /cycle/);
  store.beginInput("unrelated input");
  store.checkCycle("run-1", binding);
  assert.throws(() => store.checkCycle("run-1", { ...binding, scopeHash: "new" }), /scope/);
  store.finish("run-1");
  assert.throws(() => store.checkCycle("run-1", binding), /cycle/);
});

test("advance authority only binds an actual record and workflowApproval always stops it", () => {
  for (const stop of [true, false]) {
    const store = new DoAuthorityStore(parent);
    assert.equal(store.record(binding, stop), false);
    store.approve("advance-plan-do", "YM-1", undefined, store.beginInput("plan then do YM-1"));
    assert.throws(() => store.check("YM-1", binding, parent), /record/);
    assert.equal(store.record(binding, stop), !stop);
    if (stop) assert.throws(() => store.check("YM-1", binding, parent), /approval/);
    else store.consume("YM-1", binding, parent, "run");
    assert.equal(store.record(binding, stop), false);
  }
});

test("fresh input, revocation and shutdown cannot restore stale authority", () => {
  const store = new DoAuthorityStore(parent);
  const first = store.beginInput("plan then do YM-1");
  store.approve("advance-plan-do", "YM-1", undefined, first);
  const next = store.beginInput("/do YM-1");
  assert.throws(() => store.approve("exact-do", "YM-1", binding, first), /stale/);
  store.approve("exact-do", "YM-1", binding, next);
  store.consume("YM-1", binding, parent, "owned");
  assert.deepEqual(store.revoke(), ["owned"]);
  assert.throws(() => store.checkCycle("owned", binding), /cycle/);
  assert.throws(() => store.check("YM-1", binding, parent), /approval/);
  store.approve("post-plan-approval", "YM-1", binding, store.beginInput("approved YM-1"));
  store.consume("YM-1", binding, parent, "fresh");
  assert.throws(() => new DoAuthorityStore(parent).check("YM-1", binding, parent), /approval/);
});

test("model extraction is strict and bound to literal current input and known binding references", () => {
  const raw = "план согласован YM-1, запускай";
  const value = { kind: "approve-ready-do", ticket: "YM-1", binding: "content", actions: ["do"], evidence: [{ start: 0, end: raw.length, text: raw }] };
  assert.deepEqual(validateExtraction(value, raw, [binding]), value);
  for (const bad of [{ ...value, extra: true }, { ...value, ticket: "YM-2" }, { ...value, binding: "old" }, { ...value, actions: ["ship"] }, { ...value, evidence: [{ start: 0, end: 4, text: "invented" }] }]) assert.throws(() => validateExtraction(bad, raw, [binding]), /extraction/);
  assert.throws(() => validateExtraction(value, raw, [binding, binding]), /ambiguous/);
});

test("recorded plan binding reads exact bytes, canonical scope and contained regular files", () => {
  const root = mkdtempSync(join(tmpdir(), "plan-binding-"));
  try {
    const folder = join(root, "home", "knowledge", "org", "repo", "ai", "YM-1-work");
    mkdirSync(folder, { recursive: true });
    const path = join(folder, "plan.md");
    const text = "# YM-1 — work\n\n## Affected repositories\n- `org/repo` — app\n\n## Steps\n1. Fix behavior\n\n## Acceptance\nBehavior works\n";
    writeFileSync(path, text);
    const db = openDb(join(root, "yokemate.db"));
    db.prepare("INSERT INTO work (ticket, url, stage, plan) VALUES ('YM-1','u','planned',?)").run(path);
    const first = readRecordedPlanBinding(root, "YM-1");
    assert.deepEqual(first.repositories, ["org/repo"]);
    assert.equal(first.path, path);
    writeFileSync(path, text + "\n");
    assert.notEqual(readRecordedPlanBinding(root, "YM-1").contentHash, first.contentHash);
    writeFileSync(path, text.replace("Fix behavior", "Different scope"));
    assert.notEqual(readRecordedPlanBinding(root, "YM-1").scopeHash, first.scopeHash);
    writeFileSync(path, text.replace("# YM-1", "# YM-2"));
    assert.throws(() => readRecordedPlanBinding(root, "YM-1"), /heading/);
    const outside = join(root, "outside.md");
    writeFileSync(outside, text);
    rmSync(path);
    symlinkSync(outside, path);
    assert.throws(() => readRecordedPlanBinding(root, "YM-1"), /regular|symlink|contain/);
    assert.throws(() => readRecordedPlanBinding(root, "YM-2"), /record/);
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
