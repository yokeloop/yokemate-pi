import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Socket } from "node:net";
import { cpSync, mkdtempSync, mkdirSync, readdirSync, symlinkSync, writeFileSync, readFileSync, realpathSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileProvenance } from "../src/subagent-runs.ts";
import { continueOwnedCoordinator, startCoordinatorRpc, type RpcEvent } from "../src/coordinator-rpc.ts";
import { runBoundedRuntimeCase, untilAborted } from "./fixtures/bounded-runtime-case.ts";
import { openDb } from "../src/db.ts";

const root = resolve(import.meta.dirname, "..");
const extension = join(root, ".pi/extensions/subagent/index.ts");
const provider = join(root, "test/fixtures/subagent-runtime-provider.ts");
const piVersion = JSON.parse(readFileSync(join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version;
const piPackage = realpathSync(join(root, "node_modules/@earendil-works/pi-coding-agent"));
const cli = join(piPackage, "dist/cli.js");
const baselineSha = "b5c36542da67f79f1c88e5bdffe49620b53a8115";
const unpatchedStore = mkdtempSync(join(root, "node_modules/.pnpm/.ym226-unpatched-"));
cpSync(join(resolve(piPackage, "../../.."), "node_modules"), join(unpatchedStore, "node_modules"), { recursive: true });
const unpatchedPackage = join(unpatchedStore, "node_modules/@earendil-works/pi-coding-agent");
execFileSync("patch", ["-p1", "--reverse", "--batch", "--input", join(root, "patches/@earendil-works__pi-coding-agent@0.85.1.patch")], { cwd: unpatchedPackage, stdio: "pipe" });
const unpatchedCli = join(unpatchedPackage, "dist/cli.js");
process.once("exit", () => rmSync(unpatchedStore, { recursive: true, force: true }));

test("real Pi delivers a terminal blocked scout without PI_SESSION_ID when parent control is unavailable", { timeout: 30000 }, async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "plan-scout-terminal-"));
  const runtime = join(sandbox, "runtime");
  const agentDir = join(sandbox, "agent");
  const copiedExtension = join(sandbox, ".pi/extensions/subagent/index.ts");
  mkdirSync(runtime, { recursive: true });
  mkdirSync(join(sandbox, ".pi/agents"), { recursive: true });
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  cpSync(join(root, "src"), join(sandbox, "src"), { recursive: true });
  cpSync(join(root, ".pi/extensions/subagent"), join(sandbox, ".pi/extensions/subagent"), { recursive: true });
  cpSync(join(root, ".pi/settings.json"), join(sandbox, ".pi/settings.json"));
  symlinkSync(join(root, "node_modules"), join(sandbox, "node_modules"));
  symlinkSync(provider, join(agentDir, "extensions/provider.ts"));
  writeFileSync(join(sandbox, ".pi/agents/plan-scout.md"), "---\nname: plan-scout\ndescription: fixture scout\ntools: read\n---\nReturn complete scout Markdown.\n");
  writeFileSync(join(sandbox, ".env.local"), "");
  const clone = join(sandbox, "clone");
  mkdirSync(clone);
  execFileSync("git", ["init", "-b", "main", clone], { stdio: "pipe" });
  execFileSync("git", ["-C", clone, "remote", "add", "origin", "https://github.com/org/repo.git"], { stdio: "pipe" });
  const db = openDb(join(sandbox, "yokemate.db"));
  db.prepare("INSERT INTO project (org,repo,path,tracker,tracker_key,model) VALUES ('org','repo',?,'github','YM','ym204-fixture/deterministic')").run(clone);
  db.close();
  const sockets = new Set<Socket>();
  const barrier = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("data", (chunk) => { if (chunk.toString().includes("\n")) socket.end("release\n"); });
  });
  const socketPath = join(runtime, "provider.sock");
  await new Promise<void>((resolve) => barrier.listen(socketPath, resolve));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: sandbox, XDG_RUNTIME_DIR: runtime, PI_CODING_AGENT_DIR: agentDir, YM204_FIXTURE_SOCKET: socketPath, YM204_FIXTURE_SCENARIO: "plan_scout_terminal", YOKEMATE_MODE: "plan", YOKEMATE_TICKET: "YM-1" };
  delete env.PI_SESSION_ID;
  delete env.YOKEMATE_ROLE;
  delete env.YOKEMATE_PLAN_RUN_ID;
  delete env.HERDR_PANE_ID;
  delete env.YOKEMATE_PARENT_PANE;
  let proc: ReturnType<typeof spawn> | undefined;
  try {
    proc = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session", "--no-extensions", "-e", provider, "-e", copiedExtension, "--model", "ym204-fixture/deterministic:high"], { cwd: sandbox, env, stdio: ["pipe", "pipe", "pipe"] });
    const stdoutStream = proc.stdout!;
    const stderrStream = proc.stderr!;
    let stdout = "";
    let stderr = "";
    stdoutStream.on("data", (chunk) => { stdout += chunk.toString(); });
    stderrStream.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.stdin!.write(JSON.stringify({ id: "work", type: "prompt", message: "Launch the scout." }) + "\n");
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve) => stdoutStream.on("data", () => { if (/"artifact":\{"state":"blocked"/.test(stdout)) resolve(); })),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`scout terminal timeout: ${JSON.stringify({ stdout: stdout.slice(-12000), stderr })}`)), 20000); }),
      ]);
    } finally { clearTimeout(timer); }
    assert.match(stdout, /"batchId":"scout-terminal"/);
    assert.match(stdout, /"artifact":\{"state":"blocked"/);
    assert.match(stdout, /"reason":"unavailable"/);
    const state = openDb(join(sandbox, "yokemate.db"));
    try { assert.equal(state.prepare("SELECT reason FROM plan_publication_block WHERE ticket='YM-1' ORDER BY id DESC LIMIT 1").get()?.reason, "unavailable"); }
    finally { state.close(); }
  } finally {
    if (proc?.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
    if (proc && proc.exitCode === null && proc.signalCode === null) await new Promise<void>((resolve) => proc!.once("close", () => resolve()));
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => barrier.close(() => resolve()));
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("real runtime keeps merge and ship finalization on owned parent control operations", () => {
  const source = readFileSync(extension, "utf8");
  assert.match(source, /name: "coordinator_merge"/);
  assert.match(source, /requestShipFinalize\(ENGINE_ROOT, runId/);
  assert.match(source, /finalizeShip: async \(runId, finalizeOrigin\)/);
  assert.ok(source.indexOf("requestShipFinalize(ENGINE_ROOT, runId") < source.indexOf("outcome proposed"));
});

async function runOwnedBoundaryScenario(scenario: "owned_busy_report_boundary" | "owned_active_child_yield", signal: AbortSignal): Promise<void> {
  const ownerId = `owner-${scenario.replaceAll("_", "-")}`;
  const sandbox = mkdtempSync(join(tmpdir(), `ym283-${scenario}-`));
  const cwd = join(sandbox, "cwd");
  const agentDir = join(sandbox, "agent");
  const runtimeExtension = join(sandbox, ".pi/extensions/subagent/index.ts");
  mkdirSync(join(cwd, ".pi/agents"), { recursive: true });
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  mkdirSync(join(sandbox, ".pi/agents"), { recursive: true });
  cpSync(join(root, "src"), join(sandbox, "src"), { recursive: true });
  cpSync(join(root, ".pi/extensions/subagent"), join(sandbox, ".pi/extensions/subagent"), { recursive: true });
  symlinkSync(join(root, "node_modules"), join(sandbox, "node_modules"));
  symlinkSync(provider, join(agentDir, "extensions/provider.ts"));
  writeFileSync(join(sandbox, ".pi/agents/do-coordinator.md"), "Fixture coordinator");
  writeFileSync(join(cwd, ".pi/agents/task-reviewer.md"), "---\nname: task-reviewer\ndescription: Deterministic transport fixture\ntools: read\n---\nReturn reviewer JSON.\n");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const readFixture = join(sandbox, "read-fixture.txt");
  writeFileSync(readFixture, "fixture");
  const priorEnv = { ...process.env };
  for (const key of Object.keys(process.env)) if (!["PATH", "NODE_TEST_CONTEXT"].includes(key)) delete process.env[key];
  Object.assign(process.env, { HOME: sandbox, PI_CODING_AGENT_DIR: agentDir, YM204_FIXTURE_SOCKET: join(sandbox, "barrier.sock"), YM204_FIXTURE_REVIEW_CWD: root, YM204_FIXTURE_BASE: head, YM204_FIXTURE_HEAD: head, YM204_FIXTURE_SCENARIO: scenario, YM204_FIXTURE_READ_FILE: readFixture });
  const phases: any[] = [];
  const sockets = new Set<Socket>();
  const held = new Map<string, Socket[]>();
  const waiters: Array<() => void> = [];
  const wake = () => { for (const waiter of waiters.splice(0)) waiter(); };
  const waitPhase = async (phase: string) => {
    while (!phases.some((entry) => entry.phase === phase)) await untilAborted(new Promise<void>((resolve) => waiters.push(resolve)), signal);
    return phases.find((entry) => entry.phase === phase)!;
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        phases.push(message);
        if ((message.phase === "child-working" && scenario === "owned_active_child_yield") || message.phase === "coordinator-tool-held") held.set(message.phase, [...held.get(message.phase) ?? [], socket]);
        else socket.end("release\n");
        wake();
      }
    });
  });
  const events: RpcEvent[] = [];
  let rpc: ReturnType<typeof startCoordinatorRpc> | undefined;
  let enqueued!: () => void;
  let observed!: () => void;
  const enqueuedState = new Promise<void>((resolve) => { enqueued = resolve; });
  const observedState = new Promise<void>((resolve) => { observed = resolve; });
  try {
    await untilAborted(new Promise<void>((resolve) => server.listen(process.env.YM204_FIXTURE_SOCKET, resolve)), signal);
    rpc = startCoordinatorRpc({ mode: "do", tickets: ["YM-283"], model: "ym204-fixture/deterministic:high", cwd, plans: {}, parts: [], prompt: "work", skillsPath: join(root, ".pi/skills"), resourcesPath: sandbox } as any,
      { runId: ownerId, parentSessionId: "fixture-parent", mode: "do", ticket: "YM-283", project: [], role: "coordinator", cwd, model: "ym204-fixture/deterministic:high" },
      { provider: "ym204-fixture", id: "deterministic", thinkingLevel: "high" },
      { onEvent(event) {
        events.push(event);
        const state = event.type === "entry_appended" && (event.entry as any)?.customType === "yokemate-child-state" ? (event.entry as any).data : undefined;
        if (state?.deliveries.some((delivery: any) => delivery.state === "enqueued")) enqueued();
        if (state?.deliveries.length >= 2 && state.deliveries.every((delivery: any) => delivery.state === "observed")) observed();
      } },
      { invocation: { command: process.execPath, args: [cli, "--mode", "rpc", "--no-session", "--no-extensions", "-e", provider, "-e", runtimeExtension, "--skill", join(root, ".pi/skills"), "--model", "ym204-fixture/deterministic:high"] }, readyTimeoutMs: 10000, stopGraceMs: 50 });
    await untilAborted(rpc.ready, signal);
    await untilAborted(rpc.request({ type: "prompt", message: "work" }), signal);
    await waitPhase("child-working");
    if (scenario === "owned_busy_report_boundary") {
      await waitPhase("coordinator-tool-held");
      await untilAborted(enqueuedState, signal);
      assert.equal(events.some((event) => event.type === "tool_execution_end" && event.toolCallId === "busy-tool"), false);
      const deliveryState = events.filter((event) => event.type === "entry_appended" && (event.entry as any)?.customType === "yokemate-child-state").map((event) => (event.entry as any).data).findLast((state) => state.deliveries.some((delivery: any) => delivery.state === "enqueued"));
      assert.ok(deliveryState);
      for (const socket of held.get("coordinator-tool-held") ?? []) socket.end("release\n");
    } else {
      await waitPhase("turn-end-provider");
      assert.equal(phases.filter((entry) => entry.phase === "context").length, 1);
      assert.equal(phases.some((entry) => entry.phase === "unexpected-before-report"), false);
      for (const socket of held.get("child-working") ?? []) socket.end("release\n");
    }
    const providerReport = await waitPhase("owned-report-provider");
    await untilAborted(observedState, signal);
    const reportContext = phases.find((entry) => entry.phase === "context" && entry.data.reports.some((report: any) => report.details?.envelope?.kind === "result"));
    assert.ok(reportContext);
    assert.equal(reportContext.data.ordinal, 2);
    assert.equal(providerReport.data.providerCalls, 2);
    assert.equal(phases.some((entry) => entry.phase === "unexpected-before-report"), false);
    const toolEnd = events.findIndex((event) => event.type === "tool_execution_end" && event.toolCallId === (scenario === "owned_busy_report_boundary" ? "busy-tool" : "active-child"));
    const reportMessage = events.findIndex((event) => event.type === "message_end" && (event.message as any)?.customType === "subagent-report");
    assert.ok(toolEnd >= 0 && reportMessage > toolEnd);
    const loaded = phases.filter((entry) => entry.phase === "loaded");
    assert.ok(loaded.every((entry) => entry.data.file === provider));
    assert.equal(loaded.find((entry) => entry.role === "coordinator")?.data.tools.find((tool: any) => tool.name === "subagent")?.path, runtimeExtension);
    console.log(JSON.stringify({ piVersion, scenario, extension: fileProvenance(runtimeExtension), provider: fileProvenance(provider), owner: ownerId, baseSha: head, headSha: head, contexts: phases.filter((entry) => entry.phase === "context").map((entry) => ({ ordinal: entry.data.ordinal, reports: entry.data.reports.map((report: any) => report.details?.deliveryId) })), observed: true }));
    rpc.acceptTerminal();
  } finally {
    for (const group of held.values()) for (const socket of group) socket.end("release\n");
    await rpc?.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, priorEnv);
    rmSync(sandbox, { recursive: true, force: true });
  }
}

