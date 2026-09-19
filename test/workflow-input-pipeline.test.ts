import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

const source = join(import.meta.dirname, "..");
const baselineSha = "8b0c417989bf7dce8129f3e4f4f7b2f2ad7d1d46";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

interface FixtureEvent { phase: string; at: number; [key: string]: unknown }
class Driver {
  readonly process: ChildProcessWithoutNullStreams;
  private serial = 0;
  private readonly pending = new Map<number, (value: any) => void>();
  readonly stderr: Buffer[] = [];
  readonly ready: Promise<void>;
  constructor(root: string, env: NodeJS.ProcessEnv, command: string[]) {
    this.process = spawn("python3", [join(source, "test", "fixtures", "workflow-input-pty.py")], { cwd: root, env: { ...env, WORKFLOW_PTY_CWD: root, WORKFLOW_PTY_COMMAND: Buffer.from(JSON.stringify(command)).toString("base64") }, stdio: ["pipe", "pipe", "pipe"] });
    this.process.stderr.on("data", (chunk) => { this.stderr.push(Buffer.from(chunk)); if (this.stderr.reduce((sum, item) => sum + item.length, 0) > 64 * 1024) this.stderr.shift(); });
    let resolveReady!: () => void;
    this.ready = new Promise((resolve) => { resolveReady = resolve; });
    createInterface({ input: this.process.stdout }).on("line", (line) => {
      const value = JSON.parse(line);
      if (value.event === "ready") { resolveReady(); return; }
      const resolve = this.pending.get(value.id);
      if (resolve) { this.pending.delete(value.id); resolve(value); }
    });
  }
  request(action: string, data: Record<string, unknown> = {}, timeout = 15000): Promise<any> {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`PTY command timed out: ${action}`)); }, timeout);
      this.pending.set(id, (value) => { clearTimeout(timer); resolve(value); });
      this.process.stdin.write(JSON.stringify({ id, action, ...data }) + "\n");
    });
  }
  async stop(): Promise<void> {
    if (this.process.exitCode === null) await this.request("terminate").catch(() => {});
    if (this.process.exitCode === null) await Promise.race([once(this.process, "exit"), new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (this.process.exitCode === null) this.process.kill("SIGKILL");
  }
}

async function createTarget(parent: string, kind: "baseline" | "head"): Promise<string> {
  const root = join(parent, kind);
  mkdirSync(root, { recursive: true });
  const archive = join(parent, `${kind}.tar`);
  execFileSync("git", ["-C", source, "archive", "--format=tar", `--output=${archive}`, baselineSha]);
  execFileSync("tar", ["-xf", archive, "-C", root]);
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
  return root;
}

async function runCase(root: string, scenario: "none" | "approval" | "timeout", input: string, waitAfterRelease?: { needle: string; timeout: number }): Promise<{ extractionCount: number; renderBeforeRelease: boolean; mainBeforeRelease: boolean; phases: string[]; elapsedMs?: number }> {
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
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const event = JSON.parse(buffer.slice(0, newline)) as FixtureEvent;
      events.push(event);
      if (event.phase === "extraction_enter") extractionSockets.add(socket);
      else socket.end("release\n");
    });
    socket.on("close", () => extractionSockets.delete(socket));
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
  };
  const driver = new Driver(root, env, command);
  try {
    await driver.ready;
    assert.equal((await driver.request("wait", { needle: readyMarker, timeout: 15 }, 20000)).found, true, "real Pi editor never became ready");
    const inputStartedAt = Date.now();
    await driver.request("write", { text: input });
    await driver.request("enter");
    const extractionDeadline = Date.now() + 5000;
    while (!events.some((event) => event.phase === "extraction_enter") && !events.some((event) => event.phase === "main_enter") && Date.now() < extractionDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
    const renderBeforeRelease = (await driver.request("wait", { needle: renderMarker, timeout: 1.5 }, 5000)).found as boolean;
    const mainBeforeRelease = (await driver.request("wait", { needle: mainMarker, timeout: 1.5 }, 5000)).found as boolean;
    for (const socket of extractionSockets) socket.end("release\n");
    if (!mainBeforeRelease) await driver.request("wait", { needle: mainMarker, timeout: 10 }, 15000);
    let elapsedMs: number | undefined;
    if (waitAfterRelease) {
      assert.equal((await driver.request("wait", { needle: waitAfterRelease.needle, timeout: waitAfterRelease.timeout }, (waitAfterRelease.timeout + 5) * 1000)).found, true);
      elapsedMs = Date.now() - inputStartedAt;
    }
    const phaseDeadline = Date.now() + 2000;
    while ((!events.some((event) => event.phase === "turn_start") || !events.some((event) => event.phase === "message_start_user")) && Date.now() < phaseDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
    return { extractionCount: events.filter((event) => event.phase === "extraction_enter").length, renderBeforeRelease, mainBeforeRelease, phases: events.map((event) => event.phase), elapsedMs };
  } finally {
    for (const socket of extractionSockets) socket.destroy();
    await driver.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(runtime, { recursive: true, force: true });
  }
}

test("real Pi TUI input pipeline is nonblocking and ordinary input skips extraction", { timeout: 120000 }, async () => {
  execFileSync("python3", ["-c", "import pty,termios,fcntl,selectors"]);
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
    const timed = await runCase(head, "timeout", candidate, { needle: "workflow extraction unavailable: outcome=timeout", timeout: 22 });
    assert.ok((timed.elapsedMs ?? 0) >= 14500, `timeout fired before the shared 15s budget: ${timed.elapsedMs}`);
    assert.ok((timed.elapsedMs ?? Infinity) < 22000, `timeout exceeded scheduler tolerance: ${timed.elapsedMs}`);
    assert.equal(timed.mainBeforeRelease, true);
    console.log(`PTY_BASELINE ${baselineSha.slice(0, 8)} ordinary=red candidate=red`);
    console.log(`PTY_HEAD phases=${headCandidate.phases.join(",")} timeoutMs=${timed.elapsedMs}`);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
