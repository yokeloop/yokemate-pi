import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlanBinding } from "../src/plan-binding.ts";
import { ReviewReworkStore, validateReviewReworkExtraction } from "../src/review-rework.ts";

const binding: PlanBinding = { ticket: "YM-1", path: "/knowledge/rework.md", contentHash: "content", scopeHash: "scope", repositories: ["org/repo"] };
const owner = {
  parent: { sessionId: "parent-session", runtimeId: "parent-runtime" },
  reviewRunId: "review-run",
  ticket: "YM-1",
  worker: { sessionId: "review-session", runtimeId: "review-runtime", pid: 101, starttime: "11" },
  surface: { surface: "tab" as const, paneId: "pane-review", tabId: "tab-review" },
};

function approved(store: ReviewReworkStore, raw = "Отправляй на доработку") {
  const generation = store.beginInput(raw);
  store.approveRework(generation);
  return generation;
}

test("review rework receipt binds the exact generation, owner and recorded plan", async () => {
  const store = new ReviewReworkStore(owner);
  const generation = approved(store);
  const outcome = await store.claimHandoff(generation, binding, async (operationId) => {
    store.bindRecorded(operationId, binding);
    store.consume(operationId, "do-run", binding);
    store.checkCycle("do-run", binding);
    store.finish("do-run");
    return { state: "started" as const, recorded: true, runId: "do-run" };
  });
  assert.equal(outcome.state, "started");
  assert.throws(() => store.checkCycle("do-run", binding), /cycle/);
  assert.throws(() => store.claimHandoff(generation, { ...binding, contentHash: "changed" }, async () => ({ state: "refused", recorded: false })), /binding|generation|handoff/);
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
  const first = store.claimHandoff(generation, binding, action);
  const second = store.claimHandoff(generation, { ...binding, repositories: [...binding.repositories] }, action);
  assert.equal(first, second);
  release();
  assert.deepEqual(await first, { state: "refused", recorded: true, reason: "model unavailable" });
  assert.deepEqual(await store.claimHandoff(generation, binding, action), await first);
  assert.equal(calls, 1);
});

test("fresh input after failed handoff creates a new operation and stale completion cannot finish it", async () => {
  const store = new ReviewReworkStore(owner);
  const firstGeneration = approved(store, "на доработку");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const first = store.claimHandoff(firstGeneration, binding, async () => {
    await pending;
    return { state: "refused" as const, recorded: true, reason: "failed" };
  });
  const secondGeneration = store.beginInput("после исправления снова на доработку");
  store.approveRework(secondGeneration);
  release();
  assert.equal((await first).state, "cancelled");
  const second = await store.claimHandoff(secondGeneration, binding, async () => ({ state: "started" as const, recorded: true, runId: "fresh" }));
  assert.equal(second.state, "started");
  assert.equal(second.runId, "fresh");
});

test("mismatch, stale generation and revoked verdict refuse before action", async () => {
  const store = new ReviewReworkStore(owner);
  const generation = approved(store);
  const next = store.beginInput("вопрос");
  let calls = 0;
  assert.throws(() => store.approveRework(generation), /stale/);
  assert.throws(() => store.claimHandoff(generation, binding, async () => { calls++; return { state: "started", recorded: true } as const; }), /stale|approval/);
  store.approveRework(next);
  store.revoke();
  assert.throws(() => store.claimHandoff(next, binding, async () => { calls++; return { state: "started", recorded: true } as const; }), /revoked|approval|stale/);
  assert.equal(calls, 0);
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
