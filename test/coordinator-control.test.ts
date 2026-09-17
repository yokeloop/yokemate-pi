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

test("plan handoff is bound to the registered pane run and its live worker session", async () => {
  const { requestPlanControl } = await import("../src/coordinator-control.ts");
  const root = mkdtempSync(join(tmpdir(), "plan-control-"));
  const runtime = mkdtempSync(join(tmpdir(), "plan-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const target = { sessionId: "main-session", runtimeId: "main-runtime" };
  const main = { sessionId: target.sessionId, pid: process.pid, starttime: processStarttime(process.pid)!, cwd: root };
  let records = 0;
  const server = bindCoordinatorControl(root, {
    launch: async () => { throw new Error("unexpected launch"); },
    status: (requestId) => ({ requestId, state: "status" }), cancel: async () => {},
    planRecorded: async (ticket, path) => { records++; assert.equal(ticket, "YM-1"); assert.equal(path, "/recorded.md"); return { reason: "recorded" }; },
  }, { root, ...target, pid: process.pid, starttime: main.starttime, cwd: root, pane: "main" }, env);
  try {
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const register = await requestPlanControl(root, "register-plan", { ticket: "YM-1" }, main, target, env);
    assert.equal(register.state, "accepted");
    assert.ok(register.runId);
    const payload = { ticket: "YM-1", runId: register.runId };
    const worker = { ...main, sessionId: "plan-session", mode: "plan", ticket: "YM-1", role: "coordinator", pane: "plan", parentPane: "main" };
    writeFileSync(join(socketDir(env, process.getuid!()), "plan.json"), JSON.stringify({ pid: process.pid, cwd: root, mode: "plan", ticket: "YM-1" }));
    const handoff = { ...payload, path: "/recorded.md" };
    assert.equal((await requestPlanControl(root, "plan-recorded", handoff, worker, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "bind-plan", { ...payload, pane: "plan" }, main, target, env)).state, "accepted");
    assert.equal((await requestPlanControl(root, "plan-started", payload, worker, target, env)).state, "accepted");
    assert.equal((await requestPlanControl(root, "plan-recorded", { ...handoff, runId: "foreign" }, worker, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "plan-recorded", handoff, { ...worker, sessionId: "foreign" }, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "plan-recorded", handoff, worker, target, env)).state, "accepted");
    assert.equal(records, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});
