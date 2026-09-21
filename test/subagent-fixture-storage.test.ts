import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appendRecoveryDecision } from "../src/workflow-incident-state.ts";
import { openDb } from "../src/db.ts";
import { sha256 } from "../src/subagent-runs.ts";
import { acknowledgeFixtureReports, createFixtureEngine, loadFixtureExtension, shutdownFixture, snapshotStoreManifest, withFixtureEnvironment, type FixtureEngine, type LoadedFixture, type SentFixtureMessage } from "./fixtures/subagent-fixture-engine.ts";
import { runBoundedRuntimeCase, untilAborted } from "./fixtures/bounded-runtime-case.ts";

const root = path.resolve(import.meta.dirname, "..");
const baselineRef = "d600d6aafc5a8aaca44589cc556fd1f50bc0a049";
const fixturePattern = "^(ordinary ACK UUID cancellation proves TERM and KILL cleanup without closing the runtime|D01 ordinary descendants inherit isolation and retain default session behavior|real loader keeps canonical reports byte-equivalent while renderer collapses and expands)$";
const worker = "---\nname: worker\ndescription: deterministic fixture worker\n---\nReturn deterministic output.\n";

async function waitFor(predicate: () => boolean, timeoutMs = 10000, label = "fixture condition"): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`${label} timed out`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function closeOf(proc: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve({ code: proc.exitCode, signal: proc.signalCode });
  return new Promise((resolve) => proc.once("close", (code, signal) => resolve({ code, signal })));
}

async function boundedStop(proc: ReturnType<typeof spawn>, emergency = false): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const pid = proc.pid;
  const groupAlive = () => {
    if (!emergency || !pid || process.platform === "win32") return false;
    try { process.kill(-pid, 0); return true; } catch { return false; }
  };
  const waitGroup = () => new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const inspect = () => {
      if (!groupAlive()) return resolve();
      if (Date.now() - started > 1000) return reject(new Error("owned fixture process group remained live"));
      setTimeout(inspect, 10);
    };
    inspect();
  });
  const signal = (value: NodeJS.Signals) => {
    if (emergency && pid && process.platform !== "win32") {
      try { process.kill(-pid, value); return; } catch {}
    }
    try { proc.kill(value); } catch {}
  };
  const finish = async (value: { code: number | null; signal: NodeJS.Signals | null }) => {
    if (groupAlive()) {
      signal("SIGKILL");
      await waitGroup();
    }
    return value;
  };
  if (proc.exitCode !== null || proc.signalCode !== null) return finish({ code: proc.exitCode, signal: proc.signalCode });
  const close = closeOf(proc);
  signal("SIGTERM");
  const graceful = await Promise.race([close.then((value) => ({ value })), new Promise<{ value?: undefined }>((resolve) => setTimeout(() => resolve({}), 1000))]);
  if (graceful.value) return finish(graceful.value);
  signal("SIGKILL");
  const forced = await Promise.race([close.then((value) => ({ value })), new Promise<{ value?: undefined }>((resolve) => setTimeout(() => resolve({}), 1000))]);
  if (!forced.value) throw new Error("owned fixture process did not close after SIGKILL");
  return finish(forced.value);
}

function latestDeliveries(fixture: LoadedFixture): any[] {
  return [...fixture.entries].reverse().find((entry) => entry.type === "yokemate-child-state")?.data?.deliveries ?? [];
}

async function emitContext(fixture: LoadedFixture, reports: readonly SentFixtureMessage[]): Promise<void> {
  const messages = reports.map(({ message }) => ({ role: "custom", timestamp: Date.now(), ...message }));
  for (const handler of fixture.extension.handlers.get("context") ?? []) await handler({ type: "context", messages } as never, fixture.ctx);
}

