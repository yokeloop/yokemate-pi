import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindCoordinatorControl, processStarttime, requestCoordinator, requestCoordinatorMerge, requestPlanLaunch, requestPlanControl, requestShipFinalize } from "../src/coordinator-control.ts";
import { socketDir } from "../src/inbox.ts";
import { openDb } from "../src/db.ts";
import { readCandidatePlanSnapshot, type PlanBinding } from "../src/plan-binding.ts";
import type { ChildIdentity } from "../src/subagent-runs.ts";

function recordedPlan(root: string, ticket: string): PlanBinding {
  const folder = join(root, "home", "knowledge", "org", "repo", "ai", `${ticket}-fixture`);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${ticket}-fixture-plan.md`);
  writeFileSync(path, `# ${ticket} — fixture\n\n## Goal\nVerify completion.\n\n## Affected repositories\n\n- \`org/repo\` — app.\n\n## Steps\n\n1. Verify.\n\n## Assumptions\n\n- Fixture.\n\n## Out of scope\n\n- Production.\n\n## Acceptance\n\n- Completion is exact.\n`);
  const db = openDb(join(root, "yokemate.db"));
  db.prepare("INSERT INTO work(ticket,url,stage,plan) VALUES (?,?,?,?)").run(ticket, `https://example.invalid/${ticket}`, "planned", path);
  db.close();
  return readCandidatePlanSnapshot(root, ticket, path);
}

