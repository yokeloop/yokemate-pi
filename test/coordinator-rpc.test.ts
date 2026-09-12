import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coordinatorInvocationArgs, startCoordinatorRpc } from "../src/coordinator-rpc.ts";
import { resolveCoordinatorModel } from "../src/coordinator-model.ts";

const fixture = fileURLToPath(new URL("./fixtures/coordinator-rpc-child.ts", import.meta.url));
const taskRoot = mkdtempSync(join(tmpdir(), "coordinator-rpc-"));

const prepared = {
  mode: "do",
  tickets: ["YM-1"],
  model: "test/model",
  cwd: taskRoot,
  plans: {},
  parts: [],
  prompt: "work",
  skillsPath: process.cwd(),
  resourcesPath: process.cwd(),
} as any;
const identity = { runId: "run-1", parentSessionId: "parent", mode: "do" as const, ticket: "YM-1", project: [], role: "coordinator" as const, cwd: process.cwd(), model: "test/model" };
const expected = { provider: "test", id: "model", thinkingLevel: "high" as const };

test("coordinator model normalization delegates colon IDs and thinking to Pi", () => {
  const models = [
    { provider: "test", id: "model", name: "model" },
    { provider: "test", id: "model:high", name: "model:high" },
    { provider: "other", id: "shared", name: "shared" },
    { provider: "test", id: "shared", name: "shared" },
    { provider: "test", id: "dated-20250101", name: "alias" },
    { provider: "test", id: "alias", name: "alias" },
  ];
  const registry = {
    getAll: () => models,
    hasConfiguredAuth: (model: { provider: string }) => model.provider === "test",
  };
  const cases = [
    ["test/model", { provider: "test", id: "model" }],
    ["test/model:high", { provider: "test", id: "model:high" }],
    ["test/model:high:low", { provider: "test", id: "model:high", thinkingLevel: "low" }],
    ["model:high", { provider: "test", id: "model:high" }],
    ["alias", { provider: "test", id: "alias" }],
  ] as const;
  for (const [specification, expectedModel] of cases)
    assert.deepEqual(resolveCoordinatorModel(specification, registry as never).expected, expectedModel);
  assert.throws(() => resolveCoordinatorModel("shared", { ...registry, hasConfiguredAuth: () => false } as never), /resolution failed.*ambiguous/);
  assert.throws(() => resolveCoordinatorModel("", registry as never), /resolution failed/);
});

test("coordinator RPC blocks invalid state, model mismatch, and thinking mismatch before work", async () => {
  const cases = [
    ["state-false", /coordinator invalid state: get_state failed/],
    ["invalid-state", /coordinator invalid state: data.thinkingLevel must be a valid thinking level/],
    ["provider-mismatch", /coordinator model mismatch: expected test\/model, got wrong\/model/],
    ["thinking-mismatch", /coordinator thinking mismatch: expected high, got medium, model test\/model/],
  ] as const;
  for (const [scenario, diagnostic] of cases) {
    let workPrompts = 0;
    const rpc = startCoordinatorRpc(prepared, identity, expected, {
      onEvent(event) { if (event.type === "work_prompt") workPrompts += 1; },
    }, {
      invocation: { command: process.execPath, args: ["--experimental-strip-types", fixture, scenario] },
      readyTimeoutMs: 500,
      stopGraceMs: 20,
    });
    try {
      await assert.rejects(rpc.ready, diagnostic);
      assert.equal(workPrompts, 0);
    } finally {
      await rpc.stop();
    }
  }
});

test("coordinator RPC stays owned and alive after an accepted prompt until teardown", async () => {
  let delayed!: () => void;
  let grandchildPid: number | undefined;
  const nested = new Promise<void>((resolve) => { delayed = resolve; });
  const rpc = startCoordinatorRpc(prepared, identity, expected, { onEvent: (event) => {
    if ((event.message as { details?: { kind?: string } } | undefined)?.details?.kind === "nested-report") delayed();
    if (event.type === "grandchild" && typeof event.pid === "number") grandchildPid = event.pid;
  } }, {
    invocation: { command: process.execPath, args: ["--experimental-strip-types", fixture] },
    readyTimeoutMs: 500,
    stopGraceMs: 100,
  });
  try {
    await rpc.ready;
    const accepted = await rpc.request({ id: "run-1:work", type: "prompt", message: "work" });
    assert.equal(accepted.success, true);
    await Promise.race([nested, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("fixture did not deliver its delayed nested report")), 1000))]);
    assert.equal(rpc.process.exitCode, null);
    assert.ok(grandchildPid);
    assert.equal(rpc.hasLiveDescendants(), true);
  } finally {
    await rpc.stop();
  }
  assert.notEqual(rpc.process.exitCode, null);
  assert.throws(() => process.kill(grandchildPid!, 0));
  assert.equal(rpc.hasLiveDescendants(), false);
  assert.ok(existsSync(join(taskRoot, "logs", "coordinator-run-1.log")));
});