test("owned_busy_report_boundary", { timeout: 30000 }, (t) => runBoundedRuntimeCase(t, (signal) => runOwnedBoundaryScenario("owned_busy_report_boundary", signal)));
test("owned_active_child_yield", { timeout: 30000 }, (t) => runBoundedRuntimeCase(t, (signal) => runOwnedBoundaryScenario("owned_active_child_yield", signal)));

test("real Pi correlates delayed A batch after B admission and keeps B owned", { timeout: 30000 }, async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ym204-runtime-"));
  const cwd = join(sandbox, "cwd");
  const agentDir = join(sandbox, "agent");
  const runtimeExtension = join(sandbox, ".pi/extensions/subagent/index.ts");
  mkdirSync(join(cwd, ".pi/agents"), { recursive: true });
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  cpSync(join(root, "src"), join(sandbox, "src"), { recursive: true });
  cpSync(join(root, ".pi/extensions/subagent"), join(sandbox, ".pi/extensions/subagent"), { recursive: true });
  symlinkSync(join(root, "node_modules"), join(sandbox, "node_modules"));
  symlinkSync(provider, join(agentDir, "extensions/provider.ts"));
  mkdirSync(join(sandbox, ".pi/agents"), { recursive: true });
  writeFileSync(join(sandbox, ".pi/agents/do-coordinator.md"), "Fixture coordinator");
  writeFileSync(join(cwd, ".pi/agents/task-reviewer.md"), "---\nname: task-reviewer\ndescription: Deterministic transport fixture\ntools: read\n---\nReturn reviewer JSON.\n");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const priorEnv = { ...process.env };
  for (const key of Object.keys(process.env)) if (!["PATH", "NODE_TEST_CONTEXT"].includes(key)) delete process.env[key];
  Object.assign(process.env, { HOME: sandbox, PI_CODING_AGENT_DIR: agentDir, YM204_FIXTURE_SOCKET: join(sandbox, "barrier.sock"), YM204_FIXTURE_REVIEW_CWD: root, YM204_FIXTURE_BASE: head, YM204_FIXTURE_HEAD: head });
  const events: RpcEvent[] = [];
  const phases: any[] = [];
  const held = new Map<string, Socket>();
  const sockets = new Set<Socket>();
  let wake: (() => void) | undefined;
  let oldBatch = false;
  let tearingDown = false;
  let bWorking = false;
  let releaseB = false;
  let pendingB = false;
  let observedB = false;
  let resolvePending!: () => void;
  let resolveObserved!: () => void;
  const pendingBarrier = new Promise<void>((resolve) => { resolvePending = resolve; });
  const observedBarrier = new Promise<void>((resolve) => { resolveObserved = resolve; });
  const reached = new Promise<void>((resolve) => { wake = resolve; });
  const check = () => { if (oldBatch && bWorking) wake?.(); };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const message = JSON.parse(buffer.slice(0, newline));
      phases.push(message);
      if (message.phase === "context" && releaseB && !pendingB && message.data.reports.some((report: any) => report.details?.envelope?.identity?.batchId === "batch-B")) {
        pendingB = true;
        held.set("B-delivery", socket);
        resolvePending();
      }
      else if (message.phase === "B-working") { bWorking = true; held.set("B", socket); check(); }
      else { if (message.phase === "old-batch-after-B") oldBatch = true; socket.end("release\n"); check(); }
    });
  });
  await new Promise<void>((resolve) => server.listen(process.env.YM204_FIXTURE_SOCKET, resolve));
  let rpc: ReturnType<typeof startCoordinatorRpc> | undefined;
  try {
    rpc = startCoordinatorRpc({ mode: "do", tickets: ["YM-204"], model: "ym204-fixture/deterministic:high", cwd, plans: {}, parts: [], prompt: "work", skillsPath: join(root, ".pi/skills"), resourcesPath: sandbox } as any,
      { runId: "runtime-owner", parentSessionId: "fixture-parent", mode: "do", ticket: "YM-204", project: [], role: "coordinator", cwd, model: "ym204-fixture/deterministic:high" },
      { provider: "ym204-fixture", id: "deterministic", thinkingLevel: "high" },
      { onEvent(event) { events.push(event);
        const state = event.type === "entry_appended" && (event.entry as any)?.customType === "yokemate-child-state" ? (event.entry as any).data : undefined;
        if (rpc && !observedB && !tearingDown) continueOwnedCoordinator(rpc, event, (reason) => assert.fail(`unexpected parent blocked: ${reason}`));
        if (state && releaseB && state.children.length === 0 && state.deliveries.filter((delivery: any) => delivery.batchId === "batch-B").length === 2 && state.deliveries.every((delivery: any) => delivery.state === "observed")) { observedB = true; resolveObserved(); } } },
      { invocation: { command: process.execPath, args: [cli, "--mode", "rpc", "--no-session", "--no-extensions", "-e", provider, "-e", runtimeExtension, "--skill", join(root, ".pi/skills"), "--model", "ym204-fixture/deterministic:high"] }, readyTimeoutMs: 10000, stopGraceMs: 50 });
    await rpc.ready;
    await rpc.request({ type: "prompt", message: "work" });
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([reached, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`interleaving not reached: ${JSON.stringify({ phases: phases.map((p) => p.phase), events: events.filter((e) => e.type === "tool_execution_end" || e.type === "extension_error") })}`)), 15000); })]);
    } finally { clearTimeout(timeout); }
    const acknowledgments = events.filter((event) => event.type === "tool_execution_end" && event.toolName === "subagent");
    assert.equal(acknowledgments.length, 2);
    const refused = events.find((event) => event.type === "tool_execution_end" && event.toolCallId === "premature-finish");
    assert.match(JSON.stringify(refused?.result), /coordinator still has active child batches/);
    assert.notEqual((refused?.result as any)?.terminate, true);
    assert.ok(phases.filter((p) => p.phase === "loaded").every((p) => p.data.file === provider));
    assert.equal(phases.find((p) => p.phase === "loaded" && p.role === "coordinator").data.tools.find((tool: any) => tool.name === "subagent")?.path, runtimeExtension);
    assert.ok(phases.filter((p) => p.phase === "loaded").every((p) => p.data.commands.find((command: any) => command.name === "yokemate-coordinator-ready")?.path === runtimeExtension), JSON.stringify(phases.filter((p) => p.phase === "loaded").map((p) => p.data)));
    assert.equal(rpc.hasLiveDescendants(), true);
    assert.ok(events.some((event) => event.type === "entry_appended" && (event.entry as any)?.customType === "yokemate-child-state"), "owned child state must bypass follow-up delivery");
    const a = (acknowledgments[0]!.result as any).details;
    const b = (acknowledgments[1]!.result as any).details;
    assert.equal(a.batchId, "batch-A", "launch ACK must identify A independently of B");
    assert.equal(b.batchId, "batch-B");
    assert.notEqual(a.children[0].identity.runId, b.children[0].identity.runId);
    const old = phases.find((p) => p.phase === "old-batch-after-B").data;
    assert.match(JSON.stringify(old), /batch-A/);
    assert.equal(rpc.childState.settled(), "wait");
    assert.equal(rpc.childState.canFinish("done"), false);
    assert.doesNotMatch(JSON.stringify(phases), /Continue the pipeline or call coordinator_finish/);
    releaseB = true;
    held.get("B")!.end("release\n");
    held.delete("B");
    await pendingBarrier;
    assert.equal(rpc.childState.settled(), "wait");
    assert.equal(rpc.childState.canFinish("blocked", "premature"), false);
    assert.ok(rpc.childState.pendingIds().length > 0);
    assert.equal(rpc.process.exitCode, null);
    held.get("B-delivery")!.end("release\n");
    held.delete("B-delivery");
    await observedBarrier;
    assert.equal(observedB, true);
    assert.equal(rpc.childState.busyCount(), 0);
    assert.equal(rpc.childState.canFinish("done"), true);
    assert.equal(rpc.childState.settled(), "nudge");
    assert.equal(rpc.childState.settled(), "blocked");
    const bResult = events.find((event) => event.type === "message_end" && (event.message as any)?.details?.envelope?.identity?.batchId === "batch-B");
    const envelope = (bResult?.message as any)?.details?.envelope;
    assert.equal(envelope.reviewVerdict, "approved");
    assert.equal(envelope.processOutcome, "exited");
    assert.equal(envelope.exitCode, 0);
    assert.equal(envelope.signal, null);
    assert.deepEqual(JSON.parse(envelope.payload), { status: "approved", findings: [] });
    console.log(JSON.stringify({ piVersion, scenario: "delayed-A-B", extension: fileProvenance(runtimeExtension), guard: fileProvenance(join(sandbox, "src/guards.ts")), baseSha: head, headSha: head, ack: [a, b], order: events.filter((event) => event.type === "entry_appended" && (event.entry as any)?.customType === "yokemate-child-state").map((event) => (event.entry as any).data), terminal: envelope, observed: true, modelThinking: phases.filter((p) => p.phase === "loaded").map((p) => ({ model: p.data.model, thinking: p.data.thinking, sessionId: p.data.sessionId })) }));
  } finally {
    tearingDown = true;
    for (const socket of held.values()) socket.end("release\n");
    await rpc?.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, priorEnv);
    rmSync(sandbox, { recursive: true, force: true });
  }
});

