import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startCoordinatorRpc } from "../src/coordinator-rpc.ts";

const fixture = fileURLToPath(new URL("./fixtures/coordinator-rpc-child.ts", import.meta.url));

const prepared = {
  mode: "do",
  tickets: ["YM-1"],
  model: "test/model",
  cwd: process.cwd(),
  plans: {},
  parts: [],
  prompt: "work",
  skillsPath: process.cwd(),
  resourcesPath: process.cwd(),
} as any;
const identity = { runId: "run-1", parentSessionId: "parent", mode: "do" as const, ticket: "YM-1", project: [], role: "coordinator" as const, cwd: process.cwd(), model: "test/model" };

test("coordinator RPC stays owned and alive after an accepted prompt until teardown", async () => {
  let delayed!: () => void;
  let grandchildPid: number | undefined;
  const nested = new Promise<void>((resolve) => { delayed = resolve; });
  const rpc = startCoordinatorRpc(prepared, identity, { onEvent: (event) => {
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
  } finally {
    await rpc.stop();
  }
  assert.notEqual(rpc.process.exitCode, null);
  assert.throws(() => process.kill(grandchildPid!, 0));
});
