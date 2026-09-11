import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreparedCoordinator } from "./coordinator-launch.ts";
import type { RuntimeIdentity } from "./coordinator-runtime.ts";

export interface RpcEvent { type: string; id?: string; [key: string]: unknown }
export interface CoordinatorRpc { process: ChildProcess; send(command: Record<string, unknown>): void; ready: Promise<void>; stop(): Promise<void>; events: RpcEvent[] }
export interface RpcCallbacks { onEvent?(event: RpcEvent): void; onBlocked?(reason: string): void }

function cap(text: string): string { return Buffer.byteLength(text) <= 50 * 1024 ? text : Buffer.from(text).subarray(0, 50 * 1024).toString(); }
function piInvocation(args: string[]): { command: string; args: string[] } { const script = process.argv[1]; return script && !script.startsWith("/$bunfs/") ? { command: process.execPath, args: [script, ...args] } : { command: "pi", args }; }

export function startCoordinatorRpc(prepared: PreparedCoordinator, identity: RuntimeIdentity, callbacks: RpcCallbacks = {}): CoordinatorRpc {
  const dir = mkdtempSync(join(tmpdir(), "yokemate-coordinator-"));
  const systemPrompt = join(dir, "definition.md");
  writeFileSync(systemPrompt, `Coordinator identity: ${JSON.stringify(identity)}\nUse /skill:${prepared.mode}-worker. Finish only through coordinator_finish.`, { mode: 0o600 });
  const invocation = piInvocation(["--mode", "rpc", "--no-session", "-a", "--model", prepared.model, "--skill", prepared.skillsPath, "--append-system-prompt", systemPrompt]);
  const env: NodeJS.ProcessEnv = { ...process.env, YOKEMATE_MODE: identity.mode, YOKEMATE_TICKET: identity.ticket, YOKEMATE_ROLE: "coordinator", YOKEMATE_RUN_ID: identity.runId, YOKEMATE_PARENT_SESSION_ID: identity.parentSessionId, YOKEMATE_PROJECT: JSON.stringify(identity.project) };
  delete env.HERDR_PANE_ID;
  delete env.YOKEMATE_PARENT_PANE;
  const proc = spawn(invocation.command, invocation.args, { cwd: prepared.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const events: RpcEvent[] = [];
  let stderr = "";
  let closed = false;
  let terminal = false;
  let blocked = false;
  let readyDone = false;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolvePromise, reject) => { readyResolve = resolvePromise; readyReject = reject; });
  const fail = (reason: string) => { if (blocked) return; blocked = true; readyReject(new Error(reason)); callbacks.onBlocked?.(reason); };
  const send = (command: Record<string, unknown>) => { if (closed || !proc.stdin.writable) throw new Error("coordinator RPC is not running"); proc.stdin.write(JSON.stringify(command) + "\n"); };
  const readyTimer = setTimeout(() => fail("coordinator RPC ready timeout"), 30_000);
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const emit = (line: string) => {
    if (!line) return;
    try {
      const event = JSON.parse(line) as RpcEvent;
      const details = event.type === "tool_execution_end" ? (event.result as { details?: { kind?: string } } | undefined)?.details : undefined;
      if (details?.kind === "yokemate-coordinator-outcome") terminal = true;
      if (event.type === "response" && event.id === `${identity.runId}:commands`) {
        const commands = ((event.data as { commands?: { name?: string }[] } | undefined)?.commands ?? []).map((command) => command.name);
        if (!(event.success === true) || !commands.includes("yokemate-coordinator-ready") || !commands.includes(`skill:${prepared.mode}-worker`)) fail("coordinator lacks ready command or worker skill");
        else send({ id: `${identity.runId}:ready`, type: "prompt", message: `/yokemate-coordinator-ready ${Buffer.from(JSON.stringify({ identity, prepared: { mode: prepared.mode, tickets: prepared.tickets, cwd: prepared.cwd, model: prepared.model } })).toString("base64")}` });
      } else if (event.type === "response" && event.id === `${identity.runId}:ready`) {
        if (event.success !== true) fail("coordinator ready command was refused");
        else send({ id: `${identity.runId}:state`, type: "get_state" });
      } else if (event.type === "response" && event.id === `${identity.runId}:state`) {
        const model = (event.data as { model?: { provider?: string; id?: string } } | undefined)?.model;
        const actual = model?.provider && model.id ? `${model.provider}/${model.id}` : undefined;
        if (event.success !== true || actual !== prepared.model) fail(`coordinator model mismatch: expected ${prepared.model}, got ${actual ?? "none"}`);
        else { readyDone = true; clearTimeout(readyTimer); readyResolve(); }
      }
      events.push(event);
      callbacks.onEvent?.(event);
    } catch (error) { fail(`invalid RPC JSONL: ${(error as Error).message}`); }
  };
  proc.stdout.on("data", (chunk: Buffer) => { buffer += decoder.write(chunk); for (;;) { const at = buffer.indexOf("\n"); if (at === -1) break; const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); emit(line.endsWith("\r") ? line.slice(0, -1) : line); } });
  proc.stderr.on("data", (chunk: Buffer) => { stderr = cap(stderr + chunk.toString("utf8")); });
  proc.on("close", () => { closed = true; clearTimeout(readyTimer); buffer += decoder.end(); if (!terminal && !blocked) fail(buffer.trim() ? "RPC EOF in JSONL record" : `coordinator RPC exited without outcome${stderr ? `: ${stderr.split("\n").at(-1)}` : ""}`); rmSync(dir, { recursive: true, force: true }); });
  proc.on("error", (error) => fail(error.message));
  send({ id: `${identity.runId}:commands`, type: "get_commands" });
  const stop = () => new Promise<void>((resolvePromise) => { if (closed) return resolvePromise(); try { send({ type: "clear_queue" }); send({ type: "abort_retry" }); send({ type: "abort" }); send({ type: "abort_bash" }); } catch {} const timer = setTimeout(() => { try { process.kill(-proc.pid!, "SIGTERM"); } catch {} }, 5000); proc.once("close", () => { clearTimeout(timer); resolvePromise(); }); });
  return { process: proc, send, ready, stop, events };
}