const scoutChild = (origin: { sessionId: string }, ticket: string, suffix: string): ChildIdentity => ({ ownerRunId: `owner-${suffix}`, ownerSessionId: origin.sessionId, batchId: `batch-${suffix}`, runId: `run-${suffix}`, agent: "plan-scout", taskHash: suffix.padEnd(64, "a").slice(0, 64), cwd: "", ticket });

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
    assert.equal((await requestPlanControl(root, "plan-started", { ticket: "YM-1", runId: "" }, worker, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "plan-started", { ticket: "YM-1", runId: "removed" }, worker, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "plan-started", payload, worker, target, env)).state, "accepted");
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ...payload, acceptanceId: 1, child: { ...scoutChild(worker, "YM-1", "main"), cwd: root } }, worker, target, env)).publication, "complete");
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
    preparePlanPublication: async (ticket, path, hash, acceptanceId) => { prepares++; assert.equal(acceptanceId, 1); return { reason: "prepared", publicationId: 2, recordId: 3, snapshotPath: "/snapshot", scoutPublication: 1, scoutAcceptance: acceptanceId, target: "fixture", revision: hash, binding: { ticket, path, contentHash: hash, scopeHash: "d".repeat(64), repositories: ["org/repo"] } }; },
  }, { root, ...target, pid: process.pid, starttime: main.starttime, cwd: root, pane: "main" }, env);
  try {
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const runtimeDir = socketDir(env, process.getuid!());
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, "problem.json"), JSON.stringify({ pid: process.pid, cwd: root, mode: "plan", ticket: null }));
    const worker = { ...main, sessionId: "problem-session", mode: "plan", role: "coordinator", pane: "problem", parentPane: "main" };
    const prepare = (ticket: string) => requestPlanControl(root, "prepare-plan-publication", { ticket, path: "/plan.md", contentHash: "c".repeat(64) }, worker, target, env);
    assert.equal((await prepare("YM-1")).state, "refused");
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ticket: "YM-1", acceptanceId: 1, child: { ...scoutChild(worker, "YM-1", "problem"), cwd: root } }, worker, target, env)).state, "accepted");
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
  const binding = recordedPlan(root, "YM-1");
  const runtime = mkdtempSync(join(tmpdir(), "plan-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const target = { sessionId: "main-session", runtimeId: "main-runtime" };
  const main = { sessionId: target.sessionId, pid: process.pid, starttime: processStarttime(process.pid)!, cwd: root };
  let records = 0;
  let ownedRecords = 0;
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
    preparePlanPublication: async (_ticket, _path, _hash, acceptanceId) => { prepareAcceptances.push(acceptanceId); return { reason: "prepared", publicationId: 2, recordId: 3, snapshotPath: "/snapshot", scoutPublication: 1, scoutAcceptance: acceptanceId, target: "fixture", revision: binding.contentHash, binding }; },
    recordPlan: async (_ticket, _path, _origin, _context, _acceptance, verify) => { ownedRecords++; verify(binding); return { reason: "recorded" }; },
    planRecorded: async (ticket, path, recordId, _origin, _context, verify) => { records++; assert.equal(ticket, "YM-1"); assert.equal(path, binding.path); assert.equal(recordId, 3); verify(binding); return { reason: "recorded" }; },
  }, { root, ...target, pid: process.pid, starttime: main.starttime, cwd: root, pane: "main" }, env);
  try {
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const register = await requestPlanControl(root, "register-plan", { ticket: "YM-1" }, main, target, env);
    assert.equal(register.state, "accepted");
    assert.ok(register.runId);
    const payload = { ticket: "YM-1", runId: register.runId };
    const worker = { ...main, sessionId: "plan-session", mode: "plan", ticket: "YM-1", role: "coordinator", pane: "plan", parentPane: "main" };
    writeFileSync(join(socketDir(env, process.getuid!()), "plan.json"), JSON.stringify({ pid: process.pid, cwd: root, mode: "plan", ticket: "YM-1" }));
    const handoff = { ...payload, path: binding.path, recordId: 3 };
    assert.equal((await requestPlanControl(root, "plan-recorded", handoff, worker, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "bind-plan", { ...payload, pane: "plan" }, main, target, env)).state, "accepted");
    assert.equal((await requestPlanControl(root, "plan-started", payload, worker, target, env)).state, "accepted");
    const recordWithoutScout = await requestPlanControl(root, "record-plan", { ...payload, path: binding.path }, worker, target, env);
    assert.equal(recordWithoutScout.state, "refused");
    assert.match(recordWithoutScout.reason ?? "", /current accepted scout/);
    assert.equal(ownedRecords, 0);
    const prepare = () => requestPlanControl(root, "prepare-plan-publication", { ...payload, path: binding.path, contentHash: binding.contentHash }, worker, target, env);
    assert.equal((await prepare()).state, "refused");
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ...payload, acceptanceId: 11, child: { ...scoutChild(worker, "YM-1", "eleven"), cwd: root } }, worker, target, env)).state, "accepted");
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ...payload, acceptanceId: 11, child: { ...scoutChild(worker, "YM-1", "other-delivery"), cwd: root } }, worker, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ticket: "YM-1", runId: "foreign", acceptanceId: 13, child: { ...scoutChild(worker, "YM-1", "foreign"), cwd: root } }, worker, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ...payload, acceptanceId: 13, child: { ...scoutChild(worker, "YM-1", "session"), cwd: root } }, { ...worker, sessionId: "foreign" }, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ticket: "YM-2", runId: payload.runId, acceptanceId: 13, child: { ...scoutChild(worker, "YM-2", "ticket"), cwd: root } }, worker, target, env)).state, "refused");
    assert.equal((await prepare()).state, "accepted");
    assert.equal((await requestPlanControl(root, "reject-plan-scout", { ...payload, acceptanceId: 11 }, worker, target, env)).state, "accepted");
    assert.equal((await prepare()).state, "refused");
    const delayed = requestPlanControl(root, "publish-plan-scout", { ...payload, acceptanceId: 12, child: { ...scoutChild(worker, "YM-1", "twelve"), cwd: root } }, worker, target, env);
    await delayedStarted;
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ...payload, acceptanceId: 13, child: { ...scoutChild(worker, "YM-1", "thirteen"), cwd: root } }, worker, target, env)).publication, "complete");
    assert.equal((await prepare()).state, "accepted");
    releaseDelayed!();
    const superseded = await delayed;
    assert.equal(superseded.publication, "complete");
    assert.equal(superseded.artifactAcceptance, "superseded");
    assert.equal(superseded.reason, "scout superseded");
    const staleRetry = await requestPlanControl(root, "publish-plan-scout", { ...payload, acceptanceId: 12, child: { ...scoutChild(worker, "YM-1", "twelve"), cwd: root } }, worker, target, env);
    assert.equal(staleRetry.state, "refused");
    assert.match(staleRetry.reason ?? "", /superseded/);
    const oldRejection = await requestPlanControl(root, "reject-plan-scout", { ...payload, acceptanceId: 12 }, worker, target, env);
    assert.equal(oldRejection.state, "accepted");
    assert.equal(oldRejection.reason, "scout rejection superseded");
    assert.equal((await prepare()).state, "accepted");
    assert.equal((await requestPlanControl(root, "plan-recorded", { ...handoff, runId: "foreign" }, worker, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "plan-recorded", handoff, { ...worker, sessionId: "foreign" }, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "plan-recorded", handoff, worker, target, env)).state, "accepted");
    assert.equal((await requestPlanControl(root, "plan-recorded", handoff, worker, target, env)).state, "accepted");
    assert.equal((await requestPlanControl(root, "plan-recorded", { ticket: "YM-1", path: "/plan.md", recordId: 3 }, worker, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ticket: "YM-1", runId: "", acceptanceId: 14, child: { ...scoutChild(worker, "YM-1", "empty"), cwd: root } }, worker, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "prepare-plan-publication", { ticket: "YM-1", runId: "removed", path: binding.path, contentHash: binding.contentHash }, worker, target, env)).state, "refused");
    assert.equal(records, 1);
    assert.deepEqual(prepareAcceptances, [11, 13, 13]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});


