import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { readRecordedPlanBinding, readWorkflowBindingSnapshot, type PlanBinding } from "../src/plan-binding.ts";
import { DoAuthorityStore, isWorkflowCandidate, PendingWorkflowExtraction, validateExtraction, visibleWorkflowText } from "../src/workflow-approval.ts";

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
  const implicitRaw = "план согласован, запускай";
  const implicit = { ...value, evidence: [{ start: 0, end: implicitRaw.length, text: implicitRaw }] };
  assert.deepEqual(validateExtraction(implicit, implicitRaw, [binding]), implicit);
  const other = { ...binding, ticket: "YM-2", contentHash: "other" };
  assert.throws(() => validateExtraction(implicit, implicitRaw, [binding, other]), /ambiguous/);
  const advance = { kind: "advance-plan-do", ticket: "YM-1", binding: null, actions: ["plan", "do"], evidence: [{ start: 0, end: implicitRaw.length, text: implicitRaw }] };
  assert.throws(() => validateExtraction(advance, implicitRaw, [binding]), /literal/);
});

test("workflow prefilter routes only visible execution candidates", () => {
  for (const raw of ["Plan and then do YM-1", "Спланируй YM-1 и затем выполни", "План согласован, запускай YM-1", "The plan is approved; implement it", "Stop YM-1", "Не запускай YM-1"]) assert.equal(isWorkflowCandidate(raw), true, raw);
  for (const raw of ["YM-1", "What is the status of YM-1?", "Объясни план YM-1", "Исправь обычный баг", "`Plan and then do YM-1`", "> Plan and then do YM-1", "Он сказал «План согласован, запускай YM-1»", "The word plan is informational"]) assert.equal(isWorkflowCandidate(raw), false, raw);
  assert.equal(visibleWorkflowText("до `Plan and then do YM-1` после").length, "до `Plan and then do YM-1` после".length);
});

test("final extraction rejects quoted, hypothetical, questioned and negative approval", () => {
  const make = (raw: string) => ({ kind: "approve-ready-do", ticket: "YM-1", binding: "content", actions: ["do"], evidence: [{ start: 0, end: raw.length, text: raw }] });
  for (const raw of ["«План согласован, запускай YM-1»", "If the plan is approved, implement YM-1", "Should we implement the approved plan YM-1?", "Approved plan, do not implement YM-1"]) assert.throws(() => validateExtraction(make(raw), raw, [binding]), /extraction/, raw);
});

test("pending extraction shares one deadline and makes timeout or cancellation terminal", async () => {
  let monotonic = 10;
  let timer!: () => void;
  const store = new DoAuthorityStore(parent);
  const generation = store.beginInput("Plan and then do YM-1");
  const operation = new PendingWorkflowExtraction(parent, store, generation, { timeoutMs: 20, wallNow: () => 1000 + monotonic, monotonicNow: () => monotonic, setTimer: (callback) => { timer = callback; return 1; }, clearTimer: () => {} });
  let release!: (value: any) => void;
  let effects = 0;
  operation.start(() => new Promise((resolve) => { release = resolve; }));
  const first = operation.wait();
  const second = operation.wait();
  monotonic = 30;
  timer();
  assert.equal(operation.controller.signal.aborted, true);
  assert.equal((await first).outcome, "timeout");
  assert.strictEqual(await second, await first);
  release({ outcome: "approval", effect: () => { effects++; } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(effects, 0);
  assert.equal(operation.cancel("new_input"), false);

  const nextGeneration = store.beginInput("Plan and then do YM-1");
  const cancelled = new PendingWorkflowExtraction(parent, store, nextGeneration, { timeoutMs: 20, setTimer: () => 2, clearTimer: () => {} });
  assert.equal(cancelled.cancel("interrupt"), true);
  assert.equal(cancelled.cancel("interrupt"), false);
  assert.deepEqual((await cancelled.wait()).reason, "interrupt");
});

test("invalidateUnconsumed preserves active cycles and invalidates unused receipts", () => {
  const store = new DoAuthorityStore(parent);
  let generation = store.beginInput("/do YM-1");
  store.approve("exact-do", "YM-1", binding, generation);
  store.consume("YM-1", binding, parent, "active");
  generation = store.beginInput("/do YM-2");
  const other = { ...binding, ticket: "YM-2" };
  store.approve("exact-do", "YM-2", other, generation);
  store.invalidateUnconsumed();
  store.checkCycle("active", binding);
  assert.throws(() => store.check("YM-2", other, parent), /approval/);
  assert.deepEqual(store.revoke(), ["active"]);
});

test("recorded plan binding reads exact bytes, canonical scope and contained regular files", () => {
  const root = mkdtempSync(join(tmpdir(), "plan-binding-"));
  try {
    const folder = join(root, "home", "knowledge", "org", "repo", "ai", "YM-1-work");
    mkdirSync(folder, { recursive: true });
    const path = join(folder, "plan.md");
    const text = "# YM-1 — work\n\n## Goal\nShip work.\n\n## Affected repositories\n- `org/repo` — app\n\n## Steps\n1. Fix behavior\n\n## Assumptions\n- Existing contract.\n\n## Out of scope\n- Other work.\n\n## Acceptance\nBehavior works.\n";
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

test("async workflow snapshot matches synchronous validation and skips invalid rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-snapshot-"));
  try {
    const make = (ticket: string, step: string) => {
      const folder = join(root, "home", "knowledge", "org", "repo", "ai", `${ticket}-work`);
      mkdirSync(folder, { recursive: true });
      const path = join(folder, "plan.md");
      writeFileSync(path, `# ${ticket} — work\n\n## Goal\nShip work.\n\n## Affected repositories\n- \`org/repo\` — app\n\n## Steps\n1. ${step}\n\n## Assumptions\n- Existing contract.\n\n## Out of scope\n- Other work.\n\n## Acceptance\nBehavior works.\n`);
      return path;
    };
    const firstPath = make("YM-1", "First");
    const secondPath = make("YM-2", "Second");
    const invalidPath = make("YM-3", "Invalid");
    writeFileSync(invalidPath, "not a plan");
    const db = openDb(join(root, "yokemate.db"));
    for (const [ticket, path] of [["YM-2", secondPath], ["YM-1", firstPath], ["YM-3", invalidPath]]) db.prepare("INSERT INTO work (ticket,url,stage,plan) VALUES (?,?,'planned',?)").run(ticket, `u-${ticket}`, path);
    db.close();
    const snapshot = await readWorkflowBindingSnapshot(root, new AbortController().signal);
    assert.deepEqual(snapshot.map((item) => item.ticket), ["YM-1", "YM-2"]);
    assert.deepEqual(snapshot[0], readRecordedPlanBinding(root, "YM-1"));
    assert.deepEqual(snapshot[1], readRecordedPlanBinding(root, "YM-2"));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(readWorkflowBindingSnapshot(root, controller.signal), /abort/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
