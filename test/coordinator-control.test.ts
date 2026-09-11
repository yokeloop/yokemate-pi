import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindCoordinatorControl, requestCoordinator } from "../src/coordinator-control.ts";

test("coordinator control accepts one bound live origin and rejects a wrong parent", async () => {
  const root = mkdtempSync(join(tmpdir(), "coordinator-control-"));
  const runtime = mkdtempSync(join(tmpdir(), "coordinator-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  let launches = 0;
  const server = bindCoordinatorControl(root, {
    async launch(request) { launches += 1; return { runId: `run-${request.tickets[0]}`, identity: request }; },
    status(requestId) { return { requestId, state: "status", reason: "active" }; },
    async cancel() {},
  }, { root, sessionId: "session", runtimeId: "runtime", pid: process.pid, cwd: root }, env);
  try {
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const origin = { sessionId: "session", pid: process.pid, cwd: root };
    const accepted = await requestCoordinator(root, { mode: "do", tickets: ["YM-1"] }, origin, { sessionId: "session", runtimeId: "runtime" }, env);
    assert.equal(accepted.state, "accepted");
    assert.equal(launches, 1);
    const refused = await requestCoordinator(root, { mode: "do", tickets: ["YM-2"] }, origin, { sessionId: "other", runtimeId: "runtime" }, env);
    assert.equal(refused.state, "refused");
    assert.equal(launches, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});
