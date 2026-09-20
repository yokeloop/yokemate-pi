import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bindCoordinatorControl, processStarttime, requestCoordinatorCancel, requestPlanControl } from "../src/coordinator-control.ts";
import { socketDir } from "../src/inbox.ts";

async function listening(server: import("node:net").Server) {
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
}

test("only a live blocked plan lineage can continue one registered candidate generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "plan-recovery-control-"));
  const runtime = mkdtempSync(join(tmpdir(), "plan-recovery-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const target = { sessionId: "main-session", runtimeId: "main-runtime" };
  const starttime = processStarttime(process.pid)!;
  const runtimeDir = socketDir(env, process.getuid!());
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "main-pane.json"), JSON.stringify({ pid: process.pid, cwd: root, mode: "main", ticket: null }));
  writeFileSync(join(runtimeDir, "plan-pane.json"), JSON.stringify({ pid: process.pid, cwd: root, mode: "plan", ticket: "YM-1" }));
  const server = bindCoordinatorControl(root, {
    launch: async () => { throw new Error("unexpected"); },
    status: (requestId) => ({ requestId, state: "status" }),
    cancel: async () => {},
    planFinished: async () => {},
  }, { root, ...target, pid: process.pid, starttime, cwd: root, pane: "main-pane" }, env);
  try {
    await listening(server);
    const main = { sessionId: target.sessionId, pid: process.pid, starttime, cwd: root, pane: "main-pane" };
    const register = await requestPlanControl(root, "register-plan", { ticket: "YM-1" }, main, target, env);
    const runId = register.runId!;
    await requestPlanControl(root, "bind-plan", { ticket: "YM-1", runId, pane: "plan-pane" }, main, target, env);
    const worker = { ...main, sessionId: "plan-session", mode: "plan", ticket: "YM-1", role: "coordinator", pane: "plan-pane", parentPane: "main-pane" };
    assert.equal((await requestPlanControl(root, "plan-started", { ticket: "YM-1", runId }, worker, target, env)).state, "accepted");
    const candidateId = "11111111-1111-4111-8111-111111111111";
    const failureHash = "a".repeat(64);
    assert.equal((await requestPlanControl(root, "register-scout-candidate", { ticket: "YM-1", runId, candidateId, failureHash, generation: 1 }, worker, target, env)).state, "accepted");
    assert.equal((await requestPlanControl(root, "read-scout-candidate", { ticket: "YM-1", runId, candidateId }, worker, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "continue-scout-candidate", { ticket: "YM-1", runId, candidateId, failureHash }, main, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "plan-finished", { ticket: "YM-1", runId, outcome: "blocked", reason: "transport failed" }, worker, target, env)).state, "accepted");
    const read = await requestPlanControl(root, "read-scout-candidate", { ticket: "YM-1", runId, candidateId }, main, target, env);
    assert.equal(read.state, "accepted");
    assert.equal(read.failureHash, failureHash);
    const continued = await requestPlanControl(root, "continue-scout-candidate", { ticket: "YM-1", runId, candidateId, failureHash }, main, target, env);
    assert.equal(continued.state, "accepted");
    assert.equal(continued.generation, 2);
    assert.equal(continued.planningIdentity, `${runId}:2`);
    assert.equal((await requestPlanControl(root, "continue-scout-candidate", { ticket: "YM-1", runId, candidateId, failureHash }, main, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "admit-plan-writer", { ticket: "YM-1", runId, candidateId, failureHash, generation: 2, writerRunId: "writer-run", acceptanceId: 7 }, main, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "bind-recovered-scout", { ticket: "YM-1", runId, candidateId, failureHash, acceptanceId: 7 }, worker, target, env)).state, "refused");
    const bound = await requestPlanControl(root, "bind-recovered-scout", { ticket: "YM-1", runId, candidateId, failureHash, acceptanceId: 7 }, main, target, env);
    assert.equal(bound.state, "accepted");
    const writerInput = await requestPlanControl(root, "read-plan-writer-input", { ticket: "YM-1", runId }, worker, target, env);
    assert.equal(writerInput.acceptanceId, 7);
    const writer = await requestPlanControl(root, "admit-plan-writer", { ticket: "YM-1", runId, candidateId, failureHash, generation: 2, writerRunId: "writer-run", acceptanceId: 7 }, worker, target, env);
    assert.equal(writer.state, "accepted");
    assert.equal(writer.planningIdentity, `${runId}:2`);
    assert.equal((await requestCoordinatorCancel(root, runId, main, target, env)).state, "accepted");
    assert.equal((await requestPlanControl(root, "read-plan-writer-input", { ticket: "YM-1", runId }, worker, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "admit-plan-writer", { ticket: "YM-1", runId, candidateId, failureHash, generation: 2, writerRunId: "late-writer", acceptanceId: 7 }, worker, target, env)).state, "refused");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});
