import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreparedCoordinator } from "./coordinator-launch.ts";
import type { RuntimeIdentity } from "./coordinator-runtime.ts";

export interface RpcEvent { type: string; id?: string; [key: string]: unknown }
export interface CoordinatorRpc { process: ChildProcess; send(command: Record<string, unknown>): void; request(command: Record<string, unknown>): Promise<RpcEvent>; acceptTerminal(): void; ready: Promise<void>; stop(): Promise<void>; events: RpcEvent[] }
export interface RpcCallbacks { onEvent?(event: RpcEvent): void; onBlocked?(reason: string): void; onUiRequest?(event: RpcEvent, reply: (response: Record<string, unknown>) => void): void }
export interface CoordinatorRpcOptions { invocation?: { command: string; args: string[] }; readyTimeoutMs?: number; stopGraceMs?: number }

function cap(text: string): string { return Buffer.byteLength(text) <= 50 * 1024 ? text : Buffer.from(text).subarray(0, 50 * 1024).toString(); }
function piInvocation(args: string[]): { command: string; args: string[] } { const script = process.argv[1]; return script && !script.startsWith("/$bunfs/") ? { command: process.execPath, args: [script, ...args] } : { command: "pi", args }; }

export function startCoordinatorRpc(prepared: PreparedCoordinator, identity: RuntimeIdentity, callbacks: RpcCallbacks = {}, options: CoordinatorRpcOptions = {}): CoordinatorRpc {
  const dir = mkdtempSync(join(tmpdir(), "yokemate-coordinator-"));
  const definition = join(dir, "definition.md");
  writeFileSync(definition, `Coordinator identity: ${JSON.stringify(identity)}\nUse /skill:${prepared.mode}-worker. Finish only through coordinator_finish.`, { mode: 0o600 });
  const invocation = options.invocation ?? piInvocation(["--mode", "rpc", "--no-session", "-a", "--model", prepared.model, "--skill", prepared.skillsPath, "--append-system-prompt", definition]);
  const env: NodeJS.ProcessEnv = { ...process.env, YOKEMATE_MODE: identity.mode, YOKEMATE_TICKET: identity.ticket, YOKEMATE_ROLE: "coordinator", YOKEMATE_RUN_ID: identity.runId, YOKEMATE_PARENT_RUN_ID: identity.parentRunId, YOKEMATE_PARENT_SESSION_ID: identity.parentSessionId, YOKEMATE_PROJECT: JSON.stringify(identity.project) };
  delete env.HERDR_PANE_ID;
  delete env.YOKEMATE_PARENT_PANE;
  const child = spawn(invocation.command, invocation.args, { cwd: prepared.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const events: RpcEvent[] = [];
  const pending = new Map<string, { resolve(event: RpcEvent): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  let stderr = "";
  let buffer = "";
  let closed = false;
  let terminal = false;
  let blocked = false;
  let commandsAck = false;
  let readyAck = false;
  let readyMessage = false;
  let stateAck = false;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const readyTimer = setTimeout(() => fail("coordinator RPC ready timeout"), options.readyTimeoutMs ?? 30_000);
  const fail = (reason: string) => {
    if (blocked) return;
    blocked = true;
    clearTimeout(readyTimer);
    readyReject(new Error(reason));
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(reason)); }
    pending.clear();
    callbacks.onBlocked?.(reason);
  };
  const send = (command: Record<string, unknown>) => {
    if (closed || !child.stdin?.writable) throw new Error("coordinator RPC is not running");
    child.stdin.write(JSON.stringify(command) + "\n");
  };
  const request = (command: Record<string, unknown>) => new Promise<RpcEvent>((resolve, reject) => {
    const id = typeof command.id === "string" ? command.id : `${identity.runId}:${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`coordinator RPC command timed out: ${command.type ?? "unknown"}`)); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    try { send({ ...command, id }); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error as Error); }
  });
  const maybeReady = () => {
    if (commandsAck && readyAck && readyMessage && stateAck && !blocked) { clearTimeout(readyTimer); readyResolve(); }
  };
  const emit = (line: string) => {
    if (!line) return;
    let event: RpcEvent;
    try { event = JSON.parse(line) as RpcEvent; } catch (error) { fail(`invalid RPC JSONL: ${(error as Error).message}`); return; }
    events.push(event);
    if (event.type === "response" && typeof event.id === "string") {
      const waiter = pending.get(event.id);
      if (waiter) { clearTimeout(waiter.timer); pending.delete(event.id); waiter.resolve(event); }
      if (event.id === `${identity.runId}:commands`) {
        const commands = ((event.data as { commands?: { name?: string }[] } | undefined)?.commands ?? []).map((command) => command.name);
        if (event.success !== true || !commands.includes("yokemate-coordinator-ready") || !commands.includes(`skill:${prepared.mode}-worker`)) fail("coordinator lacks ready command or worker skill");
        else { commandsAck = true; send({ id: `${identity.runId}:ready`, type: "prompt", message: `/yokemate-coordinator-ready ${Buffer.from(JSON.stringify({ identity, prepared: { mode: prepared.mode, tickets: prepared.tickets, cwd: prepared.cwd, model: prepared.model } })).toString("base64")}` }); }
      } else if (event.id === `${identity.runId}:ready`) {
        if (event.success !== true) fail("coordinator ready command was refused");
        else { readyAck = true; send({ id: `${identity.runId}:state`, type: "get_state" }); }
      } else if (event.id === `${identity.runId}:state`) {
        const model = (event.data as { model?: { provider?: string; id?: string } } | undefined)?.model;
        const actual = model?.provider && model.id ? `${model.provider}/${model.id}` : undefined;
        if (event.success !== true || actual !== prepared.model) fail(`coordinator model mismatch: expected ${prepared.model}, got ${actual ?? "none"}`);
        else { stateAck = true; maybeReady(); }
      }
    }
    const messageDetails = (event.message as { details?: { runId?: string; ok?: boolean } } | undefined)?.details;
    if (event.type === "message_end" && messageDetails?.runId === identity.runId) {
      if (messageDetails.ok) { readyMessage = true; maybeReady(); }
      else fail("coordinator ready handshake failed");
    }
    if (event.type === "extension_ui_request") callbacks.onUiRequest?.(event, send);
    callbacks.onEvent?.(event);
  };
  const decoder = new StringDecoder("utf8");
  child.stdout.on("data", (chunk: Buffer) => { buffer += decoder.write(chunk); for (;;) { const newline = buffer.indexOf("\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); emit(line.endsWith("\r") ? line.slice(0, -1) : line); } });
  child.stderr.on("data", (chunk: Buffer) => { stderr = cap(stderr + chunk.toString("utf8")); });
  child.on("close", () => { closed = true; clearTimeout(readyTimer); buffer += decoder.end(); if (buffer.trim()) fail("RPC EOF in JSONL record"); else if (!terminal && !blocked) fail(`coordinator RPC exited without outcome${stderr ? `: ${stderr.split("\n").at(-1)}` : ""}`); rmSync(dir, { recursive: true, force: true }); });
  child.on("error", (error) => fail(error.message));
  send({ id: `${identity.runId}:commands`, type: "get_commands" });
  const stop = () => new Promise<void>((resolve) => {
    if (closed) return resolve();
    try { send({ type: "clear_queue" }); send({ type: "abort_retry" }); send({ type: "abort" }); send({ type: "abort_bash" }); } catch {}
    const grace = options.stopGraceMs ?? 5000;
    const term = setTimeout(() => { try { globalThis.process.kill(-child.pid!, "SIGTERM"); } catch {} }, grace);
    const kill = setTimeout(() => { try { globalThis.process.kill(-child.pid!, "SIGKILL"); } catch {} }, grace * 2);
    child.once("close", () => { clearTimeout(term); clearTimeout(kill); resolve(); });
  });
  return { process: child, send, request, acceptTerminal: () => { terminal = true; }, ready, stop, events };
}
