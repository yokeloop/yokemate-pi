import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sidecarPath, socketDir, type Sidecar } from "./inbox.ts";

export interface HerdrCapture {
  argv: string[];
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface HerdrRunOptions {
  timeout?: number;
  maxBuffer?: number;
}

type HerdrSpawn = (command: string, args: string[], options: Record<string, unknown>) => {
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

function text(value: string | Buffer | null | undefined): string {
  return value === undefined || value === null ? "" : Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

function capturedError(message: string, capture: HerdrCapture): Error & HerdrCapture {
  const error = Object.assign(new Error(message), capture);
  if (capture.error) error.cause = capture.error;
  return error;
}

export function runHerdr(args: string[], options: HerdrRunOptions = {}, execute: HerdrSpawn = spawnSync): HerdrCapture {
  const result = execute("herdr", args, { encoding: "utf8", stdio: "pipe", ...options });
  const capture: HerdrCapture = {
    argv: args,
    stdout: text(result.stdout),
    stderr: text(result.stderr),
    status: result.status,
    signal: result.signal,
    error: result.error,
  };
  if (capture.error) throw capturedError(`herdr ${args.join(" ")} failed: ${capture.error.message}`, capture);
  if (capture.status !== 0 || capture.signal)
    throw capturedError(`herdr ${args.join(" ")} exited with ${capture.signal ? `signal ${capture.signal}` : `status ${capture.status}`}`, capture);
  return capture;
}

export function herdrRaw(args: string[], options?: HerdrRunOptions, execute?: HerdrSpawn): string {
  return runHerdr(args, options, execute).stdout;
}

export function herdr(args: string[], execute?: HerdrSpawn): unknown {
  const capture = runHerdr(args, {}, execute);
  try {
    return JSON.parse(capture.stdout);
  } catch (error) {
    throw capturedError(`herdr ${args.join(" ")} returned malformed JSON: ${(error as Error).message}`, capture);
  }
}

export function formatHerdrError(error: unknown): string {
  const value = error as Error & Partial<HerdrCapture> & { cause?: unknown };
  const parts = [value.message || String(error)];
  if (value.cause instanceof Error && !parts.some((part) => part.includes(value.cause!.message)))
    parts.push(`herdr capture cause: ${value.cause.message}`);
  for (const [label, output] of [["herdr stdout", value.stdout], ["herdr stderr", value.stderr]] as const) {
    if (output && !parts.some((part) => part.includes(output))) parts.push(`${label}:\n${output}`);
  }
  return parts.join("\n");
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function findOpenTab(
  tabs: { label?: string; tab_id: string }[],
  label: string,
): string | undefined {
  return tabs.find((t) => t.label === label)?.tab_id;
}

export function findOpenTabs(
  tabs: { label?: string; tab_id: string }[],
  label: string,
): { label?: string; tab_id: string }[] {
  return tabs.filter((t) => t.label === label || t.label?.startsWith(`${label} [`));
}

export function findRunningAgent(
  agents: { name?: string; pane_id: string }[],
  agentName: string,
  expected?: { mode: string; ticket: string; cwd: string },
): string | undefined {
  const legacy = agents.find((a) => a.name === agentName);
  if (legacy) return legacy.pane_id;
  if (!expected) return undefined;
  const dir = socketDir(process.env, process.getuid!());
  const prefix = `${agentName.slice(0, 23)}-`;
  for (const agent of agents) {
    if (!agent.name?.startsWith(prefix)) continue;
    try {
      const sidecar = JSON.parse(readFileSync(sidecarPath(dir, agent.pane_id), "utf8")) as Sidecar;
      if (sidecar.mode === expected.mode && sidecar.ticket === expected.ticket && resolve(sidecar.cwd) === resolve(expected.cwd))
        return agent.pane_id;
    } catch {}
  }
  return undefined;
}

export function startAgent(
  agentName: string,
  paneId: string,
  displayName: string,
  extraAgentArgs: string[] = [],
  run: (args: string[]) => void = (args) => void herdr(args),
  tries = 20,
  waitMs = 250,
): void {
  for (let i = 1; ; i++) {
    try {
      run([
        "agent", "start", agentName, "--kind", "pi", "--pane", paneId, "--",
        "-n", displayName, "-a", ...extraAgentArgs,
      ]);
      return;
    } catch (e) {
      const err = e as Error & { stdout?: string; stderr?: string };
      const said = `${err.message}${err.stdout ?? ""}${err.stderr ?? ""}`;
      if (i === tries || !said.includes("agent_pane_busy")) throw e;
      pause(waitMs);
    }
  }
}

export function closeTab(
  label: string,
  runIdOrRun?: string | ((args: string[]) => unknown),
  suppliedRun: (args: string[]) => unknown = herdr,
): string | undefined {
  const runId = typeof runIdOrRun === "string" ? runIdOrRun : undefined;
  const run = typeof runIdOrRun === "function" ? runIdOrRun : suppliedRun;
  const listed = run(["tab", "list"]) as { result: { tabs: { label?: string; tab_id: string }[] } };
  const matches = findOpenTabs(listed.result.tabs, label);
  const exact = runId ? matches.filter((tab) => tab.label === `${label} [${runId}]`) : matches;
  if (exact.length > 1) throw new Error(`${label} has multiple open runs — pass --run <run-id>`);
  const id = exact[0]?.tab_id;
  if (id) run(["tab", "close", id]);
  return id;
}
