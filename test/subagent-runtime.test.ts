import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { startCoordinatorRpc, type RpcEvent } from "../src/coordinator-rpc.ts";

const root = resolve(import.meta.dirname, "..");
const extension = join(root, ".pi/extensions/subagent/index.ts");
const provider = join(root, "test/fixtures/subagent-runtime-provider.ts");
const cli = realpathSync(join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"));

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
    assert.ok(phases.filter((p) => p.phase === "loaded").every((p) => p.data.file === provider));
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
  } finally {
    for (const socket of held.values()) socket.end("release\n");
    await rpc?.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, priorEnv);
    rmSync(sandbox, { recursive: true, force: true });
  }
});