const cases = [
  ["baseline_read_heavy_24", "valid"], ["baseline_read_heavy_32", "valid"], ["baseline_read_heavy_parallel", "valid"],
  ["read_heavy_24", "valid"], ["read_heavy_32", "valid"], ["read_heavy_parallel", "valid"],
  ["parallel_max", "valid"], ["chain_max", "valid"], ["parent_cancel", "incomplete"], ["parallel", "valid"], ["chain_long", "valid"], ["chain", "invalid_reviewer_json"], ["missing", "missing_final"], ["invalid", "invalid_reviewer_json"],
  ["output_limit", "output_limit"], ["protocol_invalid", "protocol_error"], ["protocol_partial", "protocol_error"], ["protocol_overflow", "protocol_error"],
  ["old_final", "missing_final"], ["retry", "valid"], ["nonzero", "incomplete"], ["signal", "incomplete"], ["spawn_error", "incomplete"], ["cleanup_error", "valid"], ["write_cleanup_error", "incomplete"], ["diagnostic_error", "valid"], ["storage_error", "valid"], ["delivery_sync", "delivery_failed"], ["delivery_async", "delivery_failed"], ["delivery_sync_batch", "delivery_failed"], ["delivery_sync_both", "delivery_failed"], ["delivery_async_batch", "delivery_failed"], ["delivery_async_both", "delivery_failed"], ["delivery_async_after_observed", "valid"],
] as const;

