import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileProvenance } from "../src/subagent-runs.ts";
import { continueOwnedCoordinator, startCoordinatorRpc, type RpcEvent } from "../src/coordinator-rpc.ts";
import { runBoundedRuntimeCase, untilAborted } from "./fixtures/bounded-runtime-case.ts";

const root = resolve(import.meta.dirname, "..");
const extension = join(root, ".pi/extensions/subagent/index.ts");
const provider = join(root, "test/fixtures/subagent-runtime-provider.ts");
const piVersion = JSON.parse(readFileSync(join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version;
const cli = realpathSync(join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"));

test("real runtime keeps merge and ship finalization on owned parent control operations", () => {
  const source = readFileSync(extension, "utf8");
  assert.match(source, /name: "coordinator_merge"/);
  assert.match(source, /requestShipFinalize\(ENGINE_ROOT, runId/);
  assert.match(source, /finalizeShip: async \(runId, finalizeOrigin\)/);
  assert.ok(source.indexOf("requestShipFinalize(ENGINE_ROOT, runId") < source.indexOf("outcome proposed"));
});

test("real Pi correlates delayed A batch after B admission and keeps B owned", { timeout: 30000 }, async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ym204-runtime-"));
  const cwd = join(sandbox, "cwd");
  const agentDir = join(sandbox, "agent");
  mkdirSync(join(cwd, ".pi/agents"), { recursive: true });
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  symlinkSync(provider, join(agentDir, "extensions/provider.ts"));
  writeFileSync(join(cwd, ".pi/agents/task-reviewer.md"), "---\nname: task-reviewer\ndescription: Deterministic transport fixture\ntools: read\n---\nReturn reviewer JSON.\n");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const priorEnv = { ...process.env };
  for (const key of Object.keys(process.env)) if (key !== "PATH") delete process.env[key];
  Object.assign(process.env, { HOME: sandbox, PI_CODING_AGENT_DIR: agentDir, YM204_FIXTURE_SOCKET: join(sandbox, "barrier.sock"), YM204_FIXTURE_REVIEW_CWD: root, YM204_FIXTURE_BASE: head, YM204_FIXTURE_HEAD: head });
  const events: RpcEvent[] = [];
  const phases: any[] = [];
  const held = new Map<string, Socket>();
  const sockets = new Set<Socket>();
  let wake: (() => void) | undefined;
  let oldBatch = false;
  let tearingDown = false;
  let bWorking = false;
  let settledWithB = false;
  let releaseB = false;
  let pendingB = false;
  let observedB = false;
  let resolvePending!: () => void;
  let resolveObserved!: () => void;
  const pendingBarrier = new Promise<void>((resolve) => { resolvePending = resolve; });
  const observedBarrier = new Promise<void>((resolve) => { resolveObserved = resolve; });
  const reached = new Promise<void>((resolve) => { wake = resolve; });
  const check = () => { if (oldBatch && bWorking && settledWithB) wake?.(); };
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
      if (message.phase === "context" && releaseB && !pendingB && message.data.some((report: any) => report.details?.envelope?.identity?.batchId === "batch-B")) {
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
    rpc = startCoordinatorRpc({ mode: "do", tickets: ["YM-204"], model: "ym204-fixture/deterministic:high", cwd, plans: {}, parts: [], prompt: "work", skillsPath: join(root, ".pi/skills"), resourcesPath: root } as any,
      { runId: "runtime-owner", parentSessionId: "fixture-parent", mode: "do", ticket: "YM-204", project: [], role: "coordinator", cwd, model: "ym204-fixture/deterministic:high" },
      { provider: "ym204-fixture", id: "deterministic", thinkingLevel: "high" },
      { onEvent(event) { events.push(event); if (event.type === "agent_settled" && oldBatch) { settledWithB = true; check(); }
        const state = event.type === "entry_appended" && (event.entry as any)?.customType === "yokemate-child-state" ? (event.entry as any).data : undefined;
        if (rpc && !observedB && !tearingDown) continueOwnedCoordinator(rpc, event, (reason) => assert.fail(`unexpected parent blocked: ${reason}`));
        if (state && releaseB && state.children.length === 0 && state.deliveries.filter((delivery: any) => delivery.batchId === "batch-B").length === 2 && state.deliveries.every((delivery: any) => delivery.state === "observed")) { observedB = true; resolveObserved(); } } },
      { invocation: { command: process.execPath, args: [cli, "--mode", "rpc", "--no-session", "--no-extensions", "-e", provider, "-e", extension, "--skill", join(root, ".pi/skills"), "--model", "ym204-fixture/deterministic:high"] }, readyTimeoutMs: 10000, stopGraceMs: 50 });
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
    assert.equal(phases.find((p) => p.phase === "loaded" && p.role === "coordinator").data.tools.find((tool: any) => tool.name === "subagent")?.path, extension);
    assert.ok(phases.filter((p) => p.phase === "loaded").every((p) => p.data.commands.find((command: any) => command.name === "yokemate-coordinator-ready")?.path === extension), JSON.stringify(phases.filter((p) => p.phase === "loaded").map((p) => p.data)));
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
    console.log(JSON.stringify({ piVersion, scenario: "delayed-A-B", extension: fileProvenance(extension), guard: fileProvenance(join(root, "src/guards.ts")), baseSha: head, headSha: head, ack: [a, b], order: events.filter((event) => event.type === "entry_appended" && (event.entry as any)?.customType === "yokemate-child-state").map((event) => (event.entry as any).data), terminal: envelope, observed: true, modelThinking: phases.filter((p) => p.phase === "loaded").map((p) => ({ model: p.data.model, thinking: p.data.thinking, sessionId: p.data.sessionId })) }));
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
  ["parallel_max", "output_limit"], ["chain_max", "output_limit"], ["parent_cancel", "incomplete"], ["parallel", "valid"], ["chain_long", "valid"], ["chain", "invalid_reviewer_json"], ["missing", "missing_final"], ["invalid", "invalid_reviewer_json"],
  ["output_limit", "output_limit"], ["protocol_invalid", "protocol_error"], ["protocol_partial", "protocol_error"], ["protocol_overflow", "protocol_error"],
  ["old_final", "missing_final"], ["retry", "valid"], ["nonzero", "incomplete"], ["signal", "incomplete"], ["spawn_error", "incomplete"], ["cleanup_error", "valid"], ["diagnostic_error", "valid"], ["storage_error", "valid"], ["delivery_sync", "delivery_failed"], ["delivery_async", "delivery_failed"],
] as const;

async function runFaultScenario(scenario: typeof cases[number][0], outcome: typeof cases[number][1], signal: AbortSignal): Promise<void> {
  const sandbox = mkdtempSync(join(tmpdir(), "ym204-fault-"));
  const cwd = join(sandbox, "cwd");
  const agentDir = join(sandbox, "agent");
  const folder = join(sandbox, "home/knowledge/org/repo/ai/task");
  mkdirSync(join(cwd, ".pi/agents"), { recursive: true });
  mkdirSync(join(sandbox, ".pi/agents"), { recursive: true });
  mkdirSync(join(sandbox, "tmp"), { recursive: true });
  mkdirSync(folder, { recursive: true });
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  symlinkSync(provider, join(agentDir, "extensions/provider.ts"));
  writeFileSync(join(cwd, ".pi/agents/task-reviewer.md"), "---\nname: task-reviewer\ndescription: Deterministic transport fixture\ntools: read\n---\nReturn reviewer JSON.\n");
  writeFileSync(join(cwd, ".pi/agents/worker.md"), "---\nname: worker\ndescription: Deterministic transport fixture\ntools: read\n---\nReturn the requested output.\n");
  writeFileSync(join(sandbox, ".pi/agents/do-coordinator.md"), "Fixture coordinator");
  writeFileSync(join(folder, "plan.md"), "fixture plan");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const priorEnv = { ...process.env };
  for (const key of Object.keys(process.env)) if (key !== "PATH") delete process.env[key];
  Object.assign(process.env, { HOME: sandbox, TMPDIR: join(sandbox, "tmp"), PI_CODING_AGENT_DIR: agentDir, YM204_FIXTURE_SOCKET: join(sandbox, "barrier.sock"), YM204_FIXTURE_REVIEW_CWD: root, YM204_FIXTURE_BASE: head, YM204_FIXTURE_HEAD: head, YM204_FIXTURE_SCENARIO: scenario, YM204_FIXTURE_READ_FILE: join(folder, "plan.md") });
  const sockets = new Set<Socket>();
  const loaded: any[] = [];
  let working!: () => void;
  const childWorking = new Promise<void>((resolve) => { working = resolve; });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const event = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      if (event.phase === "loaded") loaded.push(event);
      if (scenario === "parent_cancel" && event.phase === "child-working") working();
      else if (scenario === "signal" && event.phase === "child-working") process.kill(event.data.pid, "SIGKILL");
      else socket.end("release\n");
    });
  });
  let rpc: ReturnType<typeof startCoordinatorRpc> | undefined;
  let complete!: () => void;
  const delivered = new Promise<void>((resolve) => { complete = resolve; });
  let markAsyncUpdated!: () => void;
  const asyncUpdated = new Promise<void>((resolve) => { markAsyncUpdated = resolve; });
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
        const message = event.type === "message_end" ? event.message as any : undefined;
        const envelope = message?.details?.envelope;
        if (envelope) reports.push(message);
        if (envelope?.kind === "batch") batch = envelope;
        if (event.type === "entry_appended" && (event.entry as any)?.customType === "yokemate-child-state") {
          const state = (event.entry as any).data;
          if (scenario === "delivery_async" && state.deliveries.length && state.deliveries.every((delivery: any) => delivery.state === "delivery_unknown")) markAsyncUpdated();
          if (batch && !state.children.length && state.deliveries.length && state.deliveries.every((delivery: any) => delivery.state === "observed")) complete();
        }
      }, onBlocked(reason) { failureReason = reason; complete(); } },
      { invocation: { command: process.execPath, args: [cli, "--mode", "rpc", "--no-session", "--no-extensions", "-e", provider, "-e", extension, "--skill", join(root, ".pi/skills"), "--model", "ym204-fixture/deterministic:high"] }, readyTimeoutMs: 10000, stopGraceMs: scenario === "parent_cancel" ? 5000 : 50 });
    await untilAborted(rpc.ready, signal);
    await untilAborted(rpc.request({ type: "prompt", message: "work" }), signal);
    if (scenario === "parent_cancel") {
      await untilAborted(childWorking, signal);
      rpc.acceptTerminal();
      await rpc.stop("parent_control_cancel");
      const fs = await import("node:fs");
      const snapshots = fs.readdirSync(join(folder, "reviewer-runs")).map((file) => JSON.parse(fs.readFileSync(join(folder, "reviewer-runs", file), "utf8")));
      const child = snapshots.find((snapshot) => snapshot.identity?.agent === "task-reviewer");
      assert.equal(child.completed, true);
      assert.equal(child.terminal.processOutcome, "cancelled");
      assert.equal(child.cancellationInitiator, "parent_control_cancel");
      assert.equal(child.stream.phase, "thinking");
      assert.ok(child.stream.stdoutBytes > 0);
      assert.ok(child.sessionId);
      assert.equal(child.effective.model, "unknown");
      assert.ok(child.closeAt);
      return;
    }
    await untilAborted(Promise.race([delivered, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`${scenario}: report not observed`)), 10000); })]), signal);
    if (scenario.startsWith("delivery_")) {
      assert.match(failureReason!, /report delivery failure; unobserved IDs:/);
      assert.equal(rpc.childState.canFinish("done"), false);
      assert.equal(rpc.childState.canFinish("blocked", failureReason), true);
      assert.equal(rpc.events.filter((event) => event.type === "tool_execution_start" && event.toolName === "subagent").length, 1);
      assert.equal(rpc.childState.pendingIds().length, 2);
      if (scenario === "delivery_async") {
        assert.ok(rpc.events.some((event) => event.type === "extension_error" && event.event === "send_message"));
        await untilAborted(asyncUpdated, signal);
        assert.equal(rpc.childState.pendingIds().length, 2);
        for (const deliveryId of rpc.childState.pendingIds()) {
          const archived = JSON.parse(readFileSync(join(root, ".pi/subagent-reports", deliveryId, "diagnostics.json"), "utf8"));
          assert.equal(archived.diagnostics.delivery.state, "delivery_unknown");
        }
      }
      rpc.acceptTerminal();
      return;
    }
    assert.equal(failureReason, undefined, scenario);
    assert.ok(batch, scenario);
    const results = batch.results;
    assert.equal(results[scenario === "chain" ? 1 : 0].payloadOutcome, outcome, scenario);
    if (scenario === "chain") {
      assert.equal(results.length, 3);
      assert.equal(results[0].payloadOutcome, "valid");
      assert.equal(results[2].processOutcome, "not_started");
      assert.notEqual(results[1].actualTaskHash, results[1].identity.taskHash);
    }
    if (scenario === "parallel_max") { assert.equal(results.length, 8); assert.ok(results.every((result: any) => result.payloadOutcome === "output_limit")); }
    if (scenario === "chain_max") { assert.equal(results.length, 20); assert.ok(results.slice(1).every((result: any) => result.processOutcome === "not_started")); }
    if (scenario === "chain_long") assert.equal(results[1].payload, "tail received");
    if (scenario === "parallel") assert.equal(new Set(results.map((result: any) => result.identity.runId)).size, 2);
    if (scenario === "signal") { assert.equal(results[0].signal, "SIGKILL"); assert.equal(results[0].exitCode, null); }
    if (scenario === "nonzero") assert.equal(results[0].exitCode, 7);
    if (scenario === "spawn_error") assert.equal(results[0].processOutcome, "spawn_error");
    if (outcome !== "valid") assert.equal(results[scenario === "chain" ? 1 : 0].reviewVerdict, null);
    assert.ok(reports.length >= 2, scenario);
    assert.ok(reports.every((message) => message.details.display?.version === 1), scenario);
    const terminalReport = reports.find((message) => message.details.envelope.kind === (scenario.startsWith("chain") ? "chain" : "result")) ?? reports[0];
    const reasons: Record<string, RegExp> = { missing: /missing final/, invalid: /invalid reviewer JSON/, output_limit: /output limit/, protocol_invalid: /parser invalid_json/, protocol_partial: /parser (?:partial_record|invalid_json)/, protocol_overflow: /parser (?:record_limit|invalid_json)/, old_final: /missing final/, nonzero: /exit 7/, signal: /signal SIGKILL/, spawn_error: /spawn ENOSPC/, chain: /invalid reviewer JSON/, chain_max: /output limit/ };
    if (reasons[scenario]) assert.match(terminalReport.details.display.failureReason, reasons[scenario], scenario);
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
    const fs = await import("node:fs");
    const snapshots = fs.readdirSync(join(folder, "reviewer-runs")).map((file) => JSON.parse(fs.readFileSync(join(folder, "reviewer-runs", file), "utf8")));
    assert.doesNotMatch(JSON.stringify(snapshots), /private thinking|private fixture|private malformed|private-partial|private diagnostic fault/);
    if (!["diagnostic_error", "spawn_error"].includes(scenario)) {
      const childSnapshot = snapshots.find((snapshot) => snapshot.identity?.runId === results[0].identity.runId);
      assert.equal(childSnapshot.terminal.exitCode, results[0].exitCode, scenario);
      assert.equal(childSnapshot.guard.path, join(root, "src/guards.ts"));
      assert.equal(childSnapshot.extension.path, extension);
      assert.equal(childSnapshot.effective.thinking, "unknown");
    }
    console.log(JSON.stringify({ piVersion, scenario, extension: fileProvenance(extension), baseSha: head, headSha: head, results: results.map((result: any) => ({ runId: result.identity.runId, processOutcome: result.processOutcome, payloadOutcome: result.payloadOutcome, exitCode: result.exitCode, signal: result.signal })) }));
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
  test(`real Pi ${scenario} retains primary outcomes`, { timeout: 30000 }, (t) =>
    runBoundedRuntimeCase(t, (signal) => runFaultScenario(scenario, outcome, signal)));
}
