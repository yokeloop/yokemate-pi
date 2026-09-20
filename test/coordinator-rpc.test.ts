import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { errorMonitor } from "node:events";
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
  const uiRequests: unknown[] = [];
  const nested = new Promise<void>((resolve) => { delayed = resolve; });
  const rpc = startCoordinatorRpc(prepared, identity, expected, { onEvent: (event) => {
    if ((event.message as { details?: { kind?: string } } | undefined)?.details?.kind === "nested-report") delayed();
    if (event.type === "grandchild" && typeof event.pid === "number") grandchildPid = event.pid;
  }, onUiRequest: (event) => { uiRequests.push(event); } }, {
    invocation: { command: process.execPath, args: ["--experimental-strip-types", fixture] },
    readyTimeoutMs: 500,
    stopGraceMs: 100,
  });
  try {
    await rpc.ready;
    const accepted = await rpc.request({ id: "run-1:work", type: "prompt", message: "work" });
    assert.equal(accepted.success, true);
    assert.ok(rpc.process instanceof ChildProcess);
    const runningAgents = new Map<ChildProcess, string>([[rpc.process, "do YM-1"]]);
    assert.equal(runningAgents.get(rpc.process), "do YM-1");
    await Promise.race([nested, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("fixture did not deliver its delayed nested report")), 1000))]);
    assert.deepEqual(uiRequests, [{ type: "extension_ui_request", id: "w1", method: "setWidget", widgetKey: "subagent-running", widgetLines: ["task-reviewer 0:05 review"] }]);
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

test("request response hook runs before later events from the same JSONL chunk", async () => {
  const order: string[] = [];
  const rpc = startCoordinatorRpc(prepared, identity, expected, {
    onEvent(event) { if (event.type === "terminal_probe") order.push("terminal"); },
  }, {
    invocation: { command: process.execPath, args: ["--experimental-strip-types", fixture, "same-chunk-work-terminal"] },
    readyTimeoutMs: 1000,
    stopGraceMs: 100,
  });
  try {
    await rpc.ready;
    const response = await rpc.request({ id: "run-1:work", type: "prompt", message: "work" }, () => order.push("ack"));
    assert.equal(response.success, true);
    assert.deepEqual(order, ["ack", "terminal"]);
  } finally { await rpc.stop(); }
});

test("RPC stop absorbs expected EPIPE and resolves", async () => {
  let stdinClosed!: () => void;
  const closed = new Promise<void>((resolve) => { stdinClosed = resolve; });
  const blocked: string[] = [];
  const pipeErrors: string[] = [];
  const rpc = startCoordinatorRpc(prepared, identity, expected, {
    onEvent(event) { if (event.type === "stdin_closed") stdinClosed(); },
    onBlocked(reason) { blocked.push(reason); },
  }, {
    invocation: { command: process.execPath, args: ["--experimental-strip-types", fixture, "closed-stdin"] },
    readyTimeoutMs: 1000,
    stopGraceMs: 100,
  });
  rpc.process.stdin!.on(errorMonitor, (error: NodeJS.ErrnoException) => { pipeErrors.push(error.code!); });
  try {
    await rpc.ready;
    rpc.send({ type: "close_stdin" });
    await closed;
    const stopping = rpc.stop();
    assert.equal(rpc.stop(), stopping);
    await stopping;
    assert.deepEqual(pipeErrors, ["EPIPE"]);
    assert.deepEqual(blocked, []);
    assert.throws(() => process.kill(rpc.process.pid!, 0));
    assert.equal(rpc.hasLiveDescendants(), false);
  } finally {
    await rpc.stop();
  }
});

test("RPC stdin errors remain blocking outside expected stop EPIPE", async () => {
  for (const duringStop of [false, true]) {
    const blocked: string[] = [];
    const rpc = startCoordinatorRpc(prepared, identity, expected, {
      onBlocked(reason) { blocked.push(reason); },
    }, {
      invocation: { command: process.execPath, args: ["--experimental-strip-types", fixture] },
      readyTimeoutMs: 1000, stopGraceMs: 100,
    });
    try {
      await rpc.ready;
      const stopping = duringStop ? rpc.stop() : undefined;
      const error = Object.assign(new Error(duringStop ? "unexpected stdin failure" : "write EPIPE"), { code: duringStop ? "EIO" : "EPIPE" });
      rpc.process.stdin!.emit("error", error);
      assert.deepEqual(blocked, [`coordinator RPC stdin: ${error.message}`]);
      await stopping;
    } finally {
      await rpc.stop();
    }
  }
});

