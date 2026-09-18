import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindCoordinatorControl, processStarttime, requestCoordinator, requestCoordinatorMerge, requestPlanLaunch, requestPlanControl, requestShipFinalize } from "../src/coordinator-control.ts";
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
    writeFileSync(join(runtimeDir, "plan.json"), JSON.stringify({ pid: process.pid, cwd: root, mode: "plan", ticket: null }));
    const panel = await requestCoordinator(root, { mode: "do", tickets: ["YM-4"] }, { ...origin, sessionId: "plan-session", pane: "plan", parentPane: "main", mode: "plan" }, { sessionId: "session", runtimeId: "runtime" }, env);
    assert.equal(panel.state, "accepted");
    const brokenChain = await requestCoordinator(root, { mode: "do", tickets: ["YM-5"] }, { ...origin, sessionId: "other-panel", pane: "plan", parentPane: "missing", mode: "plan" }, { sessionId: "session", runtimeId: "runtime" }, env);
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
    if (descendant && descendant.exitCode === null) {
      descendant.kill("SIGKILL");
      descendant.unref();
    }
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("real main pane sidecar admits an unstamped child plan list without widening origin checks", async () => {
  const root = mkdtempSync(join(tmpdir(), "coordinator-main-plan-"));
  const runtime = mkdtempSync(join(tmpdir(), "coordinator-main-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const target = { sessionId: "main-session", runtimeId: "main-runtime" };
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  const childStarttime = processStarttime(child.pid!);
  assert.ok(childStarttime);
  const origins: unknown[] = [];
  const server = bindCoordinatorControl(root, {
    async launch() { throw new Error("unexpected coordinator launch"); },
    async launchPlan(request, origin) {
      origins.push(origin);
      return { listRunId: "plan-list-1", results: request.targets.map((item, index) => ({ key: item.ticket, keyRunId: `plan-${index + 1}`, state: "accepted" as const })) };
    },
    status(requestId) { return { requestId, state: "status" }; },
    async cancel() {},
  }, { root, ...target, pid: process.pid, starttime: processStarttime(process.pid)!, cwd: root, pane: "main-pane" }, env);
  try {
    if (!server.listening) await once(server, "listening");
    const runtimeDir = socketDir(env, process.getuid!());
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, "main-pane.json"), JSON.stringify({ mode: "main", ticket: null, cwd: root, pid: process.pid }));
    const request = { targets: ["YM-1", "YM-2"].map((ticket) => ({ ticket, workerWords: [ticket] })), surface: "tab" as const, literal: [], parentPane: "main-pane", parentWorkspace: "workspace" };
    const origin = { sessionId: target.sessionId, pid: child.pid!, starttime: childStarttime, cwd: root, pane: "main-pane" };
    const accepted = await requestPlanLaunch(root, request, origin, target, env);
    assert.equal(accepted.state, "accepted");
    assert.equal(accepted.listRunId, "plan-list-1");
    assert.deepEqual(accepted.results?.map((result) => [result.key, result.keyRunId]), [["YM-1", "plan-1"], ["YM-2", "plan-2"]]);
    assert.deepEqual(origins, [origin]);
    for (const changed of [
      { origin: { ...origin, mode: "plan" }, target },
      { origin: { ...origin, ticket: "YM-1" }, target },
      { origin: { ...origin, cwd: join(root, "foreign") }, target },
      { origin: { ...origin, starttime: "0" }, target },
      { origin: { ...origin, sessionId: "foreign-session", parentPane: "foreign-pane" }, target },
      { origin, target: { ...target, sessionId: "foreign-parent" } },
      { origin, target: { ...target, runtimeId: "foreign-runtime" } },
    ]) assert.equal((await requestPlanLaunch(root, request, changed.origin, changed.target, env)).state, "refused");
    assert.equal(origins.length, 1);
  } finally {
    child.kill();
    await once(child, "exit");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("one control request retains every sibling list identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "coordinator-list-control-"));
  const runtime = mkdtempSync(join(tmpdir(), "coordinator-list-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const target = { sessionId: "session", runtimeId: "runtime" };
  const statuses: string[] = [];
  const server = bindCoordinatorControl(root, {
    async launch(request) { return { listRunId: "list-1", results: request.tickets.map((key, index) => ({ key, keyRunId: `key-${index + 1}`, state: "accepted" as const })) }; },
    status(runId) { statuses.push(runId); return { requestId: runId, state: "status", runId }; },
    async cancel() {},
  }, { root, ...target, pid: process.pid, starttime: processStarttime(process.pid)!, cwd: root }, env);
  try {
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const origin = { sessionId: "session", pid: process.pid, starttime: processStarttime(process.pid)!, cwd: root };
    const accepted = await requestCoordinator(root, { mode: "do", tickets: ["YM-1", "YM-2"] }, origin, target, env);
    assert.equal(accepted.listRunId, "list-1");
    assert.equal(accepted.runId, "key-1");
    assert.deepEqual(accepted.results?.map((result) => result.keyRunId), ["key-1", "key-2"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("merge control passes trusted live origin and structured result to the parent", async () => {
  const root = mkdtempSync(join(tmpdir(), "coordinator-merge-control-"));
  const runtime = mkdtempSync(join(tmpdir(), "coordinator-merge-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const target = { sessionId: "session", runtimeId: "runtime" };
  let calls = 0;
  const server = bindCoordinatorControl(root, {
    async launch() { throw new Error("unexpected launch"); },
    async merge(runId, request, origin) { calls++; assert.equal(runId, "run-1"); assert.equal(origin.pid, process.pid); return { repo: "org/repo", pr: request.pr, head: request.expectedHead, state: "merged" }; },
    async finalizeShip(runId, origin) { calls++; assert.equal(runId, "run-1"); assert.equal(origin.pid, process.pid); return { journal: { line: "shipped", path: "journal/2026-09.md", repeated: false }, localSync: { state: "committed" }, push: { state: "committed" }, cleanup: "removed" }; },
    status(requestId) { return { requestId, state: "status" }; },
    async cancel() {},
  }, { root, ...target, pid: process.pid, starttime: processStarttime(process.pid)!, cwd: root }, env);
  try {
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const origin = { sessionId: "session", pid: process.pid, starttime: processStarttime(process.pid)!, cwd: root, mode: "ship", ticket: "YM-1", role: "coordinator" };
    const reply = await requestCoordinatorMerge(root, "run-1", { pr: "https://github.com/org/repo/pull/1", expectedHead: "a".repeat(40), method: "merge" }, origin, target, env);
    assert.equal(reply.state, "accepted");
    assert.equal(reply.merge?.state, "merged");
    const finalized = await requestShipFinalize(root, "run-1", origin, target, env);
    assert.equal(finalized.state, "accepted");
    assert.equal(finalized.finalization?.cleanup, "removed");
    assert.equal(calls, 2);
  } finally {
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
