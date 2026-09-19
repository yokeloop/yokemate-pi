import { test } from "node:test";
import assert from "node:assert/strict";
import { CoordinatorRegistry, IDLE_NUDGE_LIMIT, ShipPermitStore, idleVerdict } from "../src/coordinator-runtime.ts";
import { ListRunRegistry, type KeyRunContext } from "../src/list-run.ts";
import { resolveRuntimeSettings } from "../src/guard-policy.ts";

test("coordinator registry reserves ticket batches atomically and releases terminal runs", () => {
  const registry = new CoordinatorRegistry();
  const first = registry.reserve({ mode: "ship", tickets: ["ACME-1", "ACME-2"] }, {}, "main", "model", "/root", ["acme/a"], true);
  assert.throws(() => registry.reserve({ mode: "ship", tickets: ["ACME-2"] }, {}, "main", "model", "/root", ["acme/a"], true), /already runs/);
  registry.finalize(first.identity.runId, "blocked", "stopped");
  assert.doesNotThrow(() => registry.reserve({ mode: "ship", tickets: ["ACME-2"] }, {}, "main", "model", "/root", ["acme/a"], true));
});

test("a failed preparing reservation finalizes once and can be reserved again", () => {
  const registry = new CoordinatorRegistry();
  const request = { mode: "do" as const, tickets: ["YM-1"] };
  const run = registry.reserve(request, {}, "main", "pending", "/root", [], true);
  assert.equal(run.state, "preparing");
  assert.equal(registry.active().length, 1);
  const blocked = registry.finalize(run.identity.runId, "blocked", "plan not found");
  assert.deepEqual(registry.active(), []);
  assert.equal(registry.finalize(run.identity.runId, "blocked", "second failure"), blocked);
  assert.equal(blocked.reason, "plan not found");
  const retry = registry.reserve(request, {}, "main", "pending", "/root", [], true);
  assert.notEqual(retry.identity.runId, run.identity.runId);
  assert.deepEqual(registry.active(), [retry]);
});

test("ship permit is exact, single-use and invalidated by later input", () => {
  const permits = new ShipPermitStore();
  permits.observeInteractiveShip(["ACME-1", "ACME-2"], "main");
  assert.equal(permits.consume(["ACME-2", "ACME-1"], "main"), false);
  assert.equal(permits.consume(["ACME-1", "ACME-2"], "other"), false);
  assert.equal(permits.consume(["ACME-1", "ACME-2"], "main"), true);
  assert.equal(permits.consume(["ACME-1", "ACME-2"], "main"), false);
  permits.observeInteractiveShip(["ACME-3"], "main");
  permits.invalidate();
  assert.equal(permits.consume(["ACME-3"], "main"), false);
});

test("idle verdict waits on live children, nudges a bounded number of times, then blocks", () => {
  assert.equal(idleVerdict({ nudges: 0, hasChildren: true }), "wait");
  assert.equal(idleVerdict({ nudges: 99, hasChildren: true }), "wait");
  assert.equal(idleVerdict({ nudges: 0, hasChildren: false }), "nudge");
  assert.equal(idleVerdict({ nudges: IDLE_NUDGE_LIMIT - 1, hasChildren: false }), "nudge");
  assert.equal(idleVerdict({ nudges: IDLE_NUDGE_LIMIT, hasChildren: false }), "blocked");
});

test("coordinator checks use the same policy and limits as ordinary admission", async () => {
  const { coordinatorChecks } = await import("../src/coordinator-runtime.ts");
  const { resolveRuntimeSettings } = await import("../src/guard-policy.ts");
  const on = coordinatorChecks(resolveRuntimeSettings({ subagent: { maxParallelTasks: 1, maxConcurrency: 1, maxDetached: 1 } }));
  const off = coordinatorChecks(resolveRuntimeSettings({ guardPolicy: { yolo: true } }));
  for (const mode of ["do", "ship"] as const) {
    assert.equal(on.rejectDuplicate(mode), true);
    assert.equal(off.rejectDuplicate(mode), false);
  }
  assert.match(on.checkCaller({ YOKEMATE_MODE: "plan" }, { mode: "do", tickets: ["YM-1"] }) ?? "", /main chat/);
  assert.equal(off.checkCaller({ YOKEMATE_MODE: "review" }, { mode: "do", tickets: ["YM-1"] }), undefined);
  assert.match(on.checkAdmission(1) ?? "", /Too many detached/);
  assert.equal(off.checkAdmission(100), undefined);
  assert.equal(on.needsShipConfirmation({}), true);
  assert.equal(off.needsShipConfirmation({}), false);
});