function reportManifest(engine: FixtureEngine): Array<{ name: string; bytes: number; hash: string }> {
  if (!fs.existsSync(engine.reportDir)) return [];
  const rows: Array<{ name: string; bytes: number; hash: string }> = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name !== ".lock") {
        const bytes = fs.readFileSync(file);
        rows.push({ name: path.relative(engine.reportDir, file), bytes: bytes.length, hash: sha256(bytes) });
      }
    }
  };
  visit(engine.reportDir);
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function auditFingerprint(engine: FixtureEngine): string {
  const db = openDb(path.join(engine.root, "yokemate.db"));
  try {
    const rows = db.prepare("SELECT id,candidate_id,ticket,action,input_hash,source_uid,source_session_id,source_runtime_id,code,blockers_json,reason,outcome,created_at FROM workflow_recovery_decision ORDER BY id").all();
    return sha256(rows.map((row) => JSON.stringify(row)).join("\n"));
  } finally {
    db.close();
  }
}

test("fixture context ACK and shutdown preserve delivery truth", async () => {
  const engine = createFixtureEngine({ label: "lifecycle", agents: { worker } });
  await withFixtureEnvironment(engine, { YOKEMATE_SUBAGENT_TEST_TARGET: engine.resources["subagent-report-child.js"] }, async () => {
    const fixture = await loadFixtureExtension(engine, { sessionId: "lifecycle-owner" });
    await fixture.tool.execute("lifecycle", { agent: "worker", task: "lifecycle report" }, undefined, () => undefined, fixture.ctx);
    await waitFor(() => fixture.sent.length === 2, 5000, "lifecycle reports");
    const [individual, aggregate] = fixture.sent;
    const canonical = fixture.sent.map(({ message }) => ({ path: message.details.display.archive.reportPath, hash: sha256(fs.readFileSync(message.details.display.archive.reportPath)) }));
    const corruptions = [
      { ...individual!.message, content: `${individual!.message.content} changed` },
      { ...individual!.message, details: { ...individual!.message.details, deliveryId: "0".repeat(64) } },
      { ...individual!.message, details: { ...individual!.message.details, envelopeHash: "0".repeat(64) } },
    ];
    for (const message of corruptions) for (const handler of fixture.extension.handlers.get("context") ?? []) await handler({ type: "context", messages: [{ role: "custom", timestamp: Date.now(), ...message }] } as never, fixture.ctx);
    assert.ok(latestDeliveries(fixture).every((delivery) => delivery.state === "enqueued"));
    await emitContext(fixture, [individual!]);
    assert.deepEqual(latestDeliveries(fixture).map((delivery) => delivery.state).sort(), ["enqueued", "observed"]);
    await acknowledgeFixtureReports(fixture, [individual!, aggregate!]);
    assert.ok(latestDeliveries(fixture).every((delivery) => delivery.state === "observed"));
    await acknowledgeFixtureReports(fixture, [individual!, aggregate!]);
    for (const report of fixture.sent) report.options.onYokemateSendError(report.options.yokemateSendId);
    assert.ok(latestDeliveries(fixture).every((delivery) => delivery.state === "observed"));
    for (const item of canonical) assert.equal(sha256(fs.readFileSync(item.path)), item.hash);
    const snapshots = snapshotStoreManifest(engine).map((entry) => JSON.parse(fs.readFileSync(path.join(engine.snapshotDir, entry.name), "utf8")));
    assert.equal(snapshots.length, 1);
    assert.ok(snapshots[0].lifecycle.processClosed);
    assert.ok(snapshots[0].lifecycle.deliveriesTerminal);
    assert.ok(snapshots[0].deliveries.every((delivery: any) => delivery.state === "observed"));
    await shutdownFixture(fixture);
  });

  const unknown = createFixtureEngine({ label: "unknown", agents: { worker } });
  await withFixtureEnvironment(unknown, { YOKEMATE_SUBAGENT_TEST_TARGET: unknown.resources["subagent-report-child.js"] }, async () => {
    const fixture = await loadFixtureExtension(unknown, { sessionId: "unknown-owner" });
    await fixture.tool.execute("unknown", { agent: "worker", task: "unacknowledged report" }, undefined, () => undefined, fixture.ctx);
    await waitFor(() => fixture.sent.length === 2, 5000, "unacknowledged reports");
    await shutdownFixture(fixture, { expectedDeliveryState: "delivery_unknown" });
    const snapshot = JSON.parse(fs.readFileSync(path.join(unknown.snapshotDir, snapshotStoreManifest(unknown)[0]!.name), "utf8"));
    assert.ok(snapshot.deliveries.every((delivery: any) => delivery.state === "delivery_unknown"));
    assert.equal(snapshot.lifecycle.deliveriesTerminal, true);
  });

  const failed = createFixtureEngine({ label: "body-error", agents: { worker } });
  const failedSocketPath = path.join(failed.runtimeDir, "body-error.sock");
  const failedSockets = new Set<Socket>();
  const failedEvents: any[] = [];
  let failedPid: number | undefined;
  const failedServer = createServer((socket) => {
    failedSockets.add(socket);
    socket.once("close", () => failedSockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const event = JSON.parse(buffer.slice(0, newline));
        failedEvents.push(event);
        failedPid ??= event.pid;
        buffer = buffer.slice(newline + 1);
      }
    });
  });
  await new Promise<void>((resolve) => failedServer.listen(failedSocketPath, resolve));
  try {
    await assert.rejects(withFixtureEnvironment(failed, { RUNTIME_SETTINGS_TEST_SOCKET: failedSocketPath, SUBAGENT_CANCEL_MODE: "term", YOKEMATE_SUBAGENT_TEST_TARGET: failed.resources["runtime-settings-child.mjs"] }, async () => {
      const fixture = await loadFixtureExtension(failed, { sessionId: "body-error-owner" });
      await fixture.tool.execute("body-error", { agent: "worker", task: "remain live during body error" }, undefined, () => undefined, fixture.ctx);
      await waitFor(() => failedEvents.some((event) => event.task?.includes("remain live during body error")), 5000, "body error live child");
      assert.doesNotThrow(() => process.kill(failedPid!, 0));
      throw new Error("intentional fixture body error");
    }), /intentional fixture body error/);
  } finally {
    for (const socket of failedSockets) socket.destroy();
    await new Promise<void>((resolve) => failedServer.close(() => resolve()));
  }
  assert.ok(failedPid);
  assert.throws(() => process.kill(failedPid!, 0));
  assert.equal(fs.existsSync(failed.root), false);
});

