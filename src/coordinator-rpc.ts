import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreparedCoordinator } from "./coordinator-launch.ts";
import type { RuntimeIdentity } from "./coordinator-runtime.ts";

export interface RpcEvent { type: string; id?: string; [key: string]: unknown }
export interface CoordinatorRpc { process: ChildProcess; send(command: Record<string, unknown>): void; stop(): Promise<void>; events: RpcEvent[] }
export interface RpcCallbacks { onEvent?(event: RpcEvent): void; onBlocked?(reason: string): void }

function cap(text: string): string { return Buffer.byteLength(text) <= 50 * 1024 ? text : Buffer.from(text).subarray(0, 50 * 1024).toString(); }
function piInvocation(args: string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  return script && !script.startsWith("/$bunfs/") ? { command: process.execPath, args: [script, ...args] } : { command: "pi", args };
}

export function startCoordinatorRpc(prepared: PreparedCoordinator, identity: RuntimeIdentity, callbacks: RpcCallbacks = {}): CoordinatorRpc {
  const definition = join(prepared.resourcesPath, ".pi", "agents", `${prepared.mode}-coordinator.md`);
  const dir = mkdtempSync(join(tmpdir(), "yokemate-coordinator-"));
  const systemPrompt = join(dir, "definition.md");
  writeFileSync(systemPrompt, `Coordinator identity: ${JSON.stringify(identity)}\nUse /skill:${prepared.mode}-worker. Finish only through coordinator_finish.`, { mode: 0o600 });
  const invocation = piInvocation(["--mode", "rpc", "--no-session", "-a", "--model", prepared.model, "--skill", prepared.skillsPath, "--append-system-prompt", systemPrompt]);
  const processEnv: NodeJS.ProcessEnv = { ...process.env, YOKEMATE_MODE: identity.mode, YOKEMATE_TICKET: identity.ticket, YOKEMATE_ROLE: "coordinator", YOKEMATE_RUN_ID: identity.runId, YOKEMATE_PARENT_SESSION_ID: identity.parentSessionId, YOKEMATE_PROJECT: JSON.stringify(identity.project) };
  delete processEnv.HERDR_PANE_ID;
  delete processEnv.YOKEMATE_PARENT_PANE;
  const proc = spawn(invocation.command, invocation.args, { cwd: prepared.cwd, env: processEnv, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const events: RpcEvent[] = [];
  let stderr = "";
  let closed = false;
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const emit = (line: string) => {
    if (!line) return;
    try { const event = JSON.parse(line) as RpcEvent; events.push(event); callbacks.onEvent?.(event); } catch { callbacks.onBlocked?.(`invalid RPC JSONL: ${line.slice(0, 160)}`); }
  };
  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    for (;;) { const at = buffer.indexOf("\n"); if (at === -1) break; const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); emit(line.endsWith("\r") ? line.slice(0, -1) : line); }
  });
  proc.stderr.on("data", (chunk: Buffer) => { stderr = cap(stderr + chunk.toString("utf8")); });
  proc.on("close", () => { closed = true; buffer += decoder.end(); if (buffer.trim()) callbacks.onBlocked?.("RPC EOF in JSONL record"); rmSync(dir, { recursive: true, force: true }); });
  proc.on("error", (error) => callbacks.onBlocked?.(error.message));
  const send = (command: Record<string, unknown>) => { if (closed || !proc.stdin.writable) throw new Error("coordinator RPC is not running"); proc.stdin.write(JSON.stringify(command) + "\n"); };
  const stop = () => new Promise<void>((resolve) => {
    if (closed) return resolve();
    try { send({ type: "clear_queue" }); send({ type: "abort_retry" }); send({ type: "abort" }); send({ type: "abort_bash" }); } catch {}
    const timer = setTimeout(() => { try { process.kill(-proc.pid!, "SIGTERM"); } catch {} }, 5000);
    proc.once("close", () => { clearTimeout(timer); resolve(); });
  });
  return { process: proc, send, stop, events };
}