test("list reservations precede starts and whole lifetimes share bounded capacity", async () => {
  const registry = new ListRunRegistry();
  const settings = resolveRuntimeSettings({ subagent: { maxParallelTasks: 3, maxConcurrency: 2, maxDetached: 3 } });
  const run = registry.admit({ mode: "do", keys: ["A-1", "B-1", "C-1"], parentSessionId: "session", parentRuntimeId: "runtime", settings, rejectDuplicate: true });
  assert.deepEqual(run.entries.map((entry) => entry.immediate?.reservation), ["ready", "ready", "queued"]);
  const events: string[] = [];
  const releases = new Map<string, (value: import("../src/list-run.ts").ListTerminal) => void>();
  registry.start(run.identity.listRunId, async (context) => {
    events.push(`start:${context.key}`);
    context.active();
    return new Promise((resolve) => releases.set(context.key, resolve));
  });
  assert.deepEqual(events, []);
  registry.publishImmediate(run.identity.listRunId);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["start:A-1", "start:B-1"]);
  releases.get("B-1")!({ outcome: "done", facts: { pr: "b" } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["start:A-1", "start:B-1", "start:C-1"]);
  releases.get("C-1")!({ outcome: "done", facts: { pr: "c" } });
  releases.get("A-1")!({ outcome: "done", facts: { pr: "a" } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(registry.aggregate(run.identity.listRunId)?.results.map((entry) => entry.key), ["A-1", "B-1", "C-1"]);
});

test("blocked plan recovery records a separate generation without rewriting the terminal aggregate", () => {
  const registry = new ListRunRegistry();
  const run = registry.admit({ mode: "plan", keys: ["YM-1"], parentSessionId: "session", parentRuntimeId: "runtime", settings: resolveRuntimeSettings({}) });
  registry.publishImmediate(run.identity.listRunId);
  const key = run.entries[0]!.keyRunId;
  assert.equal(registry.settle(run.identity.listRunId, key, { outcome: "blocked", reason: "transport" }), true);
  const before = registry.aggregate(run.identity.listRunId)!;
  const recovery = registry.admitRecovery(key, 2);
  assert.equal(recovery.recoveryRunId, `${key}:2`);
  assert.equal(registry.settleRecovery(key, { outcome: "recorded", facts: { planOnly: true } }), true);
  assert.equal(registry.recovery(key)?.state, "recorded");
  assert.deepEqual(registry.aggregate(run.identity.listRunId), before);
});

test("durable plan recording releases its lifetime slot before auto-do admission", async () => {
  const registry = new ListRunRegistry();
  const settings = resolveRuntimeSettings({ subagent: { maxParallelTasks: 1, maxConcurrency: 1, maxDetached: 1 } });
  const plan = registry.admit({ mode: "plan", keys: ["A-1"], parentSessionId: "session", parentRuntimeId: "runtime", settings });
  registry.publishImmediate(plan.identity.listRunId);
  registry.start(plan.identity.listRunId, async (context) => { context.active(); return new Promise(() => {}); });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(registry.releaseLifetime(plan.entries[0]!.keyRunId), true);
  assert.equal(registry.wasLifetimeReleased(plan.entries[0]!.keyRunId), true);
  const handoff = registry.admit({ mode: "do", keys: ["A-1"], parentSessionId: "session", parentRuntimeId: "runtime", settings, externalActiveUnits: 0 });
  assert.equal(handoff.entries[0]!.immediate?.state, "accepted");
  assert.equal(registry.settle(plan.identity.listRunId, plan.entries[0]!.keyRunId, { outcome: "done", facts: { handoff: "accepted" } }), true);
});

test("fully refused list aggregate can be flushed only after its immediate ACK", () => {
  const registry = new ListRunRegistry();
  const run = registry.admit({ mode: "ship", keys: ["A-1", "B-1"], parentSessionId: "session", parentRuntimeId: "runtime", settings: resolveRuntimeSettings({ subagent: { maxParallelTasks: 1 } }) });
  const order: string[] = [];
  registry.onImmediate((_list, entry) => order.push(`ack:${entry.key}`));
  registry.onAggregate(() => order.push("aggregate"));
  registry.publishImmediate(run.identity.listRunId, true);
  assert.deepEqual(order, ["ack:A-1", "ack:B-1"]);
  registry.flushAggregate(run.identity.listRunId);
  assert.deepEqual(order, ["ack:A-1", "ack:B-1", "aggregate"]);
});

test("parallel task limit refuses the whole fan-out while concurrency only queues", () => {
  const limited = new ListRunRegistry().admit({ mode: "plan", keys: ["A-1", "B-1", "C-1"], parentSessionId: "session", parentRuntimeId: "runtime", settings: resolveRuntimeSettings({ subagent: { maxParallelTasks: 2, maxConcurrency: 1, maxDetached: 4 } }) });
  assert.ok(limited.entries.every((entry) => entry.immediate?.state === "refused"));
  assert.ok(limited.entries.every((entry) => entry.immediate?.reason === "Too many parallel tasks (3). Max is 2."));
  const concurrencyOnly = new ListRunRegistry().admit({ mode: "plan", keys: ["A-1", "B-1", "C-1"], parentSessionId: "session", parentRuntimeId: "runtime", settings: resolveRuntimeSettings({ guardPolicy: { guards: { parallelTaskLimit: false } }, subagent: { maxParallelTasks: 2, maxConcurrency: 1, maxDetached: 4 } }) });
  assert.deepEqual(concurrencyOnly.entries.map((entry) => entry.immediate?.state), ["accepted", "accepted", "accepted"]);
  assert.deepEqual(concurrencyOnly.entries.map((entry) => entry.immediate?.reservation), ["ready", "queued", "queued"]);
});

test("list ACK precedes fast terminal and cancel fences late outcomes to one key", async () => {
  const registry = new ListRunRegistry();
  const settings = resolveRuntimeSettings({ subagent: { maxParallelTasks: 3, maxConcurrency: 2, maxDetached: 3 } });
  const run = registry.admit({ mode: "ship", keys: ["A-1", "B-1"], parentSessionId: "session", parentRuntimeId: "runtime", settings });
  const order: string[] = [];
  registry.onImmediate((_list, entry) => order.push(`ack:${entry.key}`));
  registry.onTerminal((_list, entry) => order.push(`terminal:${entry.key}`));
  registry.settle(run.identity.listRunId, run.entries[0]!.keyRunId, { outcome: "blocked", reason: "fast" });
  registry.publishImmediate(run.identity.listRunId);
  assert.deepEqual(order, ["ack:A-1", "ack:B-1", "terminal:A-1"]);
  assert.equal(registry.cancel(run.entries[1]!.keyRunId), true);
  assert.equal(registry.settle(run.identity.listRunId, run.entries[1]!.keyRunId, { outcome: "done" }), false);
  assert.equal(run.entries[0]!.terminal?.reason, "fast");
  assert.equal(run.entries[1]!.terminal?.outcome, "cancelled");
});

test("duplicate input has no accepted side effects and admissible siblings survive active duplicate and overflow", () => {
  const registry = new ListRunRegistry();
  const settings = resolveRuntimeSettings({ subagent: { maxParallelTasks: 3, maxConcurrency: 2, maxDetached: 3 } });
  const invalid = registry.admit({ mode: "plan", keys: ["A-1", "A-1"], parentSessionId: "session", parentRuntimeId: "runtime", settings, rejectDuplicate: true });
  assert.ok(invalid.entries.every((entry) => entry.immediate?.state === "refused"));
  const first = registry.admit({ mode: "do", keys: ["A-1"], parentSessionId: "session", parentRuntimeId: "runtime", settings, rejectDuplicate: true });
  const next = registry.admit({ mode: "do", keys: ["A-1", "B-1", "C-1"], parentSessionId: "session", parentRuntimeId: "runtime", settings, externalActiveUnits: 1, rejectDuplicate: true });
  assert.equal(first.entries[0]!.immediate?.state, "accepted");
  assert.deepEqual(next.entries.map((entry) => entry.immediate?.state), ["refused", "accepted", "refused"]);
});

test("list children retain parent list and key identity", async () => {
  const registry = new ListRunRegistry();
  const settings = resolveRuntimeSettings({ subagent: { maxParallelTasks: 2, maxConcurrency: 2, maxDetached: 2 } });
  const run = registry.admit({ mode: "do", keys: ["A-1", "B-1"], parentSessionId: "session", parentRuntimeId: "runtime", settings });
  const contexts: KeyRunContext[] = [];
  registry.start(run.identity.listRunId, async (context) => { contexts.push(context); return { outcome: "done" }; });
  registry.publishImmediate(run.identity.listRunId);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(contexts.map(({ listRunId, parentRunId, keyRunId }) => ({ listRunId, parentRunId, keyRunId })), run.entries.map((entry) => ({ listRunId: run.identity.listRunId, parentRunId: run.identity.listRunId, keyRunId: entry.keyRunId })));
});

test("duplicate off keeps independent atomic reservations and release does not hide siblings", () => {
  for (const mode of ["do", "ship"] as const) {
    const registry = new CoordinatorRegistry();
    const request = { mode, tickets: ["YM-1"] };
    const first = registry.reserve(request, {}, "main", "model", "/root", [], false);
    const second = registry.reserve(request, {}, "main", "model", "/root", [], false);
    assert.notEqual(first.identity.runId, second.identity.runId);
    registry.finalize(first.identity.runId, "blocked", "stopped");
    assert.throws(() => registry.reserve(request, {}, "main", "model", "/root", [], true), /already runs/);
    assert.deepEqual(registry.active(), [second]);
    registry.finalize(second.identity.runId, "blocked", "stopped");
    assert.doesNotThrow(() => registry.reserve(request, {}, "main", "model", "/root", [], true));
  }
});