interface PersistentEngine extends FixtureEngine {
  dependencyRoot: string;
}

function createPersistentEngine(sourceRef?: string): PersistentEngine {
  const seed = createFixtureEngine({ label: "dependency-seed", agents: { worker } });
  const dependencyRoot = seed.dependencyRoot;
  fs.rmSync(seed.root, { recursive: true, force: true });
  const outer = fs.mkdtempSync(path.join(tmpdir(), "ym245-persistent-"));
  if (sourceRef) {
    const archive = execFileSync("git", ["archive", sourceRef, "src", ".pi/extensions/subagent", "test/subagent-report-loader.test.ts", "test/fixtures/subagent-json-relay.mjs", "test/fixtures/subagent-report-child.js", "test/fixtures/runtime-settings-child.mjs", "test/fixtures/subagent-widget-child.js", "test/fixtures/coordinator-report-child.ts"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", outer], { input: archive });
  } else {
    fs.cpSync(path.join(root, "src"), path.join(outer, "src"), { recursive: true });
    fs.cpSync(path.join(root, ".pi/extensions/subagent"), path.join(outer, ".pi/extensions/subagent"), { recursive: true });
    fs.mkdirSync(path.join(outer, "test"), { recursive: true });
    fs.copyFileSync(path.join(root, "test/subagent-report-loader.test.ts"), path.join(outer, "test/subagent-report-loader.test.ts"));
    fs.cpSync(path.join(root, "test/fixtures"), path.join(outer, "test/fixtures"), { recursive: true });
  }
  fs.mkdirSync(path.join(outer, ".pi/agents"), { recursive: true });
  fs.mkdirSync(path.join(outer, "agent/extensions"), { recursive: true });
  fs.mkdirSync(path.join(outer, "home"), { recursive: true });
  fs.mkdirSync(path.join(outer, "tmp"), { recursive: true });
  fs.mkdirSync(path.join(outer, "runtime"), { recursive: true });
  fs.mkdirSync(path.join(outer, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(outer, ".pi/settings.json"), "{}");
  fs.writeFileSync(path.join(outer, ".pi/agents/worker.md"), worker);
  fs.symlinkSync(path.join(dependencyRoot, "node_modules"), path.join(outer, "node_modules"), "dir");
  fs.copyFileSync(path.join(root, "test/fixtures/subagent-runtime-provider.ts"), path.join(outer, "test/fixtures/subagent-runtime-provider.ts"));
  fs.copyFileSync(path.join(root, "test/fixtures/subagent-runtime-provider.ts"), path.join(outer, "agent/extensions/provider.ts"));
  return {
    root: outer,
    sourceRoot: outer,
    extensionPath: path.join(outer, ".pi/extensions/subagent/index.ts"),
    agentDir: path.join(outer, "agent"),
    sessionDir: path.join(outer, "sessions"),
    homeDir: path.join(outer, "home"),
    tmpDir: path.join(outer, "tmp"),
    runtimeDir: path.join(outer, "runtime"),
    snapshotDir: path.join(outer, "sessions/subagent-runs"),
    reportDir: path.join(outer, ".pi/subagent-reports"),
    dependencyRoot,
    resources: {
      "subagent-json-relay.mjs": path.join(outer, "test/fixtures/subagent-json-relay.mjs"),
      "subagent-report-child.js": path.join(outer, "test/fixtures/subagent-report-child.js"),
      "runtime-settings-child.mjs": path.join(outer, "test/fixtures/runtime-settings-child.mjs"),
      "subagent-widget-child.js": path.join(outer, "test/fixtures/subagent-widget-child.js"),
      "subagent-runtime-provider.ts": path.join(outer, "test/fixtures/subagent-runtime-provider.ts"),
    },
    loaded: [],
  };
}

export async function runFixturePass(engine: PersistentEngine, signal: AbortSignal): Promise<{ code: number; stderr: string }> {
  const proc = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--test", `--test-name-pattern=${fixturePattern}`, "test/subagent-report-loader.test.ts"], {
    cwd: engine.root,
    env: { PATH: process.env.PATH, HOME: engine.homeDir, TMPDIR: engine.tmpDir, XDG_RUNTIME_DIR: engine.runtimeDir, YM245_FIXTURE_DEPENDENCY_ROOT: engine.dependencyRoot },
    stdio: ["ignore", "ignore", "pipe"],
    detached: process.platform !== "win32",
  });
  let stderr = "";
  proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    const close = await untilAborted(closeOf(proc), signal);
    if (close.signal) throw new Error(`fixture pass signaled ${close.signal}`);
    return { code: close.code ?? -1, stderr };
  } finally {
    await boundedStop(proc, true);
  }
}