test("RPC ignores delayed UI replies after stop begins", async (t) => {
  let reply: ((response: Record<string, unknown>) => void) | undefined;
  const rpc = startCoordinatorRpc(prepared, identity, expected, {
    onUiRequest(_event, respond) { reply = respond; },
  }, {
    invocation: { command: process.execPath, args: ["--experimental-strip-types", fixture] },
    readyTimeoutMs: 1000, stopGraceMs: 100,
  });
  try {
    await rpc.ready;
    await rpc.request({ type: "prompt", message: "work" });
    assert.ok(reply);
    const writes = t.mock.method(rpc.process.stdin!, "write");
    const stopping = rpc.stop();
    const count = writes.mock.callCount();
    reply({ type: "extension_ui_response", id: "w1", cancelled: true });
    assert.equal(writes.mock.callCount(), count);
    await stopping;
  } finally {
    await rpc.stop();
  }
});

test("D01 coordinator honors explicitly isolated session storage", () => {
  const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
  try {
    process.env.PI_CODING_AGENT_SESSION_DIR = "/isolated sessions";
    const args = coordinatorInvocationArgs(prepared);
    assert.equal(args.includes("--session-dir"), false);
    assert.equal(args.includes("--no-session"), false);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR; else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
  }
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
  assert.equal(tracker.accept({ ...initial, sequence: 3, deliveries: [{ ...delivery, state: "delivery_failed" }] }), true);
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
  tracker.accept({ ...initial, sequence: 2, children: b.children, deliveries: [{ ...deliveryA, state: "delivery_failed" }] });
  tracker.recordDeliveryError();
  tracker.accept({ ...initial, sequence: 3, children: b.children, deliveries: [{ ...deliveryA, state: "observed" }] });
  tracker.accept({ ...initial, sequence: 4, deliveries: [{ ...deliveryA, state: "observed" }, deliveryB] });
  assert.equal(tracker.deliveryFailureReason(), undefined);
  assert.equal(tracker.settled(), "wait");
});

test("blocked teardown after unexpected exit preserves the completed parent snapshot", async () => {
  const fs = await import("node:fs");
  const { RunSnapshots } = await import("../src/subagent-runs.ts");
  const root = mkdtempSync(join(tmpdir(), "ym204-closed-parent-"));
  const folder = join(root, "home/knowledge/org/repo/ai/task");
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(join(root, ".pi/agents"), { recursive: true });
  fs.writeFileSync(join(root, ".pi/agents/do-coordinator.md"), "fixture");
  const plan = join(folder, "plan.md");
  fs.writeFileSync(plan, "plan");
  let rpc: ReturnType<typeof startCoordinatorRpc> | undefined;
  const diagnostics: { snapshot: Record<string, unknown>; completed: boolean }[] = [];
  let stopped!: () => void;
  const complete = new Promise<void>((resolve) => { stopped = resolve; });
  try {
    rpc = startCoordinatorRpc({ ...prepared, cwd: root, resourcesPath: root, plan }, identity, expected, {
      onBlocked() { void rpc?.stop().then(stopped); },
      onDiagnostic(snapshot, completed) { diagnostics.push({ snapshot, completed }); },
    }, { invocation: { command: process.execPath, args: ["--experimental-strip-types", fixture, "exit-no-descendants"] }, stopGraceMs: 20 });
    await rpc.ready;
    await rpc.request({ type: "prompt", message: "work" });
    await complete;
    await rpc.stop();
    const file = join(root, "sessions/subagent-runs/run-1-run-1.json");
    const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(snapshot.lifecycle.processClosed, true);
    assert.equal(snapshot.process.exitCode, 9);
    assert.equal(snapshot.process.cancellationInitiator, "unknown");
    assert.ok(diagnostics.some((entry) => entry.completed));
    const terminalDiagnostic = rpc.diagnosticSnapshot();
    assert.equal(terminalDiagnostic.exitCode, 9);
    assert.equal((terminalDiagnostic.stderr as any).bytes, Buffer.byteLength("private coordinator sentinel"));
    assert.doesNotMatch(JSON.stringify(terminalDiagnostic), /private coordinator sentinel/);
    const snapshots = new RunSnapshots(root);
    for (let i = 0; i < 21; i++) snapshots.write("rotate", `run-${i}`, { closeAt: new Date().toISOString(), terminal: { processOutcome: "exited", exitCode: 0, signal: null }, noDeliveriesExpected: true }, true);
    assert.equal(fs.existsSync(file), false);
  } finally { await rpc?.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