test("plan worker process exit settles once without using herdr agent status", { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "plan-process-exit-"));
  const runtime = mkdtempSync(join(tmpdir(), "plan-process-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const target = { sessionId: "main-session", runtimeId: "main-runtime" };
  const starttime = processStarttime(process.pid)!;
  const runtimeDir = socketDir(env, process.getuid!());
  mkdirSync(runtimeDir, { recursive: true });
  let finishes = 0;
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
  const server = bindCoordinatorControl(root, {
    launch: async () => { throw new Error("unexpected launch"); },
    status: (requestId) => ({ requestId, state: "status" }),
    cancel: async () => {},
    planFinished: async (_ticket, _runId, outcome, reason) => {
      finishes += 1;
      assert.equal(outcome, "cancelled");
      assert.match(reason, /process ended before a terminal record/);
      resolveFinished();
    },
  }, { root, ...target, pid: process.pid, starttime, cwd: root, pane: "main" }, env);
  let child: ChildProcess | undefined;
  try {
    if (!server.listening) await once(server, "listening");
    const main = { sessionId: target.sessionId, pid: process.pid, starttime, cwd: root };
    const registered = await requestPlanControl(root, "register-plan", { ticket: "YM-1" }, main, target, env);
    assert.equal(registered.state, "accepted");
    assert.ok(registered.runId);
    assert.equal((await requestPlanControl(root, "bind-plan", { ticket: "YM-1", runId: registered.runId, pane: "plan" }, main, target, env)).state, "accepted");
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await once(child, "spawn");
    const worker = { sessionId: "plan-session", pid: child.pid!, starttime: processStarttime(child.pid!)!, cwd: root, pane: "plan", parentPane: "main", mode: "plan", ticket: "YM-1", role: "coordinator" };
    writeFileSync(join(runtimeDir, "plan.json"), JSON.stringify({ pid: child.pid, cwd: root, mode: "plan", ticket: "YM-1" }));
    assert.equal((await requestPlanControl(root, "plan-started", { ticket: "YM-1", runId: registered.runId }, worker, target, env)).state, "accepted");
    child.kill("SIGKILL");
    await once(child, "exit");
    await finished;
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
    assert.equal(finishes, 1);
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("a correlated scout admits one live save-only worker and its CLI descendant", { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "save-only-plan-control-"));
  const binding = recordedPlan(root, "YM-7");
  const runtime = mkdtempSync(join(tmpdir(), "save-only-plan-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const target = { sessionId: "main-session", runtimeId: "main-runtime" };
  const runtimeDir = socketDir(env, process.getuid!());
  mkdirSync(runtimeDir, { recursive: true });
  let publications = 0;
  let preparations = 0;
  let completions = 0;
  let releaseCompletion!: () => void;
  let markCompletionStarted!: () => void;
  const completionStarted = new Promise<void>((resolve) => { markCompletionStarted = resolve; });
  const completionBarrier = new Promise<void>((resolve) => { releaseCompletion = resolve; });
  const server = bindCoordinatorControl(root, {
    launch: async () => { throw new Error("unexpected launch"); },
    status: (requestId) => ({ requestId, state: "status" }), cancel: async () => {},
    publishPlanScout: async (_ticket, acceptanceId, child) => {
      if (acceptanceId === 3 || acceptanceId === 5) throw new Error("artifact provenance refused");
      publications++;
      assert.match(child.runId, /^scout-save/);
      return { reason: "target_unavailable", publication: "pending", target: "unresolved/YM-7", revision: "a".repeat(64) };
    },
    preparePlanPublication: async (_ticket, _path, _hash, acceptanceId, _origin, context) => { preparations++; assert.equal(context.kind, "save-only"); return { reason: "prepared", recordId: 9, snapshotPath: "/snapshot", scoutAcceptance: acceptanceId, revision: binding.contentHash, binding }; },
    planRecorded: async (_ticket, _path, recordId, _origin, context, verify) => { completions++; assert.equal(recordId, 9); assert.equal(context.kind, "save-only"); markCompletionStarted(); await completionBarrier; verify(binding); return { reason: "plan-only; ready for /do; automatic handoff unavailable", handoff: "unavailable" }; },
  }, { root, ...target, pid: process.pid, starttime: processStarttime(process.pid)!, cwd: root, pane: "main" }, env);
  const owner = spawn(process.execPath, ["-e", `const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)`], { stdio: ["ignore", "pipe", "ignore"] });
  let cliPid = 0;
  try {
    if (!server.listening) await once(server, "listening");
    await once(owner, "spawn");
    owner.stdout!.setEncoding("utf8");
    cliPid = Number(String((await once(owner.stdout!, "data"))[0]).trim());
    assert.ok(cliPid > 0);
    const pane = "save-pane";
    writeFileSync(join(runtimeDir, `${pane}.json`), JSON.stringify({ pid: owner.pid, cwd: root, mode: "plan", ticket: "YM-7" }));
    const worker = { sessionId: "save-session", pid: owner.pid!, starttime: processStarttime(owner.pid!)!, cwd: root, pane, parentPane: "main", mode: "plan", ticket: "YM-7", role: "coordinator" };
    const child = { ...scoutChild(worker, "YM-7", "save"), runId: "scout-save", cwd: root };
    const cli = { ...worker, pid: cliPid, starttime: processStarttime(cliPid)! };
    const unknownPane = "save-unknown-parent";
    writeFileSync(join(runtimeDir, `${unknownPane}.json`), JSON.stringify({ pid: owner.pid, cwd: root, mode: "plan", ticket: "YM-7" }));
    const unknownParent = { ...worker, sessionId: target.sessionId, pane: unknownPane, parentPane: "missing" };
    const unknownChild = { ...child, ownerSessionId: target.sessionId };
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ticket: "YM-7", acceptanceId: 2, child: unknownChild }, unknownParent, target, env)).state, "refused");
    const initialFailure = await requestPlanControl(root, "publish-plan-scout", { ticket: "YM-7", acceptanceId: 3, child }, worker, target, env);
    assert.equal(initialFailure.state, "refused");
    assert.match(initialFailure.reason ?? "", /artifact provenance refused/);
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ticket: "YM-7", acceptanceId: 4, child }, cli, target, env)).state, "refused");
    const accepted = await requestPlanControl(root, "publish-plan-scout", { ticket: "YM-7", acceptanceId: 4, child }, worker, target, env);
    assert.equal(accepted.state, "accepted", accepted.reason ?? "save-only scout refused");
    assert.equal(accepted.publication, "pending");
    const foreignOwner = { ...child, ownerRunId: "foreign-owner", runId: "scout-save-foreign", batchId: "batch-foreign" };
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ticket: "YM-7", acceptanceId: 6, child: foreignOwner }, worker, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ticket: "YM-7", acceptanceId: 6, child }, cli, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "prepare-plan-publication", { ticket: "YM-7", path: binding.path, contentHash: binding.contentHash }, cli, target, env)).state, "accepted");
    const supersedingFailure = await requestPlanControl(root, "publish-plan-scout", { ticket: "YM-7", acceptanceId: 5, child: { ...child, runId: "scout-save-failed", batchId: "batch-save-failed" } }, worker, target, env);
    assert.equal(supersedingFailure.state, "refused");
    assert.equal((await requestPlanControl(root, "prepare-plan-publication", { ticket: "YM-7", path: binding.path, contentHash: binding.contentHash }, cli, target, env)).state, "refused");
    const nextChild = { ...scoutChild(worker, "YM-7", "save-next"), ownerRunId: child.ownerRunId, runId: "scout-save-next", cwd: root };
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ticket: "YM-7", acceptanceId: 6, child: nextChild }, worker, target, env)).state, "accepted");
    const prepared = await requestPlanControl(root, "prepare-plan-publication", { ticket: "YM-7", path: binding.path, contentHash: binding.contentHash }, cli, target, env);
    assert.equal(prepared.state, "accepted", prepared.reason ?? "save-only preparation refused");
    const recording = requestPlanControl(root, "plan-recorded", { ticket: "YM-7", path: binding.path, recordId: 9 }, cli, target, env);
    await completionStarted;
    const mainReconciliation = requestPlanControl(root, "plan-recorded", { ticket: "YM-7", path: binding.path, recordId: 9 }, { sessionId: target.sessionId, pid: process.pid, starttime: processStarttime(process.pid)!, cwd: root }, target, env);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    releaseCompletion();
    const [recorded, reconciled] = await Promise.all([recording, mainReconciliation]);
    assert.equal(recorded.state, "accepted", recorded.reason ?? "save-only completion refused");
    assert.equal(recorded.handoff, "unavailable");
    assert.equal(reconciled.state, "accepted", reconciled.reason ?? "in-flight reconciliation refused");
    assert.equal(reconciled.handoff, "unavailable");
    const repeat = await requestPlanControl(root, "plan-recorded", { ticket: "YM-7", path: binding.path, recordId: 9 }, cli, target, env);
    assert.equal(repeat.state, "accepted", repeat.reason ?? "save-only repeat refused");
    assert.equal(completions, 1);
    assert.equal(publications, 2);
    assert.equal(preparations, 2);
    writeFileSync(binding.path, readFileSync(binding.path, "utf8").replace("Verify completion.", "Verify changed completion."));
    const changed = await requestPlanControl(root, "plan-recorded", { ticket: "YM-7", path: binding.path, recordId: 9 }, cli, target, env);
    assert.equal(changed.state, "refused");
    assert.match(changed.reason ?? "", /retry binding changed/);
    const foreign = await requestPlanControl(root, "plan-recorded", { ticket: "YM-7", path: "/other.md", recordId: 9 }, cli, target, env);
    assert.equal(foreign.state, "refused");
  } finally {
    releaseCompletion?.();
    if (cliPid) try { process.kill(cliPid, "SIGKILL"); } catch {}
    if (owner.exitCode === null) owner.kill("SIGKILL");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("save-only completion is unconfirmed when its owner dies during publication", { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "save-only-death-control-"));
  const binding = recordedPlan(root, "YM-8");
  const runtime = mkdtempSync(join(tmpdir(), "save-only-death-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const target = { sessionId: "main-session", runtimeId: "main-runtime" };
  const runtimeDir = socketDir(env, process.getuid!());
  mkdirSync(runtimeDir, { recursive: true });
  let release!: () => void;
  let started!: () => void;
  const callbackStarted = new Promise<void>((resolve) => { started = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const server = bindCoordinatorControl(root, {
    launch: async () => { throw new Error("unexpected launch"); },
    status: (requestId) => ({ requestId, state: "status" }), cancel: async () => {},
    publishPlanScout: async () => ({ reason: "published", publication: "complete", target: "fixture", revision: binding.contentHash }),
    preparePlanPublication: async (_ticket, _path, _hash, acceptanceId) => ({ reason: "prepared", recordId: 10, snapshotPath: "/snapshot", scoutAcceptance: acceptanceId, revision: binding.contentHash, binding }),
    planRecorded: async (_ticket, _path, _recordId, _origin, _context, verify) => { started(); await barrier; verify(binding); return { reason: "ready", handoff: "unavailable" }; },
  }, { root, ...target, pid: process.pid, starttime: processStarttime(process.pid)!, cwd: root, pane: "main" }, env);
  const owner = spawn(process.execPath, ["-e", `const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)`], { stdio: ["ignore", "pipe", "ignore"] });
  let cliPid = 0;
  try {
    if (!server.listening) await once(server, "listening");
    await once(owner, "spawn");
    owner.stdout!.setEncoding("utf8");
    cliPid = Number(String((await once(owner.stdout!, "data"))[0]).trim());
    const pane = "save-death-pane";
    writeFileSync(join(runtimeDir, `${pane}.json`), JSON.stringify({ pid: owner.pid, cwd: root, mode: "plan", ticket: "YM-8" }));
    const worker = { sessionId: "save-death-session", pid: owner.pid!, starttime: processStarttime(owner.pid!)!, cwd: root, pane, parentPane: "main", mode: "plan", ticket: "YM-8", role: "coordinator" };
    const child = { ...scoutChild(worker, "YM-8", "death"), cwd: root };
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ticket: "YM-8", acceptanceId: 8, child }, worker, target, env)).state, "accepted");
    const cli = { ...worker, pid: cliPid, starttime: processStarttime(cliPid)! };
    assert.equal((await requestPlanControl(root, "prepare-plan-publication", { ticket: "YM-8", path: binding.path, contentHash: binding.contentHash }, cli, target, env)).state, "accepted");
    const completion = requestPlanControl(root, "plan-recorded", { ticket: "YM-8", path: binding.path, recordId: 10 }, cli, target, env);
    await callbackStarted;
    owner.kill("SIGKILL");
    await once(owner, "exit");
    release();
    const result = await completion;
    assert.equal(result.state, "refused");
    assert.match(result.reason ?? "", /owner or scout changed/);
  } finally {
    release?.();
    if (cliPid) try { process.kill(cliPid, "SIGKILL"); } catch {}
    if (owner.exitCode === null) owner.kill("SIGKILL");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("an admitted plan record wins a concurrent worker exit", { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "plan-record-exit-"));
  const runtime = mkdtempSync(join(tmpdir(), "plan-record-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const target = { sessionId: "main-session", runtimeId: "main-runtime" };
  const starttime = processStarttime(process.pid)!;
  const runtimeDir = socketDir(env, process.getuid!());
  mkdirSync(runtimeDir, { recursive: true });
  let finishes = 0;
  let records = 0;
  let releaseRecord!: () => void;
  let markRecordStarted!: () => void;
  const recordStarted = new Promise<void>((resolve) => { markRecordStarted = resolve; });
  const recordBarrier = new Promise<void>((resolve) => { releaseRecord = resolve; });
  const server = bindCoordinatorControl(root, {
    launch: async () => { throw new Error("unexpected launch"); },
    status: (requestId) => ({ requestId, state: "status" }),
    cancel: async () => {},
    planFinished: async () => { finishes += 1; },
    publishPlanScout: async () => ({ reason: "published", publication: "complete", target: "fixture", revision: "a".repeat(64) }),
    recordPlan: async (ticket, path, _origin, _context, _acceptance, verify) => {
      records += 1;
      markRecordStarted();
      await recordBarrier;
      verify({ ticket, path, contentHash: "c".repeat(64), scopeHash: "d".repeat(64), repositories: ["org/repo"] });
      return { reason: "recorded" };
    },
  }, { root, ...target, pid: process.pid, starttime, cwd: root, pane: "main" }, env);
  let child: ChildProcess | undefined;
  try {
    if (!server.listening) await once(server, "listening");
    const main = { sessionId: target.sessionId, pid: process.pid, starttime, cwd: root };
    const registered = await requestPlanControl(root, "register-plan", { ticket: "YM-2" }, main, target, env);
    assert.ok(registered.runId);
    assert.equal((await requestPlanControl(root, "bind-plan", { ticket: "YM-2", runId: registered.runId, pane: "plan" }, main, target, env)).state, "accepted");
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await once(child, "spawn");
    const worker = { sessionId: "plan-session", pid: child.pid!, starttime: processStarttime(child.pid!)!, cwd: root, pane: "plan", parentPane: "main", mode: "plan", ticket: "YM-2", role: "coordinator" };
    writeFileSync(join(runtimeDir, "plan.json"), JSON.stringify({ pid: child.pid, cwd: root, mode: "plan", ticket: "YM-2" }));
    assert.equal((await requestPlanControl(root, "plan-started", { ticket: "YM-2", runId: registered.runId }, worker, target, env)).state, "accepted");
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ticket: "YM-2", runId: registered.runId, acceptanceId: 1, child: { ...scoutChild(worker, "YM-2", "exit"), cwd: root } }, worker, target, env)).state, "accepted");
    const recording = requestPlanControl(root, "record-plan", { ticket: "YM-2", runId: registered.runId, path: "/plan.md" }, worker, target, env);
    await recordStarted;
    child.kill("SIGKILL");
    await once(child, "exit");
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
    releaseRecord();
    const reply = await recording;
    assert.equal(reply.state, "accepted", reply.reason ?? "record refused");
    assert.equal(reply.reason, "recorded");
    assert.equal(records, 1);
    assert.equal(finishes, 0);
    const replay = await requestPlanControl(root, "record-plan", { ticket: "YM-2", runId: registered.runId, path: "/plan.md" }, main, target, env);
    assert.equal(replay.state, "refused");
    assert.equal(records, 1);
  } finally {
    releaseRecord?.();
    if (child && child.exitCode === null) child.kill("SIGKILL");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});
