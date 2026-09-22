import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlanBinding } from "../src/plan-binding.ts";
import { processStarttime } from "../src/coordinator-control.ts";
import { ReviewReworkStore, validateReviewReworkExtraction, adaptReviewReworkQuotes } from "../src/review-rework.ts";

const binding: PlanBinding = { ticket: "YM-1", path: "/knowledge/rework.md", contentHash: "content", scopeHash: "scope", repositories: ["org/repo"] };
const owner = {
  parent: { sessionId: "parent-session", runtimeId: "parent-runtime" },
  reviewRunId: "review-run",
  ticket: "YM-1",
  worker: { sessionId: "review-session", runtimeId: "review-runtime", pid: process.pid, starttime: processStarttime(process.pid)! },
  surface: { surface: "tab" as const, paneId: "pane-review", tabId: "tab-review" },
};

function approved(store: ReviewReworkStore, raw = "Отправляй на доработку") {
  const generation = store.beginInput(raw);
  store.approveRework(generation);
  return generation;
}

test("clean acceptance is fresh, candidate-bound and single-use", () => {
  const store = new ReviewReworkStore(owner);
  const generation = store.beginInput("Принимаю весь результат");
  store.approveAcceptance(generation);
  const candidate = "a".repeat(64);
  store.consumeAcceptance(generation, candidate);
  assert.throws(() => store.consumeAcceptance(generation, candidate), /fresh interactive verdict receipt/);
  const next = store.beginInput("Принимаю другой результат");
  assert.throws(() => store.consumeAcceptance(next, "b".repeat(64)), /fresh interactive verdict receipt/);
});

test("review rework receipt binds the exact generation, owner and recorded plan", async () => {
  const store = new ReviewReworkStore(owner);
  const generation = approved(store);
  const outcome = await store.claimHandoff(generation, binding.path, async (operationId) => {
    store.bindRecorded(operationId, binding);
    store.consume(operationId, "do-run", binding);
    store.checkCycle("do-run", binding);
    store.startCycle("do-run");
    assert.deepEqual(store.revoke(), []);
    store.checkCycle("do-run", binding);
    store.finish("do-run");
    return { state: "started" as const, recorded: true, runId: "do-run" };
  });
  assert.equal(outcome.state, "started");
  assert.throws(() => store.checkCycle("do-run", binding), /cycle/);
  assert.throws(() => store.claimHandoff(generation, "/knowledge/changed.md", async () => ({ state: "refused", recorded: false })), /binding|generation|handoff/);
});

test("concurrent and repeated handoff retains one promise and refusal outcome", async () => {
  const store = new ReviewReworkStore(owner);
  const generation = approved(store);
  let calls = 0;
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const action = async () => {
    calls++;
    await wait;
    return { state: "refused" as const, recorded: true, reason: "model unavailable" };
  };
  const first = store.claimHandoff(generation, binding.path, action);
  const second = store.claimHandoff(generation, binding.path, action);
  assert.equal(first, second);
  release();
  assert.deepEqual(await first, { state: "refused", recorded: true, reason: "model unavailable" });
  assert.deepEqual(await store.claimHandoff(generation, binding.path, action), await first);
  assert.equal(calls, 1);
});

test("fresh input after failed handoff creates a new operation and stale completion cannot finish it", async () => {
  const store = new ReviewReworkStore(owner);
  const firstGeneration = approved(store, "на доработку");
  let release!: () => void;
  let markRecorded!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const recorded = new Promise<void>((resolve) => { markRecorded = resolve; });
  const first = store.claimHandoff(firstGeneration, binding.path, async (operationId) => {
    store.bindRecorded(operationId, binding);
    markRecorded();
    await pending;
    return { state: "refused" as const, recorded: true, reason: "failed" };
  });
  await recorded;
  const secondGeneration = store.beginInput("после исправления снова на доработку");
  store.approveRework(secondGeneration);
  release();
  assert.equal((await first).state, "cancelled");
  const second = await store.claimHandoff(secondGeneration, binding.path, async (operationId) => {
    assert.deepEqual(store.plannedRetryBinding(operationId), binding);
    return { state: "started" as const, recorded: true, runId: "fresh" };
  });
  assert.equal(second.state, "started");
  assert.equal(second.runId, "fresh");
});

test("fresh input and dead worker synchronously fence a consumed pre-start cycle", async () => {
  const store = new ReviewReworkStore(owner);
  const generation = approved(store);
  await store.claimHandoff(generation, binding.path, async (operationId) => {
    store.bindRecorded(operationId, binding);
    store.consume(operationId, "do-run", binding);
    store.beginInput("стоп");
    assert.throws(() => store.checkCycle("do-run", binding), /superseded/);
    assert.throws(() => store.startCycle("do-run"), /superseded/);
    assert.deepEqual(store.cancelPreStartCycles(), ["do-run"]);
    assert.throws(() => store.checkCycle("do-run", binding), /not active/);
    return { state: "cancelled", recorded: true };
  });
  const dead = new ReviewReworkStore({ ...owner, worker: { ...owner.worker, pid: 999999999, starttime: "missing" } });
  const deadGeneration = approved(dead);
  await dead.claimHandoff(deadGeneration, binding.path, async (operationId) => {
    dead.bindRecorded(operationId, binding);
    dead.consume(operationId, "dead-run", binding);
    assert.throws(() => dead.checkCycle("dead-run", binding), /worker process ended/);
    return { state: "cancelled", recorded: true };
  });
});