interface ProbeResult {
  ack: any;
  result: any;
  batch: any;
  snapshot?: any;
  snapshots: ReturnType<typeof snapshotStoreManifest>;
  reports: ReturnType<typeof reportManifest>;
  phases: any[];
  close: { code: number | null; signal: NodeJS.Signals | null };
}

export async function runSnapshotProbe(engine: PersistentEngine, signal: AbortSignal): Promise<ProbeResult> {
  const socketPath = path.join(engine.runtimeDir, `probe-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`);
  const sockets = new Set<Socket>();
  const phases: any[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      phases.push(JSON.parse(buffer.slice(0, newline)));
      socket.end("release\n");
    });
  });
  await untilAborted(new Promise<void>((resolve) => server.listen(socketPath, resolve)), signal);
  const piPackage = fs.realpathSync(path.join(engine.dependencyRoot, "node_modules/@earendil-works/pi-coding-agent"));
  const cli = path.join(piPackage, "dist/cli.js");
  const provider = path.join(engine.root, "test/fixtures/subagent-runtime-provider.ts");
  const proc = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session", "--no-extensions", "-e", provider, "-e", engine.extensionPath, "--model", "ym204-fixture/deterministic:high"], {
    cwd: engine.root,
    env: {
      PATH: process.env.PATH,
      HOME: engine.homeDir,
      TMPDIR: engine.tmpDir,
      XDG_RUNTIME_DIR: engine.runtimeDir,
      PI_CODING_AGENT_DIR: engine.agentDir,
      PI_CODING_AGENT_SESSION_DIR: engine.sessionDir,
      YM204_FIXTURE_SOCKET: socketPath,
      YM204_FIXTURE_SCENARIO: "snapshot_probe",
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const events: any[] = [];
  let stdout = "";
  let stderr = "";
  proc.stdout!.on("data", (chunk) => {
    stdout += chunk.toString();
    for (;;) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      try { events.push(JSON.parse(line)); } catch {}
    }
  });
  proc.stderr!.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    proc.stdin!.write(JSON.stringify({ id: "snapshot-probe", type: "prompt", message: "Run the snapshot probe." }) + "\n");
    await waitFor(() => events.some((event) => event.type === "tool_execution_end" && event.toolName === "subagent") && events.filter((event) => event.type === "message_end" && event.message?.details?.envelope).some((event) => event.message.details.envelope.kind === "batch") && events.some((event) => event.type === "entry_appended" && event.entry?.customType === "yokemate-child-state" && event.entry.data?.deliveries?.length === 2 && event.entry.data.deliveries.every((delivery: any) => delivery.state === "observed")), 15000, `snapshot probe ${stderr.slice(-1000)}`);
    const ack = events.find((event) => event.type === "tool_execution_end" && event.toolName === "subagent")!.result.details;
    const messages = events.filter((event) => event.type === "message_end" && event.message?.details?.envelope).map((event) => event.message);
    const result = messages.find((message) => message.details.envelope.kind === "result")!;
    const batch = messages.find((message) => message.details.envelope.kind === "batch")!;
    assert.equal(result.details.envelope.identity.runId, ack.children[0].identity.runId);
    assert.equal(batch.details.envelope.results[0].identity.runId, ack.children[0].identity.runId);
    assert.equal(result.content, fs.readFileSync(result.details.display.archive.reportPath, "utf8"));
    const close = await untilAborted(boundedStop(proc), signal);
    const snapshots = snapshotStoreManifest(engine);
    const name = `${ack.children[0].identity.ownerRunId}-${ack.children[0].identity.runId}.json`;
    const item = snapshots.find((entry) => entry.name === name);
    const snapshot = item ? JSON.parse(fs.readFileSync(path.join(engine.snapshotDir, item.name), "utf8")) : undefined;
    return { ack, result, batch, snapshot, snapshots, reports: reportManifest(engine), phases, close };
  } finally {
    await boundedStop(proc, true);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function recordAuditBaseline(engine: PersistentEngine): string {
  const db = openDb(path.join(engine.root, "yokemate.db"));
  try {
    appendRecoveryDecision(db, { candidateId: "missing-fixture-candidate", ticket: "YM-245", action: "accept-plan-scout-input", inputHash: sha256("fixture audit input"), sourceUid: process.getuid!(), sourceSessionId: "fixture-session", sourceRuntimeId: "fixture-runtime", code: "candidate-unavailable", blockers: ["candidate-unavailable"], reason: "Fixture candidate is intentionally unavailable.", outcome: "refusal" });
  } finally {
    db.close();
  }
  return auditFingerprint(engine);
}

test("fixture isolation preserves live and held-delivery evidence", { timeout: 90000 }, (t) => runBoundedRuntimeCase(t, async (signal) => {
  const engine = createPersistentEngine();
  const socketPath = path.join(engine.runtimeDir, "held-child.sock");
  const sockets = new Set<Socket>();
  const events: any[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline >= 0) events.push({ ...JSON.parse(buffer.slice(0, newline)), socket });
    });
  });
  await untilAborted(new Promise<void>((resolve) => server.listen(socketPath, resolve)), signal);
  try {
    await withFixtureEnvironment(engine, { RUNTIME_SETTINGS_TEST_SOCKET: socketPath, YOKEMATE_SUBAGENT_TEST_TARGET: engine.resources["runtime-settings-child.mjs"] ?? path.join(engine.root, "test/fixtures/runtime-settings-child.mjs") }, async () => {
      const fixture = await loadFixtureExtension(engine, { sessionId: "preservation-owner" });
      const liveAck = await fixture.tool.execute("live", { agent: "worker", task: "held live child" }, undefined, () => undefined, fixture.ctx);
      await waitFor(() => events.length === 1, 5000, "live child barrier");
      const liveRunId = liveAck.details.children[0].identity.runId;
      await waitFor(() => snapshotStoreManifest(engine).some((entry) => entry.name.endsWith(`-${liveRunId}.json`)), 5000, "live snapshot");
      process.env.YOKEMATE_SUBAGENT_TEST_TARGET = path.join(engine.root, "test/fixtures/subagent-report-child.js");
      await fixture.tool.execute("held-delivery", { agent: "worker", task: "closed child with held delivery" }, undefined, () => undefined, fixture.ctx);
      await waitFor(() => fixture.sent.length === 2, 5000, "held delivery reports");
      const audit = recordAuditBaseline(engine);
      const snapshots = snapshotStoreManifest(engine);
      const reports = reportManifest(engine);
      const values = snapshots.map((entry) => JSON.parse(fs.readFileSync(path.join(engine.snapshotDir, entry.name), "utf8")));
      assert.ok(values.some((value) => value.runId === liveRunId && value.lifecycle.processClosed === false));
      assert.ok(values.some((value) => value.runId !== liveRunId && value.lifecycle.processClosed === true && value.deliveries.some((delivery: any) => delivery.state === "enqueued")));
      for (let i = 0; i < 3; i++) {
        const outcome = await runFixturePass(engine, signal);
        assert.equal(outcome.code, 0, outcome.stderr.slice(-2000));
      }
      assert.deepEqual(snapshotStoreManifest(engine), snapshots);
      assert.deepEqual(reportManifest(engine), reports);
      assert.equal(auditFingerprint(engine), audit);
      events[0]!.socket.end("release\n");
      await waitFor(() => fixture.sent.length === 4, 5000, "released live reports");
      await acknowledgeFixtureReports(fixture, fixture.sent);
      await shutdownFixture(fixture);
      assert.ok(snapshotStoreManifest(engine).every((entry) => {
        const value = JSON.parse(fs.readFileSync(path.join(engine.snapshotDir, entry.name), "utf8"));
        return value.lifecycle.processClosed && value.lifecycle.deliveriesTerminal;
      }));
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(engine.root, { recursive: true, force: true });
  }
}));