test("coordinator invocation keeps a session under the task folder", () => {
  const args = coordinatorInvocationArgs({ mode: "do", model: "test/model", cwd: "/tasks/YM-1", skillsPath: "/skills", resourcesPath: "/resources" });
  assert.ok(!args.includes("--no-session"));
  assert.equal(args[args.indexOf("--session-dir") + 1], "/tasks/YM-1/sessions");
  assert.equal(args[args.indexOf("--append-system-prompt") + 1], "/resources/.pi/agents/do-coordinator.md");
});

test("owned state requires matching transport identity, launch admission and delivery observations", async () => {
  const { ChildRuns, OwnedChildState, deliveryFor, resultEnvelope } = await import("../src/subagent-runs.ts");
  const task = { agent: "worker", task: "A", cwd: process.cwd() };
  const runs = new ChildRuns("owner", "session");
  const ack = runs.admit("A", [task], process.cwd());
  const result = resultEnvelope(ack.children[0]!.identity, "A", { processOutcome: "exited", exitCode: 0, signal: null, stopReason: "stop" }, "done");
  const tracker = new OwnedChildState("owner", 100, "start");
  const initial = { version: 1 as const, ownerRunId: "owner", ownerSessionId: "session", pid: 100, starttime: "start", sequence: 1, children: [], deliveries: [] };
  assert.equal(tracker.settled(), "wait");
  tracker.accept(initial);
  assert.equal(tracker.settled(), "wait");
  tracker.bindSession("session");
  assert.equal(tracker.settled(), "nudge");
  assert.equal(tracker.settled(), "blocked");
  tracker.toolStart("A", task);
  assert.equal(tracker.settled(), "wait");
  assert.equal(tracker.accept({ ...initial, sequence: 2, children: ack.children }), true);
  tracker.toolEnd("A", ack, false);
  assert.equal(tracker.canFinish("blocked", "child still active"), false);
  const delivery = deliveryFor(result);
  assert.equal(tracker.accept({ ...initial, sequence: 3, deliveries: [delivery] }), true);
  assert.equal(tracker.settled(), "wait");
  tracker.recordDeliveryError();
  assert.equal(tracker.canFinish("done"), false);
  assert.equal(tracker.canFinish("blocked", `delivery failed: ${delivery.deliveryId}`), true);
  assert.equal(tracker.accept({ ...initial, sequence: 4, deliveries: [{ ...delivery, state: "observed" }] }), true);
  assert.equal(tracker.settled(), "nudge");
  assert.equal(tracker.accept({ ...initial, sequence: 3, children: ack.children }), false);
  assert.equal(tracker.settled(), "blocked");
  assert.equal(tracker.accept({ ...initial, sequence: 4, deliveries: [{ ...delivery, state: "observed" }] }), false);
  assert.equal(tracker.settled(), "blocked");
  for (const bad of [{ ownerRunId: "foreign" }, { ownerSessionId: "foreign" }, { pid: 101 }, { starttime: "wrong" }]) {
    const invalid = new OwnedChildState("owner", 100, "start");
    invalid.bindSession("session");
    assert.equal(invalid.accept({ ...initial, ...bad }), false);
    assert.equal(invalid.canFinish("done"), false);
    assert.equal(invalid.settled(), "wait");
  }
});

test("an observed delivery retires its asynchronous error before a later healthy batch", async () => {
  const { ChildRuns, OwnedChildState, deliveryFor, resultEnvelope } = await import("../src/subagent-runs.ts");
  const tracker = new OwnedChildState("owner", 100, "start");
  tracker.bindSession("session");
  const initial = { version: 1 as const, ownerRunId: "owner", ownerSessionId: "session", pid: 100, starttime: "start", sequence: 1, children: [], deliveries: [] };
  tracker.accept(initial);
  const runs = new ChildRuns("owner", "session");
  const tasks = ["A", "B"].map((task) => ({ agent: "worker", task, cwd: process.cwd() }));
  const a = runs.admit("A", [tasks[0]!], process.cwd());
  const b = runs.admit("B", [tasks[1]!], process.cwd());
  tracker.toolStart("A", tasks[0]);
  tracker.toolEnd("A", a, false);
  tracker.toolStart("B", tasks[1]);
  tracker.toolEnd("B", b, false);
  const terminal = { processOutcome: "exited" as const, exitCode: 0, signal: null, stopReason: "stop" };
  const deliveryA = deliveryFor(resultEnvelope(a.children[0]!.identity, "A", terminal, "A"));
  const deliveryB = deliveryFor(resultEnvelope(b.children[0]!.identity, "B", terminal, "B"));
  tracker.accept({ ...initial, sequence: 2, children: b.children, deliveries: [deliveryA] });
  tracker.recordDeliveryError();
  tracker.accept({ ...initial, sequence: 3, children: b.children, deliveries: [{ ...deliveryA, state: "observed" }] });
  tracker.accept({ ...initial, sequence: 4, deliveries: [{ ...deliveryA, state: "observed" }, deliveryB] });
  assert.equal(tracker.deliveryFailureReason(), undefined);
  assert.equal(tracker.settled(), "wait");
});