async function runFaultScenario(scenario: typeof cases[number][0], outcome: typeof cases[number][1], signal: AbortSignal): Promise<void> {
  const sandbox = mkdtempSync(join(tmpdir(), "ym204-fault-"));
  const cwd = join(sandbox, "cwd");
  const agentDir = join(sandbox, "agent");
  const folder = join(sandbox, "home/knowledge/org/repo/ai/task");
  const relayFacts = join(sandbox, "relay-facts");
  const runtimeExtension = join(sandbox, ".pi/extensions/subagent/index.ts");
  mkdirSync(join(cwd, ".pi/agents"), { recursive: true });
  mkdirSync(join(sandbox, ".pi/agents"), { recursive: true });
  mkdirSync(join(sandbox, ".pi/extensions"), { recursive: true });
  mkdirSync(join(sandbox, "tmp"), { recursive: true });
  mkdirSync(relayFacts, { recursive: true });
  mkdirSync(folder, { recursive: true });
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  if (scenario.startsWith("baseline_")) {
    const archive = execFileSync("git", ["archive", baselineSha, "src", ".pi/extensions/subagent"], { cwd: root });
    execFileSync("tar", ["-x", "-C", sandbox], { input: archive });
  } else {
    cpSync(join(root, "src"), join(sandbox, "src"), { recursive: true });
    cpSync(join(root, ".pi/extensions/subagent"), join(sandbox, ".pi/extensions/subagent"), { recursive: true });
  }
  mkdirSync(join(sandbox, "test/fixtures"), { recursive: true });
  cpSync(join(root, "test/fixtures/subagent-json-relay.mjs"), join(sandbox, "test/fixtures/subagent-json-relay.mjs"));
  symlinkSync(join(root, ".pi/skills"), join(sandbox, ".pi/skills"));
  symlinkSync(join(root, "node_modules"), join(sandbox, "node_modules"));
  symlinkSync(provider, join(agentDir, "extensions/provider.ts"));
  writeFileSync(join(cwd, ".pi/agents/task-reviewer.md"), "---\nname: task-reviewer\ndescription: Deterministic transport fixture\ntools: read\n---\nReturn reviewer JSON.\n");
  writeFileSync(join(cwd, ".pi/agents/worker.md"), "---\nname: worker\ndescription: Deterministic transport fixture\ntools: read\n---\nReturn the requested output.\n");
  writeFileSync(join(cwd, ".pi/agents/plan-scout.md"), "---\nname: plan-scout\ndescription: Deterministic read-heavy fixture\ntools: read, grep, find, ls, bash\n---\nReturn the complete deterministic scout.\n");
  writeFileSync(join(sandbox, ".pi/agents/do-coordinator.md"), "Fixture coordinator");
  writeFileSync(join(folder, "plan.md"), "fixture\n".repeat(6144));
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const runtimeCli = scenario.startsWith("baseline_") ? unpatchedCli : cli;
  const priorEnv = { ...process.env };
  for (const key of Object.keys(process.env)) if (!["PATH", "NODE_TEST_CONTEXT"].includes(key)) delete process.env[key];
  Object.assign(process.env, { HOME: sandbox, TMPDIR: join(sandbox, "tmp"), PI_CODING_AGENT_DIR: agentDir, YM204_FIXTURE_SOCKET: join(sandbox, "barrier.sock"), YM204_FIXTURE_REVIEW_CWD: root, YM204_FIXTURE_BASE: head, YM204_FIXTURE_HEAD: head, YM204_FIXTURE_SCENARIO: scenario, YM204_FIXTURE_READ_FILE: join(folder, "plan.md") });
  if (scenario === "protocol_partial" || scenario === "protocol_overflow") {
    process.env.YOKEMATE_SUBAGENT_TEST_RELAY = join(sandbox, "test/fixtures/subagent-json-relay.mjs");
    process.env.YOKEMATE_SUBAGENT_TEST_FAULT = scenario === "protocol_partial" ? "eof_without_lf" : "record_overflow";
    process.env.YOKEMATE_SUBAGENT_TEST_MANIFEST_DIR = relayFacts;
  }
  const sockets = new Set<Socket>();
  const loaded: any[] = [];
  const observedPhases: string[] = [];
  let asyncFaultSocket: Socket | undefined;
  let working!: () => void;
  const childWorking = new Promise<void>((resolve) => { working = resolve; });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const event = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      observedPhases.push(event.phase);
      if (event.phase === "loaded") loaded.push(event);
      if (scenario === "parent_cancel" && event.phase === "child-working") working();
      else if (event.phase === "async-fault-after-observed") { asyncFaultSocket = socket; return; }
      else if (scenario === "signal" && event.phase === "child-working") process.kill(event.data.pid, "SIGKILL");
      else socket.end("release\n");
    });
  });
  let rpc: ReturnType<typeof startCoordinatorRpc> | undefined;
  let complete!: () => void;
  const delivered = new Promise<void>((resolve) => { complete = resolve; });
  let markAsyncUpdated!: () => void;
  const asyncUpdated = new Promise<void>((resolve) => { markAsyncUpdated = resolve; });
  let markLateAsyncError!: () => void;
  const lateAsyncError = new Promise<void>((resolve) => { markLateAsyncError = resolve; });
  let batch: any;
  const reports: any[] = [];
  let failureReason: string | undefined;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await untilAborted(new Promise<void>((resolve) => server.listen(process.env.YM204_FIXTURE_SOCKET, resolve)), signal);
    rpc = startCoordinatorRpc({ mode: "do", tickets: ["YM-204"], model: "ym204-fixture/deterministic:high", cwd, plan: join(folder, "plan.md"), plans: {}, parts: [], prompt: "work", skillsPath: join(root, ".pi/skills"), resourcesPath: sandbox } as any,
      { runId: `owner-${scenario.replaceAll("_", "-")}`, parentSessionId: "fixture-parent", mode: "do", ticket: "YM-204", project: [], role: "coordinator", cwd, model: "ym204-fixture/deterministic:high" },
      { provider: "ym204-fixture", id: "deterministic", thinkingLevel: "high" },
      { onEvent(event) {
        if (rpc && scenario.startsWith("delivery_")) continueOwnedCoordinator(rpc, event, (reason) => { failureReason = reason; complete(); });
        if (scenario === "delivery_async_after_observed" && event.type === "extension_error" && event.event === "send_message") markLateAsyncError();
        const message = event.type === "message_end" ? event.message as any : undefined;
        const envelope = message?.details?.envelope;
        if (envelope) reports.push(message);
        if (envelope?.kind === "batch") batch = envelope;
        if (event.type === "entry_appended" && (event.entry as any)?.customType === "yokemate-child-state") {
          const state = (event.entry as any).data;
          if (scenario.startsWith("delivery_async") && scenario !== "delivery_async_after_observed" && state.deliveries.length === 2 && state.deliveries.some((delivery: any) => delivery.state === "delivery_failed") && state.deliveries.every((delivery: any) => ["observed", "delivery_failed", "delivery_unknown"].includes(delivery.state))) markAsyncUpdated();
          if (batch && !state.children.length && state.deliveries.length && state.deliveries.every((delivery: any) => delivery.state === "observed")) { asyncFaultSocket?.end("release\n"); complete(); }
        }
      }, onBlocked(reason) { failureReason = reason; complete(); } },
      { invocation: { command: process.execPath, args: [runtimeCli, "--mode", "rpc", "--no-session", "--no-extensions", "-e", provider, "-e", runtimeExtension, "--skill", join(sandbox, ".pi/skills"), "--model", "ym204-fixture/deterministic:high"] }, readyTimeoutMs: 10000, stopGraceMs: scenario === "parent_cancel" ? 5000 : 50 });
    await untilAborted(rpc.ready, signal);
    await untilAborted(rpc.request({ type: "prompt", message: "work" }), signal);
    if (scenario === "parent_cancel") {
      await untilAborted(childWorking, signal);
      const fs = await import("node:fs");
      const snapshotDir = join(sandbox, "sessions/subagent-runs");
      const runningChild = await untilAborted(new Promise<any>((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        const watcher = watch(snapshotDir, inspect);
        function inspect() {
          const snapshots = fs.readdirSync(snapshotDir).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(fs.readFileSync(join(snapshotDir, file), "utf8")));
          const snapshot = snapshots.find((entry) => entry.ownerRunId === "owner-parent-cancel" && entry.agent === "task-reviewer" && entry.stream.phase === "thinking");
          if (!snapshot) return;
          clearTimeout(timer);
          watcher.close();
          resolve(snapshot);
        }
        timer = setTimeout(() => { watcher.close(); reject(new Error("parent_cancel thinking checkpoint missing")); }, 5000);
        inspect();
      }), signal);
      assert.equal(runningChild.lifecycle.processClosed, false);
      assert.ok(runningChild.stream.stdoutBytes > 0);
      rpc.acceptTerminal();
      await rpc.stop("parent_control_cancel");
      const snapshots = fs.readdirSync(snapshotDir).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(fs.readFileSync(join(snapshotDir, file), "utf8")));
      const child = snapshots.find((snapshot) => snapshot.ownerRunId === "owner-parent-cancel" && snapshot.agent === "task-reviewer");
      assert.ok(child);
      assert.equal(child.lifecycle.processClosed, true);
      assert.equal(child.process.outcome, "cancelled");
      assert.equal(child.stream.phase, "thinking");
      assert.ok(child.stream.stdoutBytes > 0);
      assert.ok(child.lifecycle.closeAt);
      return;
    }
    const deliveryTimeout = scenario === "chain_max" || scenario.includes("read_heavy") ? 45000 : 10000;
    await untilAborted(Promise.race([delivered, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`${scenario}: report not observed; phases=${observedPhases.join(",")}`)), deliveryTimeout); })]), signal);
    if (scenario === "delivery_async_after_observed") {
      await untilAborted(lateAsyncError, signal);
      assert.equal(failureReason, undefined);
      assert.deepEqual(rpc.childState.pendingIds(), []);
      assert.equal(rpc.childState.canFinish("done"), true);
      assert.ok(rpc.events.some((event) => event.type === "extension_error" && event.event === "send_message"));
    } else if (scenario.startsWith("delivery_")) {
      assert.match(failureReason!, /report delivery failure; unobserved IDs:/);
      assert.equal(rpc.childState.canFinish("done"), false);
      assert.equal(rpc.childState.canFinish("blocked", failureReason), true);
      assert.equal(rpc.events.filter((event) => event.type === "tool_execution_start" && event.toolName === "subagent").length, 1);
      assert.equal(rpc.childState.pendingIds().length, scenario.endsWith("_both") ? 2 : 1);
      if (scenario.startsWith("delivery_async")) {
        assert.ok(rpc.events.some((event) => event.type === "extension_error" && event.event === "send_message"));
        await untilAborted(asyncUpdated, signal);
        for (const deliveryId of rpc.childState.pendingIds()) {
          const archived = JSON.parse(readFileSync(join(sandbox, ".pi/subagent-reports", deliveryId, "diagnostics.json"), "utf8"));
          assert.match(archived.diagnostics.delivery.state, /^delivery_(?:failed|unknown)$/);
        }
      }
      rpc.acceptTerminal();
      return;
    }
    assert.equal(failureReason, undefined, scenario);
    assert.ok(batch, scenario);
    const results = batch.results;
    const profileScenario = scenario.replace(/^baseline_/, "");
    assert.equal(results[scenario === "chain" ? 1 : 0].payloadOutcome, outcome, scenario);
    if (scenario === "chain") {
      assert.equal(results.length, 3);
      assert.equal(results[0].payloadOutcome, "valid");
      assert.equal(results[2].processOutcome, "not_started");
      assert.notEqual(results[1].actualTaskHash, results[1].identity.taskHash);
    }
    if (profileScenario === "read_heavy_24" || profileScenario === "read_heavy_32") {
      const expectedBytes = profileScenario === "read_heavy_24" ? 16070 : 25684;
      const expectedHash = profileScenario === "read_heavy_24" ? "563075c35e48a653df726ebaca4d9064c7a8e818ffa88eed43737a73fcb5eccb" : "564498bf81e6aa2146ed0f5afbe4d9b43c115b74f6f082cd88cad3a1b1127a4a";
      const tail = profileScenario === "read_heavy_24" ? "READ-HEAVY-216-TAIL" : "READ-HEAVY-217-TAIL";
      assert.equal(results.length, 1);
      assert.equal(Buffer.byteLength(results[0].payload), expectedBytes);
      assert.match(results[0].payload, new RegExp(`${tail}\\n`));
      assert.equal(createHash("sha256").update(results[0].payload).digest("hex"), expectedHash);
      if (results[0].diagnostics) {
        assert.equal(results[0].diagnostics.final.bytes, expectedBytes);
        assert.equal(results[0].diagnostics.final.hash, expectedHash);
      }
    }
    if (profileScenario === "read_heavy_parallel") {
      assert.equal(results.length, 2);
      assert.deepEqual(results.map((result: any) => Buffer.byteLength(result.payload)), [16070, 25684]);
      assert.deepEqual(results.map((result: any) => createHash("sha256").update(result.payload).digest("hex")), ["563075c35e48a653df726ebaca4d9064c7a8e818ffa88eed43737a73fcb5eccb", "564498bf81e6aa2146ed0f5afbe4d9b43c115b74f6f082cd88cad3a1b1127a4a"]);
      assert.match(results[0].payload, /READ-HEAVY-216-TAIL/);
      assert.match(results[1].payload, /READ-HEAVY-217-TAIL/);
    }
    if (scenario === "parallel_max") { assert.equal(results.length, 8); assert.ok(results.every((result: any) => result.payloadOutcome === "valid")); }
    if (scenario === "chain_max") { assert.equal(results.length, 20); assert.ok(results.every((result: any) => result.payloadOutcome === "valid")); }
    if (scenario === "chain_long") assert.equal(results[1].payload, "tail received");
    if (scenario === "parallel") assert.equal(new Set(results.map((result: any) => result.identity.runId)).size, 2);
    if (scenario === "signal") { assert.equal(results[0].signal, "SIGKILL"); assert.equal(results[0].exitCode, null); }
    if (scenario === "nonzero") assert.equal(results[0].exitCode, 7);
    if (["spawn_error", "write_cleanup_error"].includes(scenario)) assert.equal(results[0].processOutcome, "spawn_error");
    if (outcome !== "valid") assert.equal(results[scenario === "chain" ? 1 : 0].reviewVerdict, null);
    assert.ok(reports.length >= 2, scenario);
    assert.ok(reports.every((message) => message.details.display?.version === 1), scenario);
    const terminalReport = reports.find((message) => message.details.envelope.kind === (scenario.startsWith("chain") ? "chain" : "result")) ?? reports[0];
    const reasons: Record<string, RegExp> = { missing: /missing final/, invalid: /invalid reviewer JSON/, output_limit: /output limit/, protocol_invalid: /protocol_error: invalid_json/, protocol_partial: /protocol_error: partial_record/, protocol_overflow: /protocol_error: record_limit/, old_final: /missing final/, nonzero: /exit 7/, signal: /signal SIGKILL/, spawn_error: /spawn ENOSPC/, chain: /invalid reviewer JSON/ };
    if (reasons[scenario]) assert.match(terminalReport.details.display.failureReason, reasons[scenario], scenario);
    if (scenario === "protocol_partial" || scenario === "protocol_overflow") {
      const factFiles = readdirSync(relayFacts).filter((file) => file.endsWith(".json"));
      assert.equal(factFiles.length, 1);
      const wire = JSON.parse(readFileSync(join(relayFacts, factFiles[0]!), "utf8"));
      const stream = results[0].diagnostics.stream;
      assert.equal(stream.stdoutBytes, wire.stdoutBytes);
      assert.equal(stream.stdoutHash, wire.stdoutHash);
      assert.equal(stream.partialBytes, wire.partialBytes);
      assert.equal(stream.partialHash, wire.partialHash);
      assert.equal(stream.finalTextPresent, true);
      if (scenario === "protocol_partial") {
        const expected = { kind: "partial_record", offset: wire.stdoutBytes - wire.partialBytes };
        assert.deepEqual(stream.firstParserError, expected);
        assert.deepEqual(stream.lastParserError, expected);
        assert.deepEqual(stream.parserErrorCounters, { invalid_json: 0, invalid_event: 0, record_limit: 0, partial_record: 1 });
        assert.ok(wire.partialBytes > 0);
      } else {
        assert.deepEqual(stream.firstParserError, { kind: "record_limit", offset: 0 });
        assert.deepEqual(stream.lastParserError, { kind: "record_limit", offset: 0 });
        assert.deepEqual(stream.parserErrorCounters, { invalid_json: 0, invalid_event: 0, record_limit: 1, partial_record: 0 });
        assert.equal(wire.partialBytes, 0);
        assert.equal(wire.partialHash, createHash("sha256").update("").digest("hex"));
      }
    }
    if (scenario === "storage_error") assert.deepEqual(terminalReport.details.display.archive, { state: "unavailable", code: "EIO" });
    else if (!scenario.startsWith("delivery_")) {
      assert.equal(terminalReport.details.display.archive.state, "available", scenario);
      assert.equal(readFileSync(terminalReport.details.display.archive.reportPath, "utf8"), terminalReport.content, scenario);
      const privateDiagnostic = readFileSync(terminalReport.details.display.archive.diagnosticsPath, "utf8");
      assert.doesNotMatch(privateDiagnostic, /private thinking|private fixture|private malformed|private-partial|private diagnostic fault|private storage fault/);
    }
    assert.equal(rpc.childState.busyCount(), 0, scenario);
    assert.equal(rpc.childState.canFinish("done"), true, scenario);
    assert.ok(loaded.every((entry) => entry.data.file === provider));
    if (!scenario.startsWith("baseline_")) {
      const fs = await import("node:fs");
      const snapshotDir = join(sandbox, "sessions/subagent-runs");
      const snapshots = fs.readdirSync(snapshotDir).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(fs.readFileSync(join(snapshotDir, file), "utf8")));
      const ownedSnapshots = snapshots.filter((snapshot) => snapshot.ownerRunId === `owner-${scenario.replaceAll("_", "-")}`);
      assert.doesNotMatch(JSON.stringify(ownedSnapshots), /private thinking|private fixture|private malformed|private-partial|private diagnostic fault/);
      if (!["diagnostic_error", "spawn_error", "write_cleanup_error"].includes(scenario) && results[0].diagnostics?.snapshotStorage?.state !== "unavailable") {
        const childSnapshot = ownedSnapshots.find((snapshot) => snapshot.runId === results[0].identity.runId);
        assert.equal(childSnapshot.process.exitCode, results[0].exitCode, scenario);
        assert.equal(childSnapshot.resources.guard.path, join(sandbox, "src/guards.ts"));
        assert.equal(childSnapshot.resources.extension.path, runtimeExtension);
      }
    }
    console.log(JSON.stringify({ piVersion, scenario, cli: fileProvenance(runtimeCli), producer: fileProvenance(resolve(runtimeCli, "../modes/json-event.js")), extension: fileProvenance(runtimeExtension), baseSha: scenario.startsWith("baseline_") ? baselineSha : head, headSha: head, results: results.map((result: any) => ({ runId: result.identity.runId, processOutcome: result.processOutcome, payloadOutcome: result.payloadOutcome, finalBytes: Buffer.byteLength(result.payload), finalHash: createHash("sha256").update(result.payload).digest("hex"), exitCode: result.exitCode, signal: result.signal })) }));
    rpc.acceptTerminal();
  } finally {
    clearTimeout(timeout);
    await rpc?.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, priorEnv);
    rmSync(sandbox, { recursive: true, force: true });
  }
}

for (const [scenario, outcome] of cases) {
  test(`real Pi ${scenario} retains primary outcomes`, { timeout: scenario === "chain_max" || scenario.includes("read_heavy") ? 60000 : 30000 }, (t) =>
    runBoundedRuntimeCase(t, (signal) => runFaultScenario(scenario, outcome, signal)));
}