test("real loader fixtures leave persistent engine snapshot capacity", { timeout: 120000 }, (t) => runBoundedRuntimeCase(t, async (signal) => {
  const sourceRef = process.env.YM245_FIXTURE_SOURCE_REF;
  const engine = createPersistentEngine(sourceRef);
  try {
    const audit = recordAuditBaseline(engine);
    const passes: Array<{ snapshots: number; bytes: number; reports: number }> = [];
    for (let i = 0; i < 3; i++) {
      const outcome = await runFixturePass(engine, signal);
      assert.equal(outcome.code, 0, outcome.stderr.slice(-2000));
      const manifest = snapshotStoreManifest(engine);
      passes.push({ snapshots: manifest.length, bytes: manifest.reduce((sum, entry) => sum + entry.bytes, 0), reports: reportManifest(engine).length });
    }
    if (sourceRef) {
      assert.deepEqual(passes.map((pass) => pass.snapshots), [14, 28, 40]);
      const owners = snapshotStoreManifest(engine).map((entry) => JSON.parse(fs.readFileSync(path.join(engine.snapshotDir, entry.name), "utf8")).ownerSessionId);
      assert.deepEqual({ cancel: owners.filter((owner) => owner === "cancel-owner").length, isolation: owners.filter((owner) => owner === "isolation-session").length, loader: owners.filter((owner) => owner === "loader-session").length }, { cancel: 6, isolation: 12, loader: 22 });
    } else {
      assert.deepEqual(passes.map((pass) => pass.snapshots), [0, 0, 0]);
      assert.deepEqual(passes.map((pass) => pass.reports), [0, 0, 0]);
    }
    assert.equal(auditFingerprint(engine), audit);
    const first = await runSnapshotProbe(engine, signal);
    assert.ok(first.result.details.envelope.payload.length > 0);
    assert.equal(first.result.details.envelope.diagnostics.snapshotStorage.state, sourceRef ? "unavailable" : "available");
    if (sourceRef) {
      assert.equal(first.result.details.envelope.diagnostics.snapshotStorage.code, "storage_limit");
      console.log(JSON.stringify({ stage: "red", baseSha: sourceRef, node: process.version, pi: "0.85.1", engine: fs.realpathSync(engine.root), dependencyRoot: fs.realpathSync(engine.dependencyRoot), passes, probe: { ownerRunId: first.ack.children[0].identity.ownerRunId, runId: first.ack.children[0].identity.runId, batchId: first.ack.batchId, snapshotState: first.result.details.envelope.diagnostics.snapshotStorage, canonicalBytes: Buffer.byteLength(first.result.content), canonicalHash: sha256(first.result.content), reportCount: first.reports.length }, audit }));
    }
    assert.ok(first.snapshot, `snapshot unavailable: ${JSON.stringify(first.result.details.envelope.diagnostics.snapshotStorage)}`);
    assert.equal(first.snapshot.snapshotStorage.state, "available");
    assert.equal(first.snapshot.resources.extension.hash, sha256(fs.readFileSync(engine.extensionPath)));
    const firstName = `${first.ack.children[0].identity.ownerRunId}-${first.ack.children[0].identity.runId}.json`;

    if (!sourceRef) {
      for (let i = 0; i < 3; i++) {
        const outcome = await runFixturePass(engine, signal);
        assert.equal(outcome.code, 0, outcome.stderr.slice(-2000));
      }
      const second = await runSnapshotProbe(engine, signal);
      assert.ok(second.snapshot);
      assert.ok(second.snapshots.some((entry) => entry.name === firstName));
      const secondName = `${second.ack.children[0].identity.ownerRunId}-${second.ack.children[0].identity.runId}.json`;
      const restarted = await runSnapshotProbe(engine, signal);
      assert.ok(restarted.snapshot);
      assert.ok(restarted.snapshots.some((entry) => entry.name === firstName));
      assert.ok(restarted.snapshots.some((entry) => entry.name === secondName));
      assert.equal(restarted.snapshots.length, 3);
      assert.ok(restarted.reports.length >= 6);
      assert.equal(auditFingerprint(engine), audit);
      console.log(JSON.stringify({ stage: "green", baseSha: baselineRef, fixSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), node: process.version, pi: "0.85.1", engine: fs.realpathSync(engine.root), dependencyRoot: fs.realpathSync(engine.dependencyRoot), passes, probes: [first, second, restarted].map((probe) => ({ ownerRunId: probe.ack.children[0].identity.ownerRunId, runId: probe.ack.children[0].identity.runId, batchId: probe.ack.batchId, snapshotState: probe.result.details.envelope.diagnostics.snapshotStorage, snapshotCount: probe.snapshots.length, reportCount: probe.reports.length })), audit }));
    }
  } finally {
    fs.rmSync(engine.root, { recursive: true, force: true });
  }
}));
