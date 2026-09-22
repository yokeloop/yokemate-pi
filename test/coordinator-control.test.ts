import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindCoordinatorControl, PlanRecorderFences, requestCoordinatorCancel, coordinatorSocketPath, processStarttime, requestCoordinator, requestCoordinatorMerge, requestPlanLaunch, requestPlanControl, requestReviewControl, requestReviewRecordWithStatus, requestShipFinalize, resolveCoordinatorParent } from "../src/coordinator-control.ts";
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

function writePane(env: NodeJS.ProcessEnv, pane: string, root: string, mode: string, ticket: string | null, sessionId: string, pid = process.pid, parentPane: string | null = null): void {
  writeFileSync(join(socketDir(env, process.getuid!()), `${pane}.json`), JSON.stringify({ pid, starttime: processStarttime(pid), cwd: root, mode, ticket, sessionId, parentPane }));
}

function rawControl(root: string, env: NodeJS.ProcessEnv, value: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(coordinatorSocketPath(root, env));
    let buffer = "";
    connection.on("connect", () => connection.write(JSON.stringify(value) + "\n"));
    connection.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      connection.end();
      resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
    });
    connection.on("error", reject);
  });
}
import { cancellationResult } from "../src/subagent-runs.ts";
test("logical recorder fences do not stop the conversational agent unless teardown upgrades them", () => {
  const fences = new PlanRecorderFences();
  fences.fence("logical", false);
  assert.equal(fences.active("logical"), true);
  assert.deepEqual(fences.consume("logical"), { fenced: true, stopAgent: false });
  fences.fence("teardown", false);
  fences.fence("teardown", true);
  assert.deepEqual(fences.consume("teardown"), { fenced: true, stopAgent: true });
  assert.deepEqual(fences.consume("teardown"), { fenced: false, stopAgent: false });
});

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
    writePane(env, "main", root, "main", null, "session");
    writePane(env, "plan", root, "plan", null, "plan-session", process.pid, "main");
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

