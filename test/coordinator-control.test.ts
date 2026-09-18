import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindCoordinatorControl, processStarttime, requestCoordinator, requestPlanControl } from "../src/coordinator-control.ts";
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

test("main pane sidecars canonicalize only the unstamped main mode for plan registration", async () => {
  const root = mkdtempSync(join(tmpdir(), "main-plan-control-"));
  const runtime = mkdtempSync(join(tmpdir(), "main-plan-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const target = { sessionId: "main-session", runtimeId: "main-runtime" };
  const starttime = processStarttime(process.pid)!;
  const runtimeDir = socketDir(env, process.getuid!());
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "main-pane.json"), JSON.stringify({ pid: process.pid, cwd: root, mode: "main", ticket: null }));
  writeFileSync(join(runtimeDir, "plan-pane.json"), JSON.stringify({ pid: process.pid, cwd: root, mode: "plan", ticket: "YM-1" }));
  const server = bindCoordinatorControl(root, {
    launch: async () => { throw new Error("unexpected launch"); },
    status: (requestId) => ({ requestId, state: "status" }), cancel: async () => {},
    publishPlanScout: async () => ({ reason: "published", publication: "complete", target: "fixture", revision: "a".repeat(64) }),
  }, { root, ...target, pid: process.pid, starttime, cwd: root, pane: "main-pane" }, env);
  try {
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const main = { sessionId: target.sessionId, pid: process.pid, starttime, cwd: root, pane: "main-pane" };
    const register = await requestPlanControl(root, "register-plan", { ticket: "YM-1" }, main, target, env);
    assert.equal(register.state, "accepted", register.reason ?? "plan registration refused");
    assert.ok(register.runId);
    const payload = { ticket: "YM-1", runId: register.runId };
    assert.equal((await requestPlanControl(root, "bind-plan", { ...payload, pane: "plan-pane" }, main, target, env)).state, "accepted");
    const worker = { ...main, sessionId: "plan-session", mode: "plan", ticket: "YM-1", role: "coordinator", pane: "plan-pane", parentPane: "main-pane" };
    assert.equal((await requestPlanControl(root, "plan-started", payload, worker, target, env)).state, "accepted");
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ...payload, acceptanceId: 1 }, worker, target, env)).publication, "complete");
    const stampedMain = await requestPlanControl(root, "register-plan", { ticket: "YM-2" }, { ...main, mode: "main" }, target, env);
    assert.equal(stampedMain.state, "refused");
    assert.match(stampedMain.reason ?? "", /panel origin|verified main parent/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("ticketless problem workers can continue only tickets admitted by their accepted scout", async () => {
  const root = mkdtempSync(join(tmpdir(), "problem-plan-control-"));
  const runtime = mkdtempSync(join(tmpdir(), "problem-plan-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const target = { sessionId: "main-session", runtimeId: "main-runtime" };
  const main = { sessionId: target.sessionId, pid: process.pid, starttime: processStarttime(process.pid)!, cwd: root };
  let prepares = 0;
  let descendant: ChildProcess | undefined;
  const server = bindCoordinatorControl(root, {
    launch: async () => { throw new Error("unexpected launch"); },
    status: (requestId) => ({ requestId, state: "status" }), cancel: async () => {},
    publishPlanScout: async (ticket, acceptanceId) => ({ reason: `${ticket}/${acceptanceId}`, publication: "complete", target: "fixture", revision: "a".repeat(64) }),
    preparePlanPublication: async (_ticket, _path, _hash, acceptanceId) => { prepares++; assert.equal(acceptanceId, 1); return { reason: "prepared", publicationId: 2, recordId: 3, snapshotPath: "/snapshot", scoutPublication: 1, target: "fixture", revision: "b".repeat(64) }; },
  }, { root, ...target, pid: process.pid, starttime: main.starttime, cwd: root, pane: "main" }, env);
  try {
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const runtimeDir = socketDir(env, process.getuid!());
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, "problem.json"), JSON.stringify({ pid: process.pid, cwd: root, mode: "plan", ticket: null }));
    const worker = { ...main, sessionId: "problem-session", mode: "plan", role: "coordinator", pane: "problem", parentPane: "main" };
    const prepare = (ticket: string) => requestPlanControl(root, "prepare-plan-publication", { ticket, path: "/plan.md", contentHash: "c".repeat(64) }, worker, target, env);
    assert.equal((await prepare("YM-1")).state, "refused");
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ticket: "YM-1", acceptanceId: 1 }, worker, target, env)).state, "accepted");
    descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => { descendant!.once("spawn", resolve); descendant!.once("error", reject); });
    const descendantOrigin = { ...worker, pid: descendant.pid!, starttime: processStarttime(descendant.pid!)! };
    assert.equal((await requestPlanControl(root, "prepare-plan-publication", { ticket: "YM-1", path: "/plan.md", contentHash: "c".repeat(64) }, descendantOrigin, target, env)).state, "accepted");
    assert.equal((await requestPlanControl(root, "reject-plan-scout", { ticket: "YM-1" }, worker, target, env)).state, "accepted");
    assert.equal((await prepare("YM-1")).state, "refused");
    assert.equal((await prepare("YM-2")).state, "refused");
    assert.equal(prepares, 1);
  } finally {
    if (descendant?.exitCode === null && descendant.signalCode === null) descendant.kill("SIGTERM");
    if (descendant && descendant.exitCode === null && descendant.signalCode === null) await new Promise<void>((resolve) => descendant!.once("close", () => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("plan handoff is bound to the registered pane run and its live worker session", async () => {
  const root = mkdtempSync(join(tmpdir(), "plan-control-"));
  const runtime = mkdtempSync(join(tmpdir(), "plan-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const target = { sessionId: "main-session", runtimeId: "main-runtime" };
  const main = { sessionId: target.sessionId, pid: process.pid, starttime: processStarttime(process.pid)!, cwd: root };
  let records = 0;
  const prepareAcceptances: number[] = [];
  let releaseDelayed: (() => void) | undefined;
  let markDelayedStarted: (() => void) | undefined;
  const delayedStarted = new Promise<void>((resolve) => { markDelayedStarted = resolve; });
  const server = bindCoordinatorControl(root, {
    launch: async () => { throw new Error("unexpected launch"); },
    status: (requestId) => ({ requestId, state: "status" }), cancel: async () => {},
    publishPlanScout: async (_ticket, acceptanceId) => {
      if (acceptanceId === 12) {
        markDelayedStarted!();
        await new Promise<void>((resolve) => { releaseDelayed = resolve; });
      }
      return { reason: "published", publication: "complete", target: "fixture", revision: "a".repeat(64) };
    },
    preparePlanPublication: async (_ticket, _path, _hash, acceptanceId) => { prepareAcceptances.push(acceptanceId); return { reason: "prepared", publicationId: 2, recordId: 3, snapshotPath: "/snapshot", scoutPublication: 1, target: "fixture", revision: "b".repeat(64) }; },
    planRecorded: async (ticket, path, recordId) => { records++; assert.equal(ticket, "YM-1"); assert.equal(path, "/recorded.md"); assert.equal(recordId, 7); return { reason: "recorded" }; },
  }, { root, ...target, pid: process.pid, starttime: main.starttime, cwd: root, pane: "main" }, env);
  try {
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const register = await requestPlanControl(root, "register-plan", { ticket: "YM-1" }, main, target, env);
    assert.equal(register.state, "accepted");
    assert.ok(register.runId);
    const payload = { ticket: "YM-1", runId: register.runId };
    const worker = { ...main, sessionId: "plan-session", mode: "plan", ticket: "YM-1", role: "coordinator", pane: "plan", parentPane: "main" };
    writeFileSync(join(socketDir(env, process.getuid!()), "plan.json"), JSON.stringify({ pid: process.pid, cwd: root, mode: "plan", ticket: "YM-1" }));
    const handoff = { ...payload, path: "/recorded.md", recordId: 7 };
    assert.equal((await requestPlanControl(root, "plan-recorded", handoff, worker, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "bind-plan", { ...payload, pane: "plan" }, main, target, env)).state, "accepted");
    assert.equal((await requestPlanControl(root, "plan-started", payload, worker, target, env)).state, "accepted");
    const prepare = () => requestPlanControl(root, "prepare-plan-publication", { ...payload, path: "/plan.md", contentHash: "c".repeat(64) }, worker, target, env);
    assert.equal((await prepare()).state, "refused");
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ...payload, acceptanceId: 11 }, worker, target, env)).state, "accepted");
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ticket: "YM-1", runId: "foreign", acceptanceId: 13 }, worker, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ...payload, acceptanceId: 13 }, { ...worker, sessionId: "foreign" }, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ticket: "YM-2", runId: payload.runId, acceptanceId: 13 }, worker, target, env)).state, "refused");
    assert.equal((await prepare()).state, "accepted");
    assert.equal((await requestPlanControl(root, "reject-plan-scout", { ...payload, acceptanceId: 11 }, worker, target, env)).state, "accepted");
    assert.equal((await prepare()).state, "refused");
    const delayed = requestPlanControl(root, "publish-plan-scout", { ...payload, acceptanceId: 12 }, worker, target, env);
    await delayedStarted;
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ...payload, acceptanceId: 13 }, worker, target, env)).publication, "complete");
    assert.equal((await prepare()).state, "accepted");
    releaseDelayed!();
    const superseded = await delayed;
    assert.equal(superseded.publication, "pending");
    assert.equal(superseded.reason, "scout superseded");
    const oldRejection = await requestPlanControl(root, "reject-plan-scout", { ...payload, acceptanceId: 12 }, worker, target, env);
    assert.equal(oldRejection.state, "accepted");
    assert.equal(oldRejection.reason, "scout rejection superseded");
    assert.equal((await prepare()).state, "accepted");
    assert.equal((await requestPlanControl(root, "plan-recorded", { ...handoff, runId: "foreign" }, worker, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "plan-recorded", handoff, { ...worker, sessionId: "foreign" }, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "plan-recorded", handoff, worker, target, env)).state, "accepted");
    assert.equal(records, 1);
    assert.deepEqual(prepareAcceptances, [11, 13, 13]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});
