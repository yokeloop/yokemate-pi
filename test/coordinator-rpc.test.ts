import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
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
    assert.ok(rpc.process instanceof ChildProcess);
    const runningAgents = new Map<ChildProcess, string>([[rpc.process, "do YM-1"]]);
    assert.equal(runningAgents.get(rpc.process), "do YM-1");
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