test("coordinator origin provenance returns distinct refusals before launch", async () => {
  const root = mkdtempSync(join(tmpdir(), "coordinator-provenance-"));
  const runtime = mkdtempSync(join(tmpdir(), "coordinator-provenance-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const target = { sessionId: "main-session", runtimeId: "main-runtime" };
  const starttime = processStarttime(process.pid)!;
  mkdirSync(socketDir(env, process.getuid!()), { recursive: true });
  writePane(env, "main", root, "main", null, target.sessionId);
  let launches = 0;
  let foreignOwner: ChildProcess | undefined;
  const server = bindCoordinatorControl(root, {
    async launch() { launches++; return { runId: "unexpected" }; },
    status: (requestId) => ({ requestId, state: "status" }), cancel: async () => {},
  }, { root, ...target, pid: process.pid, starttime, cwd: root, pane: "main" }, env);
  const request = { mode: "do" as const, tickets: ["YM-1"] };
  const base = { sessionId: "pane-session", pid: process.pid, starttime, cwd: root, pane: "pane", parentPane: "main", mode: "plan", ticket: "YM-1", role: "coordinator" };
  const refusal = async (origin: typeof base, reason: string) => assert.equal((await requestCoordinator(root, request, origin, target, env)).reason, reason);
  try {
    if (!server.listening) await once(server, "listening");
    await refusal({ ...base, mode: "main" }, "invalid coordinator origin");
    await refusal({ ...base, cwd: join(root, "foreign") }, "origin root mismatch");
    await refusal({ ...base, starttime: "0" }, "origin process is stale");
    await refusal(base, "pane sidecar is missing");
    writeFileSync(join(socketDir(env, process.getuid!()), "pane.json"), "{");
    await refusal(base, "pane sidecar is invalid");
    writeFileSync(join(socketDir(env, process.getuid!()), "pane.json"), JSON.stringify({ pid: process.pid, starttime: "0", cwd: root, mode: "plan", ticket: "YM-1", sessionId: "pane-session", parentPane: "main" }));
    await refusal(base, "pane sidecar is stale");
    writeFileSync(join(socketDir(env, process.getuid!()), "pane.json"), JSON.stringify({ pid: process.pid, starttime, cwd: join(root, "foreign"), mode: "plan", ticket: "YM-1", sessionId: "pane-session", parentPane: "main" }));
    await refusal(base, "pane root mismatch");
    foreignOwner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await once(foreignOwner, "spawn");
    writePane(env, "pane", root, "plan", "YM-1", "pane-session", foreignOwner.pid!, "main");
    await refusal(base, "origin process is not descended from pane");
    foreignOwner.kill("SIGKILL");
    await once(foreignOwner, "exit");
    foreignOwner = undefined;
    writePane(env, "pane", root, "review", "YM-1", "pane-session", process.pid, "main");
    await refusal(base, "pane mode mismatch");
    writePane(env, "pane", root, "plan", "YM-2", "pane-session", process.pid, "main");
    await refusal(base, "pane ticket mismatch");
    writePane(env, "pane", root, "plan", "YM-1", "pane-session", process.pid, "unknown");
    await refusal({ ...base, parentPane: "unknown" }, "origin pane chain is not registered with this parent");
    assert.equal(launches, 0);
  } finally {
    if (foreignOwner && foreignOwner.exitCode === null) foreignOwner.kill("SIGKILL");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("coordinator cancellation keeps exact registered origin ownership and typed repeats", async () => {
  const root = mkdtempSync(join(tmpdir(), "coordinator-cancel-control-"));
  const runtime = mkdtempSync(join(tmpdir(), "coordinator-cancel-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const target = { sessionId: "session", runtimeId: "runtime" };
  const starttime = processStarttime(process.pid)!;
  const origin = { sessionId: target.sessionId, pid: process.pid, starttime, cwd: root };
  let calls = 0;
  let terminal = false;
  const server = bindCoordinatorControl(root, {
    async launch() { return { runId: "11111111-1111-4111-8111-111111111111" }; },
    status(requestId) { return { requestId, state: "status" }; },
    async cancel(runId) {
      calls++;
      if (terminal) return cancellationResult(runId, "coordinator", "already_terminal", true);
      terminal = true;
      return cancellationResult(runId, "coordinator", "cancelled", true);
    },
  }, { root, ...target, pid: process.pid, starttime, cwd: root }, env);
  try {
    if (!server.listening) await once(server, "listening");
    const launched = await requestCoordinator(root, { mode: "do", tickets: ["YM-1"] }, origin, target, env);
    assert.equal(launched.state, "accepted");
    const first = await requestCoordinatorCancel(root, launched.runId!, origin, target, env);
    assert.equal(first.state, "accepted");
    assert.equal(first.cancellation?.status, "cancelled");
    const repeat = await requestCoordinatorCancel(root, launched.runId!, origin, target, env);
    assert.equal(repeat.cancellation?.status, "already_terminal");
    const unknown = await requestCoordinatorCancel(root, "22222222-2222-4222-8222-222222222222", origin, target, env);
    assert.equal(unknown.state, "accepted");
    assert.equal(unknown.cancellation?.status, "unknown");
    for (const forged of [{ ...origin, sessionId: "foreign" }, { ...origin, starttime: "0" }]) {
      const refused = await requestCoordinatorCancel(root, launched.runId!, forged, target, env);
      assert.equal(refused.state, "refused");
    }
    const foreign = await requestCoordinatorCancel(root, launched.runId!, { ...origin, mode: "do", role: "coordinator" }, target, env);
    assert.equal(foreign.state, "accepted");
    assert.equal(foreign.cancellation?.status, "not_owned");
    assert.equal(calls, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("registered pane chains are immutable and revalidated after ancestor death", { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "coordinator-chain-"));
  const runtime = mkdtempSync(join(tmpdir(), "coordinator-chain-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const target = { sessionId: "main-session", runtimeId: "main-runtime" };
  mkdirSync(socketDir(env, process.getuid!()), { recursive: true });
  writePane(env, "main", root, "main", null, target.sessionId);
  let launches = 0;
  const server = bindCoordinatorControl(root, {
    async launch() { launches++; return { runId: "run" }; },
    status: (requestId) => ({ requestId, state: "status" }), cancel: async () => {},
  }, { root, ...target, pid: process.pid, starttime: processStarttime(process.pid)!, cwd: root, pane: "main" }, env);
  let owner: ChildProcess | undefined;
  let workerPid: number | undefined;
  try {
    if (!server.listening) await once(server, "listening");
    owner = spawn(process.execPath, ["-e", "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "ignore"] });
    await once(owner, "spawn");
    const [chunk] = await once(owner.stdout!, "data") as [Buffer];
    workerPid = Number(chunk.toString().trim());
    assert.ok(workerPid && processStarttime(workerPid));
    const ownerOrigin = { sessionId: "owner-session", pid: owner.pid!, starttime: processStarttime(owner.pid!)!, cwd: root, pane: "owner", parentPane: "main", mode: "plan", role: "coordinator" };
    writePane(env, "owner", root, "plan", null, "owner-session", owner.pid!, "main");
    assert.equal((await requestCoordinator(root, { mode: "do", tickets: ["YM-1"] }, ownerOrigin, target, env)).state, "accepted");
    const workerOrigin = { sessionId: "worker-session", pid: workerPid, starttime: processStarttime(workerPid)!, cwd: root, pane: "worker", parentPane: "owner", mode: "plan", role: "coordinator" };
    writePane(env, "worker", root, "plan", null, "worker-session", workerPid, "owner");
    const attach = await rawControl(root, env, { version: 1, operation: "attach-origin", requestId: "attach", origin: workerOrigin, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId });
    assert.equal(attach.state, "accepted");
    owner.kill("SIGKILL");
    await once(owner, "exit");
    const reused = await rawControl(root, env, { version: 1, operation: "launch", requestId: "launch", originId: attach.originId, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId, request: { mode: "do", tickets: ["YM-2"] } });
    assert.equal(reused.state, "refused");
    assert.equal(reused.reason, "origin pane chain is not registered with this parent");
    assert.equal(launches, 1);
  } finally {
    if (owner && owner.exitCode === null) owner.kill("SIGKILL");
    if (workerPid) try { process.kill(workerPid, "SIGKILL"); } catch {}
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("coordinator control correlates metadata and deduplicates in-flight launch requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "coordinator-idempotent-"));
  const runtime = mkdtempSync(join(tmpdir(), "coordinator-idempotent-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const target = { sessionId: "session", runtimeId: "runtime" };
  const origin = { sessionId: "session", pid: process.pid, starttime: processStarttime(process.pid)!, cwd: root };
  const dispatches: unknown[] = [];
  let launches = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const server = bindCoordinatorControl(root, {
    async launch(_request, _origin, dispatch) { launches++; dispatches.push(dispatch); await held; return { runId: "run-1" }; },
    status: (requestId) => ({ requestId, state: "status" }),
    async cancel() {},
  }, { root, ...target, pid: process.pid, starttime: origin.starttime, cwd: root }, env);
  try {
    if (!server.listening) await once(server, "listening");
    const dispatch = { requestId: "request-1", toolCallId: "tool-1" };
    const first = requestCoordinator(root, { mode: "do", tickets: ["YM-1"] }, origin, target, env, dispatch);
    const second = requestCoordinator(root, { mode: "do", tickets: ["YM-1"] }, origin, target, env, dispatch);
    while (launches === 0) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(launches, 1);
    const collision = await requestCoordinator(root, { mode: "do", tickets: ["YM-2"] }, origin, target, env, dispatch);
    assert.equal(collision.state, "refused");
    assert.match(collision.reason ?? "", /collision/);
    release();
    assert.deepEqual(await first, await second);
    assert.deepEqual(dispatches, [dispatch]);
    const replay = await requestCoordinator(root, { mode: "do", tickets: ["YM-1"] }, origin, target, env, dispatch);
    assert.equal(replay.state, "accepted");
    assert.equal(launches, 1);
  } finally {
    release();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("coordinator parent resolver distinguishes sidecar failures", () => {
  const root = mkdtempSync(join(tmpdir(), "coordinator-parent-"));
  const runtime = mkdtempSync(join(tmpdir(), "coordinator-parent-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const sidecar = `${coordinatorSocketPath(root, env)}.json`;
  mkdirSync(join(socketDir(env, process.getuid!()), "coordinators"), { recursive: true });
  try {
    assert.throws(() => resolveCoordinatorParent(root, env), /coordinator parent sidecar is missing/);
    writeFileSync(sidecar, "{");
    assert.throws(() => resolveCoordinatorParent(root, env), /coordinator parent sidecar is invalid/);
    writeFileSync(sidecar, JSON.stringify({ root, sessionId: "session", runtimeId: "runtime", pid: process.pid, starttime: "0", cwd: root }));
    assert.throws(() => resolveCoordinatorParent(root, env), /coordinator parent is stale/);
    writeFileSync(sidecar, JSON.stringify({ root: join(root, "foreign"), sessionId: "session", runtimeId: "runtime", pid: process.pid, starttime: processStarttime(process.pid), cwd: root }));
    assert.throws(() => resolveCoordinatorParent(root, env), /coordinator parent root mismatch/);
  } finally {
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
  writePane(env, "main-pane", root, "main", null, target.sessionId);
  writePane(env, "plan-pane", root, "plan", "YM-1", "plan-session", process.pid, "main-pane");
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
    assert.equal(stampedMain.reason, "invalid coordinator origin");
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
    writePane(env, "main", root, "main", null, target.sessionId);
    writePane(env, "problem", root, "plan", null, "problem-session", process.pid, "main");
    const worker = { ...main, sessionId: "problem-session", mode: "plan", role: "coordinator", pane: "problem", parentPane: "main" };
    const prepare = (ticket: string) => requestPlanControl(root, "prepare-plan-publication", { ticket, path: "/plan.md", contentHash: "c".repeat(64) }, worker, target, env);
    assert.equal((await prepare("YM-1")).state, "refused");
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ticket: "YM-1", acceptanceId: 1, child: { ...scoutChild(worker, "YM-1", "problem"), cwd: root } }, worker, target, env)).state, "accepted");
    descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => { descendant!.once("spawn", resolve); descendant!.once("error", reject); });
    const descendantOrigin = { ...worker, pid: descendant.pid!, starttime: processStarttime(descendant.pid!)! };
    assert.equal((await requestPlanControl(root, "prepare-plan-publication", { ticket: "YM-1", path: "/plan.md", contentHash: "c".repeat(64) }, descendantOrigin, target, env)).state, "accepted");
    assert.equal((await requestPlanControl(root, "reject-plan-scout", { ticket: "YM-1", scoutSequence: 2, child: { ...scoutChild(worker, "YM-1", "problem"), cwd: root } }, worker, target, env)).state, "accepted");
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
    writePane(env, "main-pane", root, "main", null, target.sessionId);
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

test("review control separates launcher, worker input and descendant record authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-control-"));
  const runtime = mkdtempSync(join(tmpdir(), "review-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const target = { sessionId: "main-session", runtimeId: "main-runtime" };
  const main = { sessionId: target.sessionId, pid: process.pid, starttime: processStarttime(process.pid)!, cwd: root, pane: "main" };
  const calls: string[] = [];
  let descendant: ChildProcess | undefined;
  const server = bindCoordinatorControl(root, {
    launch: async () => { throw new Error("unexpected launch"); }, status: (requestId) => ({ requestId, state: "status" }), cancel: async () => {},
    reviewStarted: async () => { calls.push("started"); },
    reviewInput: async (_ticket, _runId, raw) => { calls.push(`input:${raw}`); return { serial: 1, revision: 0, inputHash: "hash" }; },
    reviewExtraction: async (_ticket, _runId, extraction) => { calls.push(`extract:${extraction.kind}`); },
    reviewRecord: async (_ticket, _runId, plan) => { calls.push(`record:${plan}`); return { state: "started", recorded: true, runId: "do-run" }; },
    reviewEnded: async () => { calls.push("ended"); },
  }, { root, ...target, pid: process.pid, starttime: main.starttime, cwd: root, pane: "main" }, env);
  try {
    if (!server.listening) await once(server, "listening");
    const runtimeDir = socketDir(env, process.getuid!());
    mkdirSync(runtimeDir, { recursive: true });
    writePane(env, "main", root, "main", null, target.sessionId);
    writePane(env, "review", root, "review", "YM-1", "review-session", process.pid, "main");
    const registered = await requestReviewControl(root, "register-review", { ticket: "YM-1", workerRuntimeId: "review-runtime" }, main, target, env);
    assert.equal(registered.state, "accepted");
    const runId = registered.runId!;
    assert.equal((await requestReviewControl(root, "bind-review", { ticket: "YM-1", runId, pane: "review", surface: "tab", tabId: "tab-review" }, main, target, env)).state, "accepted");
    const worker = { ...main, sessionId: "review-session", runtimeId: "review-runtime", mode: "review", ticket: "YM-1", role: "coordinator", pane: "review", parentPane: "main" };
    const wrongRuntime = { ...worker, runtimeId: "descendant-first" };
    assert.equal((await requestReviewControl(root, "review-started", { ticket: "YM-1", runId }, wrongRuntime, target, env)).state, "refused");
    descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await once(descendant, "spawn");
    const cli = { ...worker, pid: descendant.pid!, starttime: processStarttime(descendant.pid!)! };
    assert.equal((await requestReviewControl(root, "review-started", { ticket: "YM-1", runId }, cli, target, env)).state, "refused");
    assert.equal((await requestReviewControl(root, "review-started", { ticket: "YM-1", runId }, worker, target, env)).state, "accepted");
    const input = await requestReviewControl(root, "review-input", { ticket: "YM-1", runId, raw: "на доработку" }, worker, target, env);
    assert.ok(input.generation && typeof input.generation === "object");
    assert.equal(input.generation.serial, 1);
    assert.equal((await requestReviewControl(root, "review-extraction", { ticket: "YM-1", runId, generation: input.generation, extraction: { kind: "rework", evidence: [{ start: 0, end: 12, text: "на доработку" }] } }, worker, target, env)).state, "accepted");
    assert.equal((await requestReviewControl(root, "review-record", { ticket: "YM-1", runId, path: "/plan.md" }, cli, target, env)).rework?.runId, "do-run");
    assert.equal((await requestReviewControl(root, "review-input", { ticket: "YM-1", runId, raw: "foreign" }, cli, target, env)).state, "refused");
    assert.equal((await requestReviewControl(root, "review-ended", { ticket: "YM-1", runId, reason: "shutdown" }, worker, target, env)).state, "accepted");
    assert.deepEqual(calls, ["started", "input:на доработку", "extract:rework", "record:/plan.md", "ended"]);
  } finally {
    if (descendant && descendant.exitCode === null) { descendant.kill("SIGKILL"); descendant.unref(); }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("review record recovers a retained outcome after the first control reply times out", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-status-control-"));
  const runtime = mkdtempSync(join(tmpdir(), "review-status-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const target = { sessionId: "main-session", runtimeId: "main-runtime" };
  const main = { sessionId: target.sessionId, pid: process.pid, starttime: processStarttime(process.pid)!, cwd: root, pane: "main" };
  const retained = { state: "started" as const, recorded: true, runId: "do-run" };
  let outcome: typeof retained | undefined;
  const server = bindCoordinatorControl(root, {
    launch: async () => { throw new Error("unexpected launch"); }, status: (requestId) => ({ requestId, state: "status" }), cancel: async () => {},
    reviewRecord: async () => { await new Promise((resolve) => setTimeout(resolve, 40)); outcome = retained; return retained; },
    reviewStatus: () => outcome,
  }, { root, ...target, pid: process.pid, starttime: main.starttime, cwd: root, pane: "main" }, env);
  try {
    if (!server.listening) await once(server, "listening");
    const runtimeDir = socketDir(env, process.getuid!());
    mkdirSync(runtimeDir, { recursive: true });
    writePane(env, "main", root, "main", null, target.sessionId);
    writePane(env, "review", root, "review", "YM-1", "review-session", process.pid, "main");
    const registered = await requestReviewControl(root, "register-review", { ticket: "YM-1", workerRuntimeId: "review-runtime" }, main, target, env);
    const runId = registered.runId!;
    await requestReviewControl(root, "bind-review", { ticket: "YM-1", runId, pane: "review", surface: "split" }, main, target, env);
    const worker = { ...main, sessionId: "review-session", runtimeId: "review-runtime", mode: "review", ticket: "YM-1", role: "coordinator", pane: "review", parentPane: "main" };
    await requestReviewControl(root, "review-started", { ticket: "YM-1", runId }, worker, target, env);
    const reply = await requestReviewRecordWithStatus(root, { ticket: "YM-1", runId, path: "/plan.md" }, worker, target, env, { recordTimeoutMs: 5, statusTimeoutMs: 500, pollMs: 5 });
    assert.equal(reply.state, "accepted");
    assert.deepEqual(reply.rework, retained);
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
    writePane(env, "main", root, "main", null, target.sessionId);
    writePane(env, "plan", root, "plan", "YM-1", "plan-session", process.pid, "main");
    const handoff = { ...payload, path: binding.path, contentHash: binding.contentHash, recordId: 3 };
    assert.equal((await requestPlanControl(root, "plan-recorded", handoff, worker, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "bind-plan", { ...payload, pane: "plan" }, main, target, env)).state, "accepted");
    const { role: _role, ...missingRole } = worker;
    for (const invalid of [missingRole, { ...worker, role: "executor" }, { ...worker, role: "unknown" }, { ...worker, sessionId: "foreign" }, { ...worker, starttime: "0" }])
      assert.equal((await requestPlanControl(root, "plan-started", payload, invalid, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "plan-started", { ...payload, runId: "foreign" }, worker, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "plan-started", { ...payload, ticket: "YM-2" }, worker, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "plan-started", payload, { ...worker, pid: 1, starttime: processStarttime(1)! }, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "plan-started", payload, worker, target, env)).state, "accepted");
    const recordWithoutScout = await requestPlanControl(root, "record-plan", { ...payload, path: binding.path, contentHash: binding.contentHash }, worker, target, env);
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
    const uncorrelatedRejection = await requestPlanControl(root, "reject-plan-scout", { ...payload, scoutSequence: 1, child: { ...scoutChild(worker, "YM-1", "late-invalid"), cwd: root } }, worker, target, env);
    assert.equal(uncorrelatedRejection.state, "accepted");
    assert.equal(uncorrelatedRejection.reason, "uncorrelated scout rejection ignored");
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


test("every plan operation requires the registered role, run, ticket, session and live process", { timeout: 20000 }, async () => {
  const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const foreign = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await Promise.all([once(owner, "spawn"), once(foreign, "spawn")]);
  const ownerStarttime = processStarttime(owner.pid!)!;
  const foreignStarttime = processStarttime(foreign.pid!)!;
  const operations = ["publish-plan-scout", "reject-plan-scout", "prepare-plan-publication", "plan-recorded", "record-plan", "plan-finished"] as const;
  try {
    for (const operation of operations) {
      const root = mkdtempSync(join(tmpdir(), `plan-operation-${operation}-`));
      const runtime = mkdtempSync(join(tmpdir(), "plan-operation-runtime-"));
      const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
      const target = { sessionId: "main-session", runtimeId: "main-runtime" };
      const binding = recordedPlan(root, "YM-1");
      const calls = { publish: 0, prepare: 0, recorded: 0, record: 0, finish: 0 };
      mkdirSync(socketDir(env, process.getuid!()), { recursive: true });
      writePane(env, "main", root, "main", null, target.sessionId);
      writePane(env, "plan", root, "plan", "YM-1", "plan-session", owner.pid!, "main");
      const server = bindCoordinatorControl(root, {
        launch: async () => { throw new Error("unexpected launch"); },
        status: (requestId) => ({ requestId, state: "status" }), cancel: async () => {},
        publishPlanScout: async () => { calls.publish++; return { reason: "published", publication: "complete", target: "fixture", revision: "a".repeat(64) }; },
        preparePlanPublication: async (_ticket, _path, _hash, acceptanceId) => { calls.prepare++; return { reason: "prepared", recordId: 7, snapshotPath: "/snapshot", scoutAcceptance: acceptanceId, revision: binding.contentHash, binding }; },
        planRecorded: async (_ticket, _path, _id, _origin, _context, verify) => { calls.recorded++; verify(binding); return { reason: "recorded" }; },
        recordPlan: async (_ticket, _path, _origin, _context, _acceptance, verify) => { calls.record++; verify(binding); return { reason: "recorded" }; },
        planFinished: async () => { calls.finish++; },
      }, { root, ...target, pid: process.pid, starttime: processStarttime(process.pid)!, cwd: root, pane: "main" }, env);
      try {
        if (!server.listening) await once(server, "listening");
        const main = { sessionId: target.sessionId, pid: process.pid, starttime: processStarttime(process.pid)!, cwd: root };
        const registered = await requestPlanControl(root, "register-plan", { ticket: "YM-1" }, main, target, env);
        assert.ok(registered.runId);
        const runId = registered.runId!;
        assert.equal((await requestPlanControl(root, "bind-plan", { ticket: "YM-1", runId, pane: "plan" }, main, target, env)).state, "accepted");
        const worker = { sessionId: "plan-session", pid: owner.pid!, starttime: ownerStarttime, cwd: root, pane: "plan", parentPane: "main", mode: "plan", ticket: "YM-1", role: "coordinator" };
        assert.equal((await requestPlanControl(root, "plan-started", { ticket: "YM-1", runId }, worker, target, env)).state, "accepted");
        if (["reject-plan-scout", "prepare-plan-publication", "record-plan", "plan-recorded"].includes(operation))
          assert.equal((await requestPlanControl(root, "publish-plan-scout", { ticket: "YM-1", runId, acceptanceId: 1, child: { ...scoutChild(worker, "YM-1", "one"), cwd: root } }, worker, target, env)).state, "accepted");
        if (operation === "plan-recorded") assert.equal((await requestPlanControl(root, "prepare-plan-publication", { ticket: "YM-1", runId, path: binding.path, contentHash: binding.contentHash }, worker, target, env)).state, "accepted");
        const payload = operation === "publish-plan-scout" ? { ticket: "YM-1", runId, acceptanceId: 2, child: { ...scoutChild(worker, "YM-1", "two"), cwd: root } }
          : operation === "reject-plan-scout" ? { ticket: "YM-1", runId, acceptanceId: 1, child: { ...scoutChild(worker, "YM-1", "one"), cwd: root } }
          : operation === "prepare-plan-publication" ? { ticket: "YM-1", runId, path: binding.path, contentHash: binding.contentHash }
          : operation === "plan-recorded" ? { ticket: "YM-1", runId, path: binding.path, contentHash: binding.contentHash, recordId: 7 }
          : operation === "record-plan" ? { ticket: "YM-1", runId, path: binding.path, contentHash: binding.contentHash }
          : { ticket: "YM-1", runId, outcome: "blocked" as const, reason: "fixture" };
        const { role: _role, ...missingRole } = worker;
        const invalid = [
          { origin: missingRole, payload },
          { origin: { ...worker, role: "executor" }, payload },
          { origin: { ...worker, role: "unknown" }, payload },
          { origin: { ...worker, sessionId: "foreign-session" }, payload },
          { origin: { ...worker, pid: foreign.pid!, starttime: foreignStarttime }, payload },
          { origin: { ...worker, starttime: "0" }, payload },
          { origin: worker, payload: { ...payload, runId: "foreign-run" } },
          { origin: worker, payload: { ...payload, ticket: "YM-2" } },
        ];
        for (const variant of invalid) {
          const before = structuredClone(calls);
          const refused = await requestPlanControl(root, operation, variant.payload, variant.origin, target, env);
          assert.equal(refused.state, "refused", `${operation}: ${refused.reason}`);
          assert.deepEqual(calls, before, operation);
        }
        if (operation === "reject-plan-scout") {
          assert.equal((await requestPlanControl(root, "prepare-plan-publication", { ticket: "YM-1", runId, path: binding.path, contentHash: binding.contentHash }, worker, target, env)).state, "accepted");
        }
        assert.equal((await requestPlanControl(root, operation, payload, worker, target, env)).state, "accepted", operation);
        if (operation === "reject-plan-scout") {
          assert.equal((await requestPlanControl(root, "prepare-plan-publication", { ticket: "YM-1", runId, path: binding.path, contentHash: binding.contentHash }, worker, target, env)).state, "refused");
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
        rmSync(runtime, { recursive: true, force: true });
      }
    }
  } finally {
    owner.kill("SIGKILL");
    foreign.kill("SIGKILL");
    await Promise.all([once(owner, "exit"), once(foreign, "exit")]);
  }
});

test("logical plan finish fences publication record and handoff before parent callbacks complete", async () => {
  const root = mkdtempSync(join(tmpdir(), "plan-finish-fence-"));
  const runtime = mkdtempSync(join(tmpdir(), "plan-finish-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const target = { sessionId: "main-session", runtimeId: "main-runtime" };
  const binding = recordedPlan(root, "YM-1");
  const starttime = processStarttime(process.pid)!;
  const main = { sessionId: target.sessionId, pid: process.pid, starttime, cwd: root };
  const runtimeDir = socketDir(env, process.getuid!());
  mkdirSync(runtimeDir, { recursive: true });
  writePane(env, "main", root, "main", null, target.sessionId);
  writePane(env, "plan", root, "plan", "YM-1", "plan-session", process.pid, "main");
  let releasePublication!: () => void;
  let publicationStarted!: () => void;
  const started = new Promise<void>((resolve) => { publicationStarted = resolve; });
  let finishCalls = 0;
  const server = bindCoordinatorControl(root, {
    launch: async () => { throw new Error("unexpected launch"); },
    status: (requestId) => ({ requestId, state: "status" }),
    cancel: async () => {},
    publishPlanScout: async () => {
      publicationStarted();
      await new Promise<void>((resolve) => { releasePublication = resolve; });
      return { reason: "published", publication: "complete", target: "fixture", revision: "a".repeat(64) };
    },
    planFinished: async () => { finishCalls++; },
    preparePlanPublication: async () => ({ reason: "prepared", recordId: 1, snapshotPath: "/snapshot", scoutAcceptance: 1, revision: binding.contentHash, binding }),
    recordPlan: async () => ({ reason: "recorded" }),
    planRecorded: async () => ({ reason: "recorded" }),
  }, { root, ...target, pid: process.pid, starttime, cwd: root, pane: "main" }, env);
  try {
    if (!server.listening) await once(server, "listening");
    const register = await requestPlanControl(root, "register-plan", { ticket: "YM-1" }, main, target, env);
    assert.ok(register.runId);
    assert.equal((await requestPlanControl(root, "bind-plan", { ticket: "YM-1", runId: register.runId, pane: "plan" }, main, target, env)).state, "accepted");
    const worker = { ...main, sessionId: "plan-session", mode: "plan", ticket: "YM-1", role: "coordinator", pane: "plan", parentPane: "main" };
    assert.equal((await requestPlanControl(root, "plan-started", { ticket: "YM-1", runId: register.runId }, worker, target, env)).state, "accepted");
    const publication = requestPlanControl(root, "publish-plan-scout", { ticket: "YM-1", runId: register.runId, acceptanceId: 1, child: { ...scoutChild(worker, "YM-1", "one"), cwd: root } }, worker, target, env);
    await started;
    const finished = await requestPlanControl(root, "plan-finished", { ticket: "YM-1", runId: register.runId, outcome: "cancelled", reason: "engineer stopped" }, worker, target, env);
    assert.equal(finished.state, "accepted");
    assert.equal(finishCalls, 1);
    releasePublication();
    const late = await publication;
    assert.equal(late.artifactAcceptance, "superseded");
    for (const [operation, payload] of [
      ["publish-plan-scout", { acceptanceId: 2 }],
      ["prepare-plan-publication", { path: binding.path, contentHash: binding.contentHash }],
      ["record-plan", { path: binding.path }],
      ["plan-recorded", { path: binding.path, recordId: 1 }],
    ] as const) {
      const reply = await requestPlanControl(root, operation, { ticket: "YM-1", runId: register.runId, ...payload }, worker, target, env);
      assert.equal(reply.state, "refused", operation);
      assert.match(reply.reason ?? "", /no longer active/, operation);
    }
  } finally {
    releasePublication?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("logical plan finish supersedes an admitted recorder before its parent commit returns", async () => {
  const root = mkdtempSync(join(tmpdir(), "plan-record-stop-"));
  const runtime = mkdtempSync(join(tmpdir(), "plan-record-stop-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const target = { sessionId: "main-session", runtimeId: "main-runtime" };
  const binding = recordedPlan(root, "YM-1");
  const starttime = processStarttime(process.pid)!;
  const main = { sessionId: target.sessionId, pid: process.pid, starttime, cwd: root };
  const runtimeDir = socketDir(env, process.getuid!());
  mkdirSync(runtimeDir, { recursive: true });
  writePane(env, "main", root, "main", null, target.sessionId);
  writePane(env, "plan", root, "plan", "YM-1", "plan-session", process.pid, "main");
  let recordStarted!: () => void;
  let releaseRecord!: () => void;
  const started = new Promise<void>((resolve) => { recordStarted = resolve; });
  let finishCalls = 0;
  const server = bindCoordinatorControl(root, {
    launch: async () => { throw new Error("unexpected launch"); },
    status: (requestId) => ({ requestId, state: "status" }),
    cancel: async () => {},
    publishPlanScout: async () => ({ reason: "published", publication: "complete", target: "fixture", revision: "a".repeat(64) }),
    planFinished: async () => { finishCalls++; },
    recordPlan: async () => {
      recordStarted();
      await new Promise<void>((resolve) => { releaseRecord = resolve; });
      return { reason: "recorded" };
    },
  }, { root, ...target, pid: process.pid, starttime, cwd: root, pane: "main" }, env);
  try {
    if (!server.listening) await once(server, "listening");
    const register = await requestPlanControl(root, "register-plan", { ticket: "YM-1" }, main, target, env);
    assert.ok(register.runId);
    assert.equal((await requestPlanControl(root, "bind-plan", { ticket: "YM-1", runId: register.runId, pane: "plan" }, main, target, env)).state, "accepted");
    const worker = { ...main, sessionId: "plan-session", mode: "plan", ticket: "YM-1", role: "coordinator", pane: "plan", parentPane: "main" };
    assert.equal((await requestPlanControl(root, "plan-started", { ticket: "YM-1", runId: register.runId }, worker, target, env)).state, "accepted");
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ticket: "YM-1", runId: register.runId, acceptanceId: 1, child: { ...scoutChild(worker, "YM-1", "one"), cwd: root } }, worker, target, env)).artifactAcceptance, "accepted");
    const record = requestPlanControl(root, "record-plan", { ticket: "YM-1", runId: register.runId, path: binding.path, contentHash: binding.contentHash }, worker, target, env);
    await started;
    assert.equal((await requestPlanControl(root, "plan-finished", { ticket: "YM-1", runId: register.runId, outcome: "cancelled", reason: "engineer stopped" }, worker, target, env)).state, "accepted");
    assert.equal(finishCalls, 1);
    releaseRecord();
    const superseded = await record;
    assert.equal(superseded.state, "refused");
    assert.match(superseded.reason ?? "", /superseded|no longer active/);
  } finally {
    releaseRecord?.();
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
    writePane(env, "main", root, "main", null, target.sessionId);
    writePane(env, "plan", root, "plan", "YM-1", "plan-session", child.pid!, "main");
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

test("a restarted control server refuses an unbound main replay of an old save-only record", async () => {
  const root = mkdtempSync(join(tmpdir(), "save-only-restart-control-"));
  const binding = recordedPlan(root, "YM-6");
  const runtime = mkdtempSync(join(tmpdir(), "save-only-restart-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const target = { sessionId: "main-session", runtimeId: "main-runtime" };
  const starttime = processStarttime(process.pid)!;
  const runtimeDir = socketDir(env, process.getuid!());
  mkdirSync(runtimeDir, { recursive: true });
  writePane(env, "main", root, "main", null, target.sessionId);
  writePane(env, "save-restart-pane", root, "plan", "YM-6", "save-restart-session", process.pid, "main");
  const worker = { sessionId: "save-restart-session", pid: process.pid, starttime, cwd: root, pane: "save-restart-pane", parentPane: "main", mode: "plan", ticket: "YM-6", role: "coordinator" };
  const identity = { root, ...target, pid: process.pid, starttime, cwd: root, pane: "main" };
  let completions = 0;
  const first = bindCoordinatorControl(root, {
    launch: async () => { throw new Error("unexpected launch"); }, status: (requestId) => ({ requestId, state: "status" }), cancel: async () => {},
    publishPlanScout: async () => ({ reason: "published", publication: "complete", target: "fixture", revision: binding.contentHash }),
    preparePlanPublication: async (_ticket, _path, _hash, acceptanceId) => ({ reason: "prepared", recordId: 77, snapshotPath: "/snapshot", scoutAcceptance: acceptanceId, revision: binding.contentHash, binding }),
    planRecorded: async () => { completions++; return { reason: "unexpected", handoff: "started" }; },
  }, identity, env);
  try {
    if (!first.listening) await once(first, "listening");
    const child = { ...scoutChild(worker, "YM-6", "restart"), cwd: root };
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ticket: "YM-6", acceptanceId: 6, child }, worker, target, env)).state, "accepted");
    assert.equal((await requestPlanControl(root, "prepare-plan-publication", { ticket: "YM-6", path: binding.path, contentHash: binding.contentHash }, worker, target, env)).recordId, 77);
    const main = { sessionId: target.sessionId, pid: process.pid, starttime, cwd: root };
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ticket: "YM-6", acceptanceId: 8, child: { ...scoutChild(main, "YM-6", "main-prepared"), cwd: root } }, main, target, env)).state, "accepted");
    assert.equal((await requestPlanControl(root, "prepare-plan-publication", { ticket: "YM-6", path: binding.path, contentHash: binding.contentHash }, main, target, env)).recordId, 77);
    const wrongPreparedId = await requestPlanControl(root, "plan-recorded", { ticket: "YM-6", path: binding.path, contentHash: binding.contentHash, recordId: 78 }, main, target, env);
    assert.equal(wrongPreparedId.state, "refused");
    assert.match(wrongPreparedId.reason ?? "", /prepared plan record binding changed/);
    assert.equal(completions, 0);
    await new Promise<void>((resolve) => first.close(() => resolve()));
    const restarted = bindCoordinatorControl(root, {
      launch: async () => { throw new Error("unexpected launch"); }, status: (requestId) => ({ requestId, state: "status" }), cancel: async () => {},
      planRecorded: async () => { completions++; return { reason: "unexpected", handoff: "started" }; },
    }, identity, env);
    try {
      if (!restarted.listening) await once(restarted, "listening");
      const replay = await requestPlanControl(root, "plan-recorded", { ticket: "YM-6", path: binding.path, contentHash: binding.contentHash, recordId: 77 }, { sessionId: target.sessionId, pid: process.pid, starttime, cwd: root }, target, env);
      assert.equal(replay.state, "refused");
      assert.match(replay.reason ?? "", /exact prepared or completed record/);
      assert.equal(completions, 0);
    } finally { await new Promise<void>((resolve) => restarted.close(() => resolve())); }
  } finally {
    if (first.listening) await new Promise<void>((resolve) => first.close(() => resolve()));
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
  let releaseReverseCompletion!: () => void;
  let markReverseCompletionStarted!: () => void;
  const completionStarted = new Promise<void>((resolve) => { markCompletionStarted = resolve; });
  const completionBarrier = new Promise<void>((resolve) => { releaseCompletion = resolve; });
  const reverseCompletionStarted = new Promise<void>((resolve) => { markReverseCompletionStarted = resolve; });
  const reverseCompletionBarrier = new Promise<void>((resolve) => { releaseReverseCompletion = resolve; });
  const server = bindCoordinatorControl(root, {
    launch: async () => { throw new Error("unexpected launch"); },
    status: (requestId) => ({ requestId, state: "status" }), cancel: async () => {},
    publishPlanScout: async (_ticket, acceptanceId, child) => {
      if (acceptanceId === 3 || acceptanceId === 5) throw new Error("artifact provenance refused");
      publications++;
      assert.match(child.runId, /^scout-save/);
      return { reason: "target_unavailable", publication: "pending", target: "unresolved/YM-7", revision: "a".repeat(64) };
    },
    preparePlanPublication: async (_ticket, _path, _hash, acceptanceId, _origin, context) => { preparations++; assert.equal(context.kind, "save-only"); return { reason: "prepared", recordId: preparations > 2 ? 10 : 9, snapshotPath: "/snapshot", scoutAcceptance: acceptanceId, revision: binding.contentHash, binding }; },
    planRecorded: async (_ticket, _path, recordId, _origin, context, verify) => { completions++; assert.ok(recordId === 9 || recordId === 10); assert.equal(context.kind, "save-only"); if (recordId === 9) { markCompletionStarted(); await completionBarrier; } else { markReverseCompletionStarted(); await reverseCompletionBarrier; } verify(binding); const complete = completions >= 3; return { reason: "plan-only; ready for /do; automatic handoff unavailable", handoff: "unavailable", publications: [{ kind: "plan", state: complete ? "complete" : "pending", target: "fixture", revision: binding.contentHash, ...(complete ? {} : { error: "unavailable" as const }) }] }; },
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
    writePane(env, "main", root, "main", null, target.sessionId);
    writePane(env, pane, root, "plan", "YM-7", "save-session", owner.pid!, "main");
    const worker = { sessionId: "save-session", pid: owner.pid!, starttime: processStarttime(owner.pid!)!, cwd: root, pane, parentPane: "main", mode: "plan", ticket: "YM-7", role: "coordinator" };
    const child = { ...scoutChild(worker, "YM-7", "save"), runId: "scout-save", cwd: root };
    const cli = { ...worker, pid: cliPid, starttime: processStarttime(cliPid)! };
    const unknownPane = "save-unknown-parent";
    writePane(env, unknownPane, root, "plan", "YM-7", target.sessionId, owner.pid!, "missing");
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
    const wrongPreparedHash = await requestPlanControl(root, "plan-recorded", { ticket: "YM-7", path: binding.path, contentHash: "0".repeat(64), recordId: 9 }, cli, target, env);
    assert.equal(wrongPreparedHash.state, "refused");
    assert.equal(completions, 0);
    const recording = requestPlanControl(root, "plan-recorded", { ticket: "YM-7", path: binding.path, contentHash: binding.contentHash, recordId: 9 }, cli, target, env);
    await completionStarted;
    const wrongInflightHash = await requestPlanControl(root, "plan-recorded", { ticket: "YM-7", path: binding.path, contentHash: "0".repeat(64), recordId: 9 }, cli, target, env);
    assert.equal(wrongInflightHash.state, "refused");
    const mainReconciliation = requestPlanControl(root, "plan-recorded", { ticket: "YM-7", path: binding.path, contentHash: binding.contentHash, recordId: 9 }, { sessionId: target.sessionId, pid: process.pid, starttime: processStarttime(process.pid)!, cwd: root }, target, env);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    releaseCompletion();
    const [recorded, reconciled] = await Promise.all([recording, mainReconciliation]);
    assert.equal(recorded.state, "accepted", recorded.reason ?? "save-only completion refused");
    assert.equal(recorded.handoff, "unavailable");
    assert.equal(reconciled.state, "accepted", reconciled.reason ?? "in-flight reconciliation refused");
    assert.equal(reconciled.handoff, "unavailable");
    const repeat = await requestPlanControl(root, "plan-recorded", { ticket: "YM-7", path: binding.path, contentHash: binding.contentHash, recordId: 9 }, cli, target, env);
    assert.equal(repeat.state, "accepted", repeat.reason ?? "save-only repeat refused");
    assert.equal(completions, 1);
    assert.equal(publications, 2);
    assert.equal(preparations, 2);
    const reverseChild = { ...scoutChild(worker, "YM-7", "save-reverse"), ownerRunId: child.ownerRunId, runId: "scout-save-reverse", cwd: root };
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ticket: "YM-7", acceptanceId: 7, child: reverseChild }, worker, target, env)).state, "accepted");
    assert.equal((await requestPlanControl(root, "prepare-plan-publication", { ticket: "YM-7", path: binding.path, contentHash: binding.contentHash }, cli, target, env)).recordId, 10);
    const mainFirst = requestPlanControl(root, "plan-recorded", { ticket: "YM-7", path: binding.path, contentHash: binding.contentHash, recordId: 10 }, { sessionId: target.sessionId, pid: process.pid, starttime: processStarttime(process.pid)!, cwd: root }, target, env);
    await reverseCompletionStarted;
    const saveOnlySecond = requestPlanControl(root, "plan-recorded", { ticket: "YM-7", path: binding.path, contentHash: binding.contentHash, recordId: 10 }, cli, target, env);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    releaseReverseCompletion();
    const [mainFirstResult, saveOnlySecondResult] = await Promise.all([mainFirst, saveOnlySecond]);
    assert.equal(mainFirstResult.handoff, "unavailable");
    assert.equal(saveOnlySecondResult.handoff, "unavailable");
    assert.equal(completions, 2);
    const publicationReconciliation = await requestPlanControl(root, "plan-recorded", { ticket: "YM-7", path: binding.path, contentHash: binding.contentHash, recordId: 10 }, { sessionId: target.sessionId, pid: process.pid, starttime: processStarttime(process.pid)!, cwd: root }, target, env);
    assert.equal(publicationReconciliation.handoff, "unavailable");
    assert.equal(publicationReconciliation.publications?.[0]?.state, "complete");
    assert.equal(completions, 3);
    writeFileSync(binding.path, readFileSync(binding.path, "utf8").replace("Verify completion.", "Verify changed completion."));
    const changed = await requestPlanControl(root, "plan-recorded", { ticket: "YM-7", path: binding.path, contentHash: binding.contentHash, recordId: 10 }, cli, target, env);
    assert.equal(changed.state, "refused");
    assert.match(changed.reason ?? "", /retry binding changed/);
    const foreign = await requestPlanControl(root, "plan-recorded", { ticket: "YM-7", path: "/other.md", contentHash: binding.contentHash, recordId: 10 }, cli, target, env);
    assert.equal(foreign.state, "refused");
    writeFileSync(binding.path, readFileSync(binding.path, "utf8").replace("Verify changed completion.", "Verify completion."));
    owner.kill("SIGKILL");
    await once(owner, "exit");
    const deadOwnerRetry = await requestPlanControl(root, "plan-recorded", { ticket: "YM-7", path: binding.path, contentHash: binding.contentHash, recordId: 10 }, { sessionId: target.sessionId, pid: process.pid, starttime: processStarttime(process.pid)!, cwd: root }, target, env);
    assert.equal(deadOwnerRetry.state, "refused");
    assert.match(deadOwnerRetry.reason ?? "", /owner is no longer live/);
  } finally {
    releaseCompletion?.();
    releaseReverseCompletion?.();
    if (cliPid) try { process.kill(cliPid, "SIGKILL"); } catch {}
    if (owner.exitCode === null) owner.kill("SIGKILL");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

for (const registered of [false, true]) for (const initialFailure of [false, true]) test(`paired scout reservations are deny-only and retain high-water for ${registered ? "registered" : "save-only"} workers after late ${initialFailure ? "failure" : "success"}`, { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "paired-scout-control-"));
  const runtime = mkdtempSync(join(tmpdir(), "paired-scout-runtime-"));
  const binding = recordedPlan(root, "YM-7");
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const target = { sessionId: "main-session", runtimeId: "main-runtime" };
  const starttime = processStarttime(process.pid)!;
  const main = { sessionId: target.sessionId, pid: process.pid, starttime, cwd: root };
  const worker = { ...main, sessionId: "plan-session", pane: "plan", parentPane: "main", mode: "plan", ticket: "YM-7", role: "coordinator" };
  let publications = 0;
  let preparations = 0;
  let records = 0;
  let launches = 0;
  const pending = new Map<number, { started: Promise<void>; start(): void; wait: Promise<void>; release(): void }>();
  for (const id of [1, 3]) {
    let start!: () => void;
    let release!: () => void;
    pending.set(id, { started: new Promise<void>((resolve) => { start = resolve; }), start: () => start(), wait: new Promise<void>((resolve) => { release = resolve; }), release: () => release() });
  }
  const server = bindCoordinatorControl(root, {
    launch: async () => { launches++; return {}; }, status: (requestId) => ({ requestId, state: "status" }), cancel: async () => {},
    publishPlanScout: async (_ticket, id) => {
      publications++;
      const hold = pending.get(id);
      if (hold) { hold.start(); await hold.wait; }
      if (id === 3 || id === 1 && initialFailure) throw new Error("artifact provenance refused");
      return { reason: "published", publication: "complete", target: "fixture", revision: binding.contentHash };
    },
    preparePlanPublication: async (_ticket, _path, _hash, acceptanceId) => { preparations++; return { reason: "prepared", recordId: 9, snapshotPath: "/snapshot", scoutAcceptance: acceptanceId, revision: binding.contentHash, binding }; },
    planRecorded: async (_ticket, _path, _id, _origin, context, verify) => { records++; verify(binding); return { reason: "ready", handoff: context.kind === "save-only" ? "unavailable" : "plan-only" }; },
  }, { root, ...target, pid: process.pid, starttime, cwd: root, pane: "main" }, env);
  try {
    if (!server.listening) await once(server, "listening");
    writePane(env, "main", root, "main", null, target.sessionId);
    writePane(env, "plan", root, "plan", "YM-7", worker.sessionId, process.pid, "main");
    const runId = registered ? (await requestPlanControl(root, "register-plan", { ticket: "YM-7" }, main, target, env)).runId : undefined;
    const payload = { ticket: "YM-7", ...(registered ? { runId } : {}) };
    if (registered) {
      assert.ok(runId);
      assert.equal((await requestPlanControl(root, "bind-plan", { ...payload, pane: "plan" }, main, target, env)).state, "accepted");
      assert.equal((await requestPlanControl(root, "plan-started", payload, worker, target, env)).state, "accepted");
    }
    const child = (n: number) => ({ ...scoutChild(worker, "YM-7", "paired"), cwd: root, runId: `scout-${n}`, batchId: `batch-${n}` });
    const fence = (n: number) => requestPlanControl(root, "reject-plan-scout", { ...payload, child: child(n), scoutSequence: 2 * n - 1 }, worker, target, env);
    const publish = (n: number) => requestPlanControl(root, "publish-plan-scout", { ...payload, child: child(n), scoutSequence: 2 * n, acceptanceId: n }, worker, target, env);
    const prepare = () => requestPlanControl(root, "prepare-plan-publication", { ...payload, path: binding.path, contentHash: binding.contentHash }, worker, target, env);
    const record = () => requestPlanControl(root, "plan-recorded", { ...payload, path: binding.path, contentHash: binding.contentHash, recordId: 9 }, worker, target, env);
    for (const invalidRunId of ["", "foreign"]) assert.equal((await requestPlanControl(root, "reject-plan-scout", { ...payload, runId: invalidRunId, child: child(1), scoutSequence: 1 }, worker, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "reject-plan-scout", { ...payload, child: { ...child(1), ownerSessionId: "foreign" }, scoutSequence: 1 }, worker, target, env)).state, "refused");
    assert.equal((await fence(1)).reason, "scout rejected");
    assert.equal((await prepare()).state, "refused");
    assert.equal((await record()).state, "refused");
    assert.deepEqual([publications, preparations, records, launches], [0, 0, 0, 0]);
    const oldSuccess = publish(1);
    await pending.get(1)!.started;
    assert.equal((await fence(2)).reason, "scout rejected");
    pending.get(1)!.release();
    const late = await oldSuccess;
    if (initialFailure) assert.equal(late.state, "refused");
    else assert.equal(late.artifactAcceptance, "superseded");
    const replay = await publish(1);
    assert.notEqual(replay.artifactAcceptance, "accepted");
    assert.equal((await prepare()).state, "refused");
    assert.equal((await publish(2)).artifactAcceptance, "accepted");
    assert.equal((await fence(3)).reason, "scout rejected");
    const oldFailure = publish(3);
    await pending.get(3)!.started;
    assert.equal((await fence(4)).reason, "scout rejected");
    pending.get(3)!.release();
    assert.equal((await oldFailure).state, "refused");
    assert.equal((await publish(3)).state, "refused");
    assert.equal((await prepare()).state, "refused");
    assert.equal((await publish(4)).artifactAcceptance, "accepted");
    for (const origin of [{ ...worker, sessionId: "foreign" }, { ...worker, starttime: "0" }, { ...worker, parentPane: "foreign" }]) assert.equal((await requestPlanControl(root, "reject-plan-scout", { ...payload, child: child(5), scoutSequence: 9 }, origin, target, env)).state, "refused");
    for (const invalidChild of [{ ...child(5), ownerRunId: "foreign" }, { ...child(5), ownerSessionId: "foreign" }, { ...child(5), ticket: "YM-8" }]) assert.equal((await requestPlanControl(root, "reject-plan-scout", { ...payload, child: invalidChild, scoutSequence: 9 }, worker, target, env)).state, "refused");
    assert.equal((await requestPlanControl(root, "reject-plan-scout", { ...payload, child: child(3), scoutSequence: 6 }, worker, target, env)).reason, "uncorrelated scout rejection ignored");
    assert.equal((await requestPlanControl(root, "reject-plan-scout", { ...payload, child: child(4), scoutSequence: 8, acceptanceId: 4 }, worker, target, env)).reason, "scout rejected");
    assert.equal((await prepare()).state, "refused");
    assert.equal((await fence(5)).reason, "scout rejected");
    assert.equal((await publish(5)).artifactAcceptance, "accepted");
    assert.equal((await requestPlanControl(root, "reject-plan-scout", { ...payload, child: child(4), scoutSequence: 8, acceptanceId: 4 }, worker, target, env)).reason, "scout rejection superseded");
    assert.equal((await prepare()).state, "accepted");
    assert.equal((await record()).handoff, registered ? "plan-only" : "unavailable");
    assert.deepEqual([preparations, records, launches], [1, 1, 0]);
  } finally {
    for (const hold of pending.values()) hold.release();
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
  let completions = 0;
  const callbackStarted = new Promise<void>((resolve) => { started = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const server = bindCoordinatorControl(root, {
    launch: async () => { throw new Error("unexpected launch"); },
    status: (requestId) => ({ requestId, state: "status" }), cancel: async () => {},
    publishPlanScout: async () => ({ reason: "published", publication: "complete", target: "fixture", revision: binding.contentHash }),
    preparePlanPublication: async (_ticket, _path, _hash, acceptanceId) => ({ reason: "prepared", recordId: 10, snapshotPath: "/snapshot", scoutAcceptance: acceptanceId, revision: binding.contentHash, binding }),
    planRecorded: async (_ticket, _path, _recordId, _origin, context, verify) => { completions++; assert.equal(context.kind, "save-only"); started(); await barrier; verify(binding); return { reason: "ready", handoff: "unavailable" }; },
  }, { root, ...target, pid: process.pid, starttime: processStarttime(process.pid)!, cwd: root, pane: "main" }, env);
  const owner = spawn(process.execPath, ["-e", `const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)`], { stdio: ["ignore", "pipe", "ignore"] });
  let cliPid = 0;
  try {
    if (!server.listening) await once(server, "listening");
    await once(owner, "spawn");
    owner.stdout!.setEncoding("utf8");
    cliPid = Number(String((await once(owner.stdout!, "data"))[0]).trim());
    const pane = "save-death-pane";
    writePane(env, "main", root, "main", null, target.sessionId);
    writePane(env, pane, root, "plan", "YM-8", "save-death-session", owner.pid!, "main");
    const worker = { sessionId: "save-death-session", pid: owner.pid!, starttime: processStarttime(owner.pid!)!, cwd: root, pane, parentPane: "main", mode: "plan", ticket: "YM-8", role: "coordinator" };
    const child = { ...scoutChild(worker, "YM-8", "death"), cwd: root };
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ticket: "YM-8", acceptanceId: 8, child }, worker, target, env)).state, "accepted");
    const cli = { ...worker, pid: cliPid, starttime: processStarttime(cliPid)! };
    assert.equal((await requestPlanControl(root, "prepare-plan-publication", { ticket: "YM-8", path: binding.path, contentHash: binding.contentHash }, cli, target, env)).state, "accepted");
    const completion = requestPlanControl(root, "plan-recorded", { ticket: "YM-8", path: binding.path, contentHash: binding.contentHash, recordId: 10 }, cli, target, env);
    await callbackStarted;
    owner.kill("SIGKILL");
    await once(owner, "exit");
    release();
    const result = await completion;
    assert.equal(result.state, "refused");
    assert.match(result.reason ?? "", /owner or scout changed/);
    const reconciliation = await requestPlanControl(root, "plan-recorded", { ticket: "YM-8", path: binding.path, contentHash: binding.contentHash, recordId: 10 }, { sessionId: target.sessionId, pid: process.pid, starttime: processStarttime(process.pid)!, cwd: root }, target, env);
    assert.equal(reconciliation.state, "refused");
    assert.match(reconciliation.reason ?? "", /owner or scout changed/);
    assert.equal(completions, 2);
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
    writePane(env, "main", root, "main", null, target.sessionId);
    writePane(env, "plan", root, "plan", "YM-2", "plan-session", child.pid!, "main");
    assert.equal((await requestPlanControl(root, "plan-started", { ticket: "YM-2", runId: registered.runId }, worker, target, env)).state, "accepted");
    assert.equal((await requestPlanControl(root, "publish-plan-scout", { ticket: "YM-2", runId: registered.runId, acceptanceId: 1, child: { ...scoutChild(worker, "YM-2", "exit"), cwd: root } }, worker, target, env)).state, "accepted");
    const recording = requestPlanControl(root, "record-plan", { ticket: "YM-2", runId: registered.runId, path: "/plan.md", contentHash: "a".repeat(64) }, worker, target, env);
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
    const replay = await requestPlanControl(root, "record-plan", { ticket: "YM-2", runId: registered.runId, path: "/plan.md", contentHash: "a".repeat(64) }, main, target, env);
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
