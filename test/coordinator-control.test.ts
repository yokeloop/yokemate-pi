import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindCoordinatorControl, processStarttime, requestCoordinator } from "../src/coordinator-control.ts";
import { socketDir } from "../src/inbox.ts";

test("coordinator control accepts one bound live origin and rejects a wrong parent", async () => {
  const root = mkdtempSync(join(tmpdir(), "coordinator-control-"));
  const runtime = mkdtempSync(join(tmpdir(), "coordinator-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  let launches = 0;
  const server = bindCoordinatorControl(root, {
    async launch(request) { launches += 1; return { runId: `run-${request.tickets[0]}`, identity: request }; },
    status(requestId) { return { requestId, state: "status", reason: "active" }; },
    async cancel() {},
  }, { root, sessionId: "session", runtimeId: "runtime", pid: process.pid, starttime: processStarttime(process.pid)!, cwd: root, pane: "main" }, env);
  try {
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const origin = { sessionId: "session", pid: process.pid, starttime: processStarttime(process.pid)!, cwd: root };
    const accepted = await requestCoordinator(root, { mode: "do", tickets: ["YM-1"] }, origin, { sessionId: "session", runtimeId: "runtime" }, env);
    assert.equal(accepted.state, "accepted");
    assert.equal(launches, 1);
    const refused = await requestCoordinator(root, { mode: "do", tickets: ["YM-2"] }, origin, { sessionId: "other", runtimeId: "runtime" }, env);
    assert.equal(refused.state, "refused");
    const reusedPid = await requestCoordinator(root, { mode: "do", tickets: ["YM-3"] }, { ...origin, starttime: "0" }, { sessionId: "session", runtimeId: "runtime" }, env);
    assert.equal(reusedPid.state, "refused");
    const runtimeDir = socketDir(env, process.getuid!());
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, "plan.json"), JSON.stringify({ pid: process.pid, cwd: root }));
    const panel = await requestCoordinator(root, { mode: "do", tickets: ["YM-4"] }, { ...origin, sessionId: "plan-session", pane: "plan", parentPane: "main" }, { sessionId: "session", runtimeId: "runtime" }, env);
    assert.equal(panel.state, "accepted");
    const brokenChain = await requestCoordinator(root, { mode: "do", tickets: ["YM-5"] }, { ...origin, sessionId: "other-panel", pane: "plan", parentPane: "missing" }, { sessionId: "session", runtimeId: "runtime" }, env);
    assert.equal(brokenChain.state, "refused");
    assert.equal(launches, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});
