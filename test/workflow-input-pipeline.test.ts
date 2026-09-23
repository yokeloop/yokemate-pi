import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { closeOwnedServer, stopOwnedProcess } from "./fixtures/runtime-resources.ts";

const source = join(import.meta.dirname, "..");
const baselineSha = "8b0c417989bf7dce8129f3e4f4f7b2f2ad7d1d46";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

interface FixtureEvent { phase: string; at: number; [key: string]: unknown }
class Driver {
  readonly process: ChildProcessWithoutNullStreams;
  private serial = 0;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly lines: Interface;
  private stopPromise?: Promise<void>;
  readonly stderr: Buffer[] = [];
  readonly ready: Promise<void>;
  constructor(root: string, env: NodeJS.ProcessEnv, command: string[]) {
    this.process = spawn("python3", [join(source, "test", "fixtures", "workflow-input-pty.py")], { cwd: root, env: { ...env, WORKFLOW_PTY_CWD: root, WORKFLOW_PTY_COMMAND: Buffer.from(JSON.stringify(command)).toString("base64") }, stdio: ["pipe", "pipe", "pipe"] });
    this.process.stderr.on("data", (chunk) => { this.stderr.push(Buffer.from(chunk)); if (this.stderr.reduce((sum, item) => sum + item.length, 0) > 64 * 1024) this.stderr.shift(); });
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    let ready = false;
    this.ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    this.lines = createInterface({ input: this.process.stdout });
    this.lines.on("line", (line) => {
      const value = JSON.parse(line);
      if (value.event === "ready") { ready = true; resolveReady(); return; }
      const pending = this.pending.get(value.id);
      if (pending) { clearTimeout(pending.timer); this.pending.delete(value.id); pending.resolve(value); }
    });
    const failed = (error: Error) => {
      if (!ready) rejectReady(error);
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
        this.pending.delete(id);
      }
    };
    this.process.once("error", (error) => failed(error));
    this.process.once("close", (code, signal) => { this.lines.close(); failed(new Error(`PTY helper closed before completion: code=${code} signal=${signal}`)); });
  }
  request(action: string, data: Record<string, unknown> = {}, timeout = 15000): Promise<any> {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`PTY command timed out: ${action}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ id, action, ...data }) + "\n", (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      if (this.process.exitCode === null && this.process.signalCode === null) await this.request("terminate", {}, 2000).catch(() => undefined);
      await stopOwnedProcess(this.process);
      this.lines.close();
    })();
    return this.stopPromise;
  }
}

async function createTarget(parent: string, kind: "baseline" | "head"): Promise<string> {
  const root = join(parent, kind);
  mkdirSync(root, { recursive: true });
  const archive = join(parent, `${kind}.tar`);
  execFileSync("git", ["-C", source, "archive", "--format=tar", `--output=${archive}`, baselineSha], { timeout: 30_000 });
  execFileSync("tar", ["-xf", archive, "-C", root], { timeout: 30_000 });
  if (kind === "head") {
    rmSync(join(root, "src"), { recursive: true, force: true });
    rmSync(join(root, ".pi", "extensions", "subagent"), { recursive: true, force: true });
    cpSync(join(source, "src"), join(root, "src"), { recursive: true });
    cpSync(join(source, ".pi", "extensions", "subagent"), join(root, ".pi", "extensions", "subagent"), { recursive: true });
  }
  symlinkSync(join(source, "node_modules"), join(root, "node_modules"), "dir");
  mkdirSync(join(root, "home", "knowledge"), { recursive: true });
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({ guardPolicy: { workflowApproval: false }, compaction: { enabled: false }, retry: { enabled: false }, quietStartup: true }));
  writeFileSync(join(root, ".env.local"), "");
  const planFolder = join(root, "home", "knowledge", "org", "repo", "ai", "YM-1-fixture");
  mkdirSync(planFolder, { recursive: true });
  const plan = join(planFolder, "plan.md");
  writeFileSync(plan, "# YM-1 — fixture\n\n## Goal\nExercise workflow input.\n\n## Affected repositories\n- `org/repo` — app\n\n## Steps\n1. Run.\n\n## Assumptions\n- Fixture.\n\n## Out of scope\n- Production.\n\n## Acceptance\nOne fixture run.\n");
  const clone = join(root, "clone");
  mkdirSync(clone);
  execFileSync("git", ["init", "-b", "main", clone], { stdio: "pipe", timeout: 30_000 });
  execFileSync("git", ["-C", clone, "config", "user.email", "fixture@example.invalid"], { timeout: 30_000 });
  execFileSync("git", ["-C", clone, "config", "user.name", "Fixture"], { timeout: 30_000 });
  writeFileSync(join(clone, "README.md"), "fixture\n");
  execFileSync("git", ["-C", clone, "add", "README.md"], { timeout: 30_000 });
  execFileSync("git", ["-C", clone, "commit", "-m", "fixture"], { stdio: "pipe", timeout: 30_000 });
  const db = openDb(join(root, "yokemate.db"));
  db.prepare("INSERT INTO project (org,repo,path,tracker,tracker_key,model) VALUES ('org','repo',?,'github','YM','workflow-input-fixture/deterministic')").run(clone);
  db.prepare("INSERT INTO work (ticket,url,stage,plan) VALUES ('YM-1','u','planned',?)").run(plan);
  db.close();
  return root;
}

type Scenario = "none" | "approval" | "ready-tool" | "none-tool" | "malformed-tool" | "error-tool" | "timeout-tool" | "near-timeout-tool" | "late-success-tool" | "hold-main";
interface CaseOptions { warning?: { needle: string; timeout: number }; trigger?: "new_input" | "active_interrupt" | "idle_interrupt" | "session_new" | "session_fork" | "session_reload" | "session_shutdown"; awaitLate?: boolean; awaitTool?: boolean; expectRun?: boolean }
async function runCase(root: string, scenario: Scenario, input: string, options: CaseOptions = {}): Promise<{ extractionCount: number; renderBeforeRelease: boolean; mainBeforeRelease: boolean; phases: string[]; elapsedMs?: number; runCount: number; reservedBeforeRelease: boolean; toolEndedBeforeRelease: boolean; sentinelVisible: boolean }> {
  const runtime = mkdtempSync(join(tmpdir(), "ym-workflow-input-runtime-"));
  const home = join(runtime, "home");
  const agent = join(runtime, "agent");
  const sessions = join(runtime, "sessions");
  mkdirSync(home, { recursive: true });
  mkdirSync(agent, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(agent, "auth.json"), "{}");
  writeFileSync(join(agent, "models.json"), "[]");
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ quietStartup: true, defaultProjectTrust: "always", compaction: { enabled: false }, retry: { enabled: false }, tuiMode: "regular" }));
  const socketPath = join(runtime, "events.sock");
  const events: FixtureEvent[] = [];
  const extractionSockets = new Set<Socket>();
  const mainSockets = new Set<Socket>();
  const acceptedSockets = new Set<Socket>();
  const releaseSocket = (socket: Socket) => { if (!socket.destroyed && !socket.writableEnded) socket.end("release\n"); };
  const server = createServer((socket) => {
    acceptedSockets.add(socket);
    socket.on("error", () => socket.destroy());
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const event = JSON.parse(buffer.slice(0, newline)) as FixtureEvent;
      events.push(event);
      if (event.phase === "extraction_enter") extractionSockets.add(socket);
      else if (event.phase === "main_enter" && scenario === "hold-main") mainSockets.add(socket);
      else releaseSocket(socket);
    });
    socket.on("close", () => { acceptedSockets.delete(socket); extractionSockets.delete(socket); mainSockets.delete(socket); });
  });
  server.listen(socketPath);
  await once(server, "listening");
  const salt = randomUUID();
  const readyMarker = `WF_READY_${sha(salt).slice(0, 20)}`;
  const renderMarker = `WF_RENDER_${sha(`${salt}:render`).slice(0, 20)}`;
  const mainMarker = `WF_MAIN_${sha(`${salt}:main`).slice(0, 20)}`;
  const cli = join(source, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  const command = [process.execPath, cli, "--approve", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-builtin-tools", "--session-dir", sessions, "--provider", "workflow-input-fixture", "--model", "deterministic", "-e", join(source, "test", "fixtures", "workflow-input-provider.ts"), "-e", join(root, ".pi", "extensions", "subagent", "index.ts")];
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    TMPDIR: runtime,
    PI_CODING_AGENT_DIR: agent,
    XDG_RUNTIME_DIR: runtime,
    PI_OFFLINE: "1",
    WORKFLOW_INPUT_SOCKET: socketPath,
    WORKFLOW_INPUT_SCENARIO: scenario,
    WORKFLOW_INPUT_READY_MARKER: readyMarker,
    WORKFLOW_INPUT_RENDER_MARKER: renderMarker,
    WORKFLOW_INPUT_MAIN_MARKER: mainMarker,
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
    YOKEMATE_SUBAGENT_TEST_RELAY: join(source, "test", "fixtures", "subagent-json-relay.mjs"),
    YOKEMATE_SUBAGENT_TEST_TARGET: join(source, "test", "fixtures", "workflow-rpc-child.mjs"),
  };
  const driver = new Driver(root, env, command);
  try {
    await driver.ready;
    assert.equal((await driver.request("wait", { needle: readyMarker, timeout: 15 }, 20000)).found, true, "real Pi editor never became ready");
    const inputStartedAt = Date.now();
    await driver.request("write", { text: input });
    await driver.request("enter");
    const extractionDeadline = Date.now() + 5000;
    while (!events.some((event) => event.phase === "extraction_enter") && Date.now() < extractionDeadline) {
      if (scenario === "none" && events.some((event) => event.phase === "main_enter")) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const renderBeforeRelease = (await driver.request("wait", { needle: renderMarker, timeout: 1.5 }, 5000)).found as boolean;
    const mainBeforeRelease = (await driver.request("wait", { needle: mainMarker, timeout: 1.5 }, 5000)).found as boolean;
    const reservedBeforeRelease = existsSync(join(root, "work")) && existsSync(join(root, "work", "YM-1"));
    const toolEndedBeforeRelease = events.some((event) => event.phase === "tool_end");
    if (options.trigger === "new_input") {
      await driver.request("write", { text: "Explain the current status" });
      await driver.request("enter");
    } else if (options.trigger === "active_interrupt" || options.trigger === "idle_interrupt") {
      await driver.request("key", { data: Buffer.from("\u001b").toString("base64") });
    } else if (options.trigger === "session_shutdown") {
      await driver.request("signal");
    } else if (options.trigger) {
      const commandName = { session_new: "/wf-new", session_fork: "/wf-fork", session_reload: "/wf-reload" }[options.trigger];
      await driver.request("write", { text: commandName });
      await driver.request("enter");
    }
    if (options.trigger === "session_shutdown") {
      const shutdownDeadline = Date.now() + 5000;
      while ((!events.some((event) => event.phase === "session_shutdown") || !events.some((event) => event.phase === "extraction_abort")) && Date.now() < shutdownDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(events.some((event) => event.phase === "session_shutdown"), `session shutdown hook did not run: ${JSON.stringify(events.map((event) => event.phase))}`);
      assert.ok(events.some((event) => event.phase === "extraction_abort"), `session shutdown did not fence held extraction: ${JSON.stringify(events.map((event) => event.phase))}`);
      assert.ok(extractionSockets.size > 0, "session shutdown released the provider before the lifecycle fence was observed");
      for (const socket of extractionSockets) releaseSocket(socket);
      const releaseDeadline = Date.now() + 5000;
      while (!events.some((event) => event.phase === "extraction_released") && Date.now() < releaseDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
    } else if (options.trigger) {
      const abortDeadline = Date.now() + 10000;
      while (!events.some((event) => event.phase === "extraction_abort") && Date.now() < abortDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(events.some((event) => event.phase === "extraction_abort"), `${options.trigger} did not abort extraction: ${JSON.stringify(events.map((event) => event.phase))}`);
    }
    for (const socket of extractionSockets) releaseSocket(socket);
    for (const socket of mainSockets) releaseSocket(socket);
    if (!mainBeforeRelease && options.trigger !== "session_shutdown") await driver.request("wait", { needle: mainMarker, timeout: 10 }, 15000);
    let elapsedMs: number | undefined;
    if (options.warning) {
      assert.equal((await driver.request("wait", { needle: options.warning.needle, timeout: options.warning.timeout }, (options.warning.timeout + 5) * 1000)).found, true);
      const inputEvent = events.find((event) => event.phase === "input");
      const abortEvent = events.find((event) => event.phase === "extraction_abort");
      elapsedMs = inputEvent && abortEvent ? abortEvent.at - inputEvent.at : Date.now() - inputStartedAt;
    }
    if (options.awaitLate) {
      const lateDeadline = Date.now() + 20000;
      while (!events.some((event) => event.phase === "extraction_late_after_abort") && Date.now() < lateDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(events.some((event) => event.phase === "extraction_late_after_abort"));
    }
    if (options.awaitTool) {
      const toolDeadline = Date.now() + 10000;
      while (!events.some((event) => event.phase === "tool_end") && Date.now() < toolDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(events.some((event) => event.phase === "tool_end"));
    }
    if (options.expectRun) {
      const runFile = join(root, "work", "YM-1", "fixture-runs");
      const runDeadline = Date.now() + 15000;
      while (!existsSync(runFile) && Date.now() < runDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(existsSync(runFile), `approved tool did not start a fixture run: ${JSON.stringify(events.filter((event) => event.phase === "tool_end" || event.phase === "extraction_enter" || event.phase === "main_enter"))}`);
    }
    const phaseDeadline = Date.now() + 2000;
    while ((!events.some((event) => event.phase === "turn_start") || !events.some((event) => event.phase === "message_start_user")) && Date.now() < phaseDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
    const runFile = join(root, "work", "YM-1", "fixture-runs");
    const runCount = existsSync(runFile) ? readFileSync(runFile, "utf8").trim().split("\n").filter(Boolean).length : 0;
    const terminalSnapshot = await driver.request("snapshot", { needles: ["SENTINEL_PRIVATE_PROVIDER_ERROR"] });
    const sentinelVisible = terminalSnapshot.contains[0] as boolean;
    return { extractionCount: events.filter((event) => event.phase === "extraction_enter").length, renderBeforeRelease, mainBeforeRelease, phases: events.map((event) => event.phase), elapsedMs, runCount, reservedBeforeRelease, toolEndedBeforeRelease, sentinelVisible };
  } finally {
    for (const socket of acceptedSockets) socket.destroy();
    await driver.stop();
    await closeOwnedServer(server, acceptedSockets);
    const removalDeadline = Date.now() + 2_000;
    while (existsSync(runtime)) {
      try { rmSync(runtime, { recursive: true, force: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || Date.now() >= removalDeadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }
}

test("real Pi TUI input pipeline is nonblocking and ordinary input skips extraction", { timeout: 300000 }, async () => {
  execFileSync("python3", ["-c", "import pty,termios,fcntl,selectors"], { timeout: 10_000 });
  const folder = mkdtempSync(join(tmpdir(), "ym-workflow-input-"));
  try {
    const baseline = await createTarget(folder, "baseline");
    const head = await createTarget(folder, "head");
    const ordinary = "Explain the status of YM-1";
    const baselineOrdinary = await runCase(baseline, "none", ordinary);
    assert.equal(baselineOrdinary.extractionCount, 1, `baseline ordinary case did not reproduce red contract: ${JSON.stringify({ phases: baselineOrdinary.phases })}`);
    assert.equal(baselineOrdinary.mainBeforeRelease, false, "baseline ordinary case unexpectedly reached main before extraction release");
    const headOrdinary = await runCase(head, "none", ordinary);
    assert.equal(headOrdinary.extractionCount, 0, `ordinary input performed extraction: ${JSON.stringify({ phases: headOrdinary.phases })}`);
    assert.equal(headOrdinary.renderBeforeRelease, true);
    assert.equal(headOrdinary.mainBeforeRelease, true);
    const candidate = "Plan and then do YM-1";
    const baselineCandidate = await runCase(baseline, "approval", candidate);
    assert.equal(baselineCandidate.extractionCount, 1);
    assert.equal(baselineCandidate.renderBeforeRelease, false, "baseline candidate did not reproduce blocked transcript");
    assert.equal(baselineCandidate.mainBeforeRelease, false, "baseline candidate did not reproduce blocked main provider");
    const headCandidate = await runCase(head, "approval", candidate);
    assert.equal(headCandidate.extractionCount, 1);
    assert.equal(headCandidate.renderBeforeRelease, true, `candidate transcript was blocked: ${JSON.stringify({ phases: headCandidate.phases })}`);
    assert.equal(headCandidate.mainBeforeRelease, true, `candidate main provider was blocked: ${JSON.stringify({ phases: headCandidate.phases })}`);
    assert.ok(headCandidate.phases.includes("turn_start"));
    assert.ok(headCandidate.phases.includes("message_start_user"));
    const freshHead = async (label: string) => {
      const parent = join(folder, label);
      mkdirSync(parent, { recursive: true });
      return createTarget(parent, "head");
    };
    const approved = await runCase(await freshHead("early-approved"), "ready-tool", "The plan is approved, run YM-1", { expectRun: true });
    assert.equal(approved.reservedBeforeRelease, false);
    assert.equal(approved.toolEndedBeforeRelease, false);
    assert.equal(approved.runCount, 1);
    for (const [label, scenario, outcome] of [["none", "none-tool", undefined], ["malformed", "malformed-tool", "invalid"], ["error", "error-tool", "model_error"]] as const) {
      const result = await runCase(await freshHead(`early-${label}`), scenario, candidate, { awaitTool: true, ...(outcome ? { warning: { needle: `workflow extraction unavailable: outcome=${outcome}`, timeout: 10 } } : {}) });
      assert.equal(result.reservedBeforeRelease, false, `${label} reserved before extraction settled`);
      assert.equal(result.toolEndedBeforeRelease, false, `${label} consumer refused before extraction settled`);
      assert.equal(result.runCount, 0, `${label} started a run`);
      if (label === "error") assert.equal(result.sentinelVisible, false, "provider exception leaked into the real PTY output");
      assert.doesNotMatch(JSON.stringify(result), /SENTINEL_PRIVATE_PROVIDER_ERROR/);
    }
    const timed = await runCase(await freshHead("timeout"), "timeout-tool", candidate, { warning: { needle: "workflow extraction unavailable: outcome=timeout", timeout: 18 }, awaitLate: true, awaitTool: true });
    assert.ok((timed.elapsedMs ?? 0) >= 14900, `timeout fired before the shared 15s budget: ${timed.elapsedMs}`);
    assert.ok((timed.elapsedMs ?? Infinity) < 15300, `timeout exceeded scheduler tolerance: ${timed.elapsedMs}`);
    assert.equal(timed.mainBeforeRelease, true);
    assert.equal(timed.reservedBeforeRelease, false);
    assert.equal(timed.toolEndedBeforeRelease, false);
    assert.equal(timed.runCount, 0);
    const nearDeadline = await runCase(await freshHead("near-timeout"), "near-timeout-tool", candidate, { warning: { needle: "workflow extraction unavailable: outcome=timeout", timeout: 18 }, awaitLate: true, awaitTool: true });
    assert.ok((nearDeadline.elapsedMs ?? 0) >= 14900 && (nearDeadline.elapsedMs ?? Infinity) < 15300, `near-deadline consumer renewed the budget: ${nearDeadline.elapsedMs}`);
    assert.equal(nearDeadline.runCount, 0);
    const late = await runCase(await freshHead("late-success"), "late-success-tool", candidate, { warning: { needle: "workflow extraction unavailable: outcome=timeout", timeout: 18 }, awaitLate: true, awaitTool: true });
    assert.equal(late.runCount, 0);
    for (const [label, scenario, trigger] of [
      ["session-shutdown", "approval", "session_shutdown"],
      ["new-input", "approval", "new_input"],
      ["active-interrupt", "hold-main", "active_interrupt"],
      ["idle-interrupt", "approval", "idle_interrupt"],
      ["session-new", "approval", "session_new"],
      ["session-fork", "approval", "session_fork"],
      ["session-reload", "approval", "session_reload"],
    ] as const) {
      const fenced = await runCase(await freshHead(label), scenario, candidate, { trigger });
      assert.ok(fenced.phases.includes(trigger === "session_shutdown" ? "session_shutdown" : "extraction_abort"), `${label} did not fence extraction`);
      assert.equal(fenced.runCount, 0);
    }
    console.log(`PTY_BASELINE ${baselineSha.slice(0, 8)} ordinary=red candidate=red`);
    console.log(`PTY_HEAD phases=${headCandidate.phases.join(",")} timeoutMs=${timed.elapsedMs} nearDeadlineMs=${nearDeadline.elapsedMs}`);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