test("mismatch, stale generation and revoked verdict refuse before action", async () => {
  const store = new ReviewReworkStore(owner);
  const generation = approved(store);
  const next = store.beginInput("вопрос");
  let calls = 0;
  assert.throws(() => store.approveRework(generation), /stale/);
  assert.throws(() => store.claimHandoff(generation, binding.path, async () => { calls++; return { state: "started", recorded: true } as const; }), /stale|approval/);
  store.approveRework(next);
  store.revoke();
  assert.throws(() => store.claimHandoff(next, binding.path, async () => { calls++; return { state: "started", recorded: true } as const; }), /revoked|approval|stale/);
  assert.equal(calls, 0);
});

test("candidate failure is retained and cannot reuse the old verdict", async () => {
  const store = new ReviewReworkStore(owner);
  const generation = approved(store);
  let calls = 0;
  const failed = await store.claimHandoff(generation, binding.path, async () => {
    calls++;
    throw new Error("candidate invalid");
  });
  assert.deepEqual(failed, { state: "refused", recorded: false, reason: "candidate invalid" });
  assert.deepEqual(await store.claimHandoff(generation, binding.path, async () => {
    calls++;
    return { state: "started", recorded: true };
  }), failed);
  assert.throws(() => store.claimHandoff(generation, "/knowledge/other.md", async () => ({ state: "started", recorded: true })), /binding|generation|handoff/);
  assert.equal(calls, 1);
  const fresh = approved(store, "исправлено, отправляй снова");
  const outcome = await store.claimHandoff(fresh, binding.path, async (operationId) => {
    assert.equal(store.plannedRetryBinding(operationId), undefined);
    return { state: "refused", recorded: false, reason: "still invalid" };
  });
  assert.equal(outcome.state, "refused");
});

test("review quote protocol locates unique unchanged UTF-16 spans without model arithmetic", () => {
  const raw = "План доработки согласован. На доработку.";
  const quotes = { kind: "rework", evidence: [{ text: "На доработку." }] };
  assert.deepEqual(adaptReviewReworkQuotes(quotes, raw, "YM-1"), { kind: "rework", evidence: [{ start: 27, end: 40, text: "На доработку." }] });
  const observed = JSON.parse('{"kind":"rework","evidence":[{"start":26,"end":39,"text":"На доработку."}]}');
  assert.throws(() => validateReviewReworkExtraction(observed, raw, "YM-1"), /literal evidence span mismatch/);
  assert.throws(() => adaptReviewReworkQuotes(observed, raw, "YM-1"), /quote/);
  assert.deepEqual(adaptReviewReworkQuotes({ kind: "revoke", evidence: [{ text: "стоп 🚀" }] }, "🚀 е\u0301: стоп 🚀", "YM-1"), { kind: "revoke", evidence: [{ start: 7, end: 14, text: "стоп 🚀" }] });
  assert.deepEqual(adaptReviewReworkQuotes({ kind: "none" }, raw, "YM-1"), { kind: "none" });
  for (const value of [null, [], {}, { kind: "other" }, { kind: "none", evidence: [] }, { ...quotes, extra: true }, { kind: "rework" }, { kind: "rework", evidence: [] }, { kind: "rework", evidence: Array(9).fill({ text: "На доработку." }) }, { kind: "rework", evidence: ["На доработку."] }, { kind: "rework", evidence: [{ text: "" }] }, { kind: "rework", evidence: [{}] }, { kind: "rework", evidence: [{ text: "На доработку.", extra: true }] }, { kind: "rework", evidence: [{ text: "На доработку!" }] }]) {
    assert.throws(() => adaptReviewReworkQuotes(value, raw, "YM-1"), /quote/);
  }
  assert.throws(() => adaptReviewReworkQuotes(quotes, `${raw} На доработку.`, "YM-1"), /ambiguous/);
  assert.throws(() => adaptReviewReworkQuotes({ kind: "rework", evidence: [{ text: "аа" }] }, "ааа", "YM-1"), /ambiguous/);
  assert.throws(() => adaptReviewReworkQuotes(quotes, `${raw} YM-2`, "YM-1"), /foreign/);
  assert.throws(() => adaptReviewReworkQuotes({ kind: "rework", evidence: [{ text: "ё" }] }, "е\u0308", "YM-1"), /missing/);
});

test("review extraction accepts literal UTF-16 evidence and rejects foreign tickets or loose schema", () => {
  const raw = "Итог: отправляй на доработку 🚀";
  const text = "отправляй на доработку 🚀";
  const start = raw.indexOf(text);
  const value = { kind: "rework", evidence: [{ start, end: start + text.length, text }] };
  assert.deepEqual(validateReviewReworkExtraction(value, raw, "YM-1"), value);
  assert.deepEqual(validateReviewReworkExtraction({ kind: "none" }, "это вопрос?", "YM-1"), { kind: "none" });
  assert.throws(() => validateReviewReworkExtraction({ ...value, extra: true }, raw, "YM-1"), /extraction/);
  assert.throws(() => validateReviewReworkExtraction(value, `${raw} YM-2`, "YM-1"), /foreign/);
  assert.throws(() => validateReviewReworkExtraction({ kind: "revoke", evidence: [{ start: 0, end: 4, text: "другое" }] }, "стоп", "YM-1"), /literal/);
});
