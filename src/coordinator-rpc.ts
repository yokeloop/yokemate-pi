import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PreparedCoordinator } from "./coordinator-launch.ts";
import type { RuntimeIdentity } from "./coordinator-runtime.ts";
import type { ExpectedCoordinatorModel } from "./coordinator-model.ts";
import { JsonlObservation, OwnedChildState, RunSnapshots, errorMetadata, fileProvenance, sha256 } from "./subagent-runs.ts";
import { processStarttime } from "./coordinator-control.ts";
import { createHash } from "node:crypto";
import { THINKING_LEVELS } from "./pi-model.ts";

export interface RpcEvent { type: string; id?: string; [key: string]: unknown }
export interface CoordinatorRpc { process: ChildProcess; send(command: Record<string, unknown>): void; request(command: Record<string, unknown>): Promise<RpcEvent>; acceptTerminal(): void; hasLiveDescendants(): boolean; ready: Promise<void>; stop(reason?: string): Promise<void>; childState: OwnedChildState; events: RpcEvent[] }
export interface RpcCallbacks { onEvent?(event: RpcEvent): void; onBlocked?(reason: string): void; onUiRequest?(event: RpcEvent, reply: (response: Record<string, unknown>) => void): void }
export interface CoordinatorRpcOptions { invocation?: { command: string; args: string[] }; readyTimeoutMs?: number; stopGraceMs?: number }


function processParent(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[1]);
  } catch { return undefined; }
}
function piInvocation(args: string[]): { command: string; args: string[] } { const script = process.argv[1]; return script && !script.startsWith("/$bunfs/") ? { command: process.execPath, args: [script, ...args] } : { command: "pi", args }; }
export function coordinatorInvocationArgs(prepared: Pick<PreparedCoordinator, "mode" | "model" | "cwd" | "skillsPath" | "resourcesPath">): string[] {
  const definition = join(prepared.resourcesPath, ".pi", "agents", `${prepared.mode}-coordinator.md`);
  return ["--mode", "rpc", "--session-dir", join(prepared.cwd, "sessions"), "-a", "--model", prepared.model, "--skill", prepared.skillsPath, "--append-system-prompt", definition];
}
function openLog(cwd: string, name: string): ((chunk: string) => void) | undefined {
  try {
    const dir = join(cwd, "logs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    return (chunk) => { try { appendFileSync(file, chunk); } catch {} };
  } catch { return undefined; }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function errorText(value: unknown): string { try { return JSON.stringify(value); } catch { return String(value); } }
function invalidState(reason: string): string { return `coordinator invalid state: ${reason}`; }

export function startCoordinatorRpc(prepared: PreparedCoordinator, identity: RuntimeIdentity, expected: ExpectedCoordinatorModel, callbacks: RpcCallbacks = {}, options: CoordinatorRpcOptions = {}): CoordinatorRpc {
  const definition = join(prepared.resourcesPath, ".pi", "agents", `${prepared.mode}-coordinator.md`);
  if (!existsSync(definition)) throw new Error(`coordinator definition is missing: ${definition}`);
  const invocation = options.invocation ?? piInvocation(coordinatorInvocationArgs(prepared));
  const log = openLog(prepared.cwd, `coordinator-${identity.runId}.log`);
  log?.(`[start ${new Date().toISOString()}] ${invocation.command} ${invocation.args.join(" ")}\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, YOKEMATE_MODE: identity.mode, YOKEMATE_TICKET: identity.ticket, YOKEMATE_ROLE: "coordinator", YOKEMATE_RUN_ID: identity.runId, YOKEMATE_PARENT_RUN_ID: identity.parentRunId, YOKEMATE_PARENT_SESSION_ID: identity.parentSessionId, YOKEMATE_PROJECT: JSON.stringify(identity.project) };
  delete env.HERDR_PANE_ID;
  delete env.YOKEMATE_PARENT_PANE;
  const child = spawn(invocation.command, invocation.args, { cwd: prepared.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const childState = new OwnedChildState(identity.runId, child.pid ?? -1, child.pid ? processStarttime(child.pid) ?? "" : "");
  let snapshots: RunSnapshots | undefined;
  try { if (prepared.plan) snapshots = new RunSnapshots(prepared.resourcesPath, prepared.plan); } catch { console.error("[coordinator] diagnostic initialization failed"); }
  const metadata: Record<string, unknown> = { pid: child.pid, starttime: child.pid ? processStarttime(child.pid) : undefined, cwd: prepared.cwd, spawnAt: new Date().toISOString(), requested: { model: prepared.model }, taskHash: sha256(prepared.prompt), appendedPromptHash: sha256(readFileSync(definition)), effective: "unknown", launch: fileProvenance(invocation.args[0] ?? invocation.command), agentDefinition: fileProvenance(definition), cancellationInitiator: "unknown" };
  const save = (completed: boolean) => { snapshots?.write(identity.runId, identity.runId, metadata, completed); };
  save(false);
  const stderrHash = createHash("sha256");
  let stderrBytes = 0;
  const owned = new Map<number, string>();
  const captureOwned = () => {
    if (child.pid) {
      const starttime = processStarttime(child.pid);
      if (starttime) owned.set(child.pid, starttime);
    }
    let changed = true;
    while (changed) {
      changed = false;
      let pids: string[] = [];
      try { pids = readdirSync("/proc"); } catch { return; }
      for (const name of pids) {
        const pid = Number(name);
        if (!Number.isInteger(pid) || owned.has(pid)) continue;
        const parent = processParent(pid);
        const starttime = processStarttime(pid);
        if (parent !== undefined && starttime && owned.has(parent)) { owned.set(pid, starttime); changed = true; }
      }
    }
  };
  const liveOwned = () => {
    captureOwned();
    return [...owned].filter(([pid, starttime]) => processStarttime(pid) === starttime);
  };
  const signalOwned = (signal: NodeJS.Signals) => {
    for (const [pid, starttime] of liveOwned()) {
      try { globalThis.process.kill(pid, signal); } catch {}
    }
  };
  const events: RpcEvent[] = [];
  const pending = new Map<string, { resolve(event: RpcEvent): void; reject(error: Error): void; timer: NodeJS.Timeout }>();

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
  const emit = (event: RpcEvent) => {
    events.push(event);
    if (event.type === "tool_execution_start" && event.toolName === "subagent" && typeof event.toolCallId === "string") childState.toolStart(event.toolCallId, event.args);
    if (event.type === "tool_execution_end" && event.toolName === "subagent" && typeof event.toolCallId === "string") childState.toolEnd(event.toolCallId, isRecord(event.result) ? event.result.details : undefined, event.isError === true);
    if (event.type === "entry_appended" && isRecord(event.entry) && event.entry.type === "custom" && event.entry.customType === "yokemate-child-state") childState.accept(event.entry.data);
    if (event.type === "auto_retry_start" || event.type === "summarization_retry_scheduled") childState.retry = true;
    if (event.type === "auto_retry_end" || event.type === "summarization_retry_finished") childState.retry = false;
    if (event.type === "compaction_start") childState.compaction = true;
    if (event.type === "compaction_end") childState.compaction = false;
    if (event.type === "queue_update") childState.queue = (Array.isArray(event.steering) && event.steering.length > 0) || (Array.isArray(event.followUp) && event.followUp.length > 0);
    if (event.type === "extension_error" && event.event === "send_message") { childState.recordDeliveryError(); metadata.deliveryError = "send_message"; save(false); }
    if (event.type === "response" && typeof event.id === "string") {
      const waiter = pending.get(event.id);
      if (waiter) { clearTimeout(waiter.timer); pending.delete(event.id); waiter.resolve(event); }
      if (event.id === `${identity.runId}:commands`) {
        const commandsValue = isRecord(event.data) ? event.data.commands : undefined;
        const commands = Array.isArray(commandsValue) ? commandsValue.filter(isRecord).map((command) => command.name) : [];
        if (event.success !== true || !commands.includes("yokemate-coordinator-ready") || !commands.includes(`skill:${prepared.mode}-worker`)) fail("coordinator lacks ready command or worker skill");
        else { commandsAck = true; send({ id: `${identity.runId}:ready`, type: "prompt", message: `/yokemate-coordinator-ready ${Buffer.from(JSON.stringify({ identity, prepared: { mode: prepared.mode, tickets: prepared.tickets, cwd: prepared.cwd, model: prepared.model, plan: prepared.plan, diagnosticRoot: prepared.resourcesPath } })).toString("base64")}` }); }
      } else if (event.id === `${identity.runId}:ready`) {
        if (event.success !== true) fail("coordinator ready command was refused");
        else { readyAck = true; send({ id: `${identity.runId}:state`, type: "get_state" }); }
      } else if (event.id === `${identity.runId}:state`) {
        if (event.success !== true) {
          fail(invalidState(`get_state failed: ${errorText(event.error)}`));
          return;
        }
        if (!isRecord(event.data)) { fail(invalidState("data must be a non-null object")); return; }
        if (!isRecord(event.data.model)) { fail(invalidState("data.model must be a non-null object")); return; }
        const model = event.data.model;
        if (typeof model.provider !== "string") { fail(invalidState("data.model.provider must be a string")); return; }
        if (!model.provider.trim()) { fail(invalidState("data.model.provider must not be empty")); return; }
        if (typeof model.id !== "string") { fail(invalidState("data.model.id must be a string")); return; }
        if (!model.id.trim()) { fail(invalidState("data.model.id must not be empty")); return; }
        if (typeof event.data.thinkingLevel !== "string") { fail(invalidState("data.thinkingLevel must be a string")); return; }
        if (!(THINKING_LEVELS as readonly string[]).includes(event.data.thinkingLevel)) { fail(invalidState("data.thinkingLevel must be a valid thinking level")); return; }
        const actual = `${model.provider}/${model.id}`;
        if (model.provider !== expected.provider || model.id !== expected.id) {
          fail(`coordinator model mismatch: expected ${expected.provider}/${expected.id}, got ${actual}`);
          return;
        }
        if (expected.thinkingLevel !== undefined && event.data.thinkingLevel !== expected.thinkingLevel) {
          fail(`coordinator thinking mismatch: expected ${expected.thinkingLevel}, got ${event.data.thinkingLevel}, model ${actual}`);
          return;
        }
        if (typeof event.data.sessionId === "string") childState.bindSession(event.data.sessionId);
        metadata.sessionId = event.data.sessionId ?? "unknown";
        metadata.effective = { model: actual, thinking: event.data.thinkingLevel };
        save(false);
        stateAck = true;
        maybeReady();
      }
    }
    const message = isRecord(event.message) ? event.message : undefined;
    const messageDetails = message && isRecord(message.details) ? message.details : undefined;
    if (event.type === "message_end" && messageDetails?.runId === identity.runId) {
      if (messageDetails.ok === true) { readyMessage = true; maybeReady(); }
      else fail("coordinator ready handshake failed");
    }
    if (event.type === "extension_ui_request") callbacks.onUiRequest?.(event, send);
    callbacks.onEvent?.(event);
  };
  const observation = new JsonlObservation((event) => emit(event as RpcEvent));
  child.stdout.on("data", (chunk: Buffer) => { observation.write(chunk); if (observation.protocolError) fail("coordinator RPC protocol_error"); });
  child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; stderrHash.update(chunk); });
  child.on("close", (code, signal) => { closed = true; metadata.closeAt = new Date().toISOString(); metadata.exitCode = code; metadata.signal = signal; metadata.stderr = { bytes: stderrBytes, hash: stderrHash.digest("hex") }; observation.end(); metadata.stream = observation.metadata(); save(true); log?.(`[close ${new Date().toISOString()}] code=${code} signal=${signal}\n`); clearTimeout(readyTimer); if (observation.protocolError) fail("RPC EOF or malformed JSONL record"); else if (!terminal && !blocked) fail("coordinator RPC exited without outcome"); });
  child.on("error", (error) => { metadata.spawnError = errorMetadata(error); save(false); fail("coordinator RPC spawn error"); });
  send({ id: `${identity.runId}:commands`, type: "get_commands" });
  const stop = (reason = "parent_rpc_stop") => new Promise<void>((resolve) => {
    captureOwned();
    if (liveOwned().length === 0) return resolve();
    if (closed) metadata.descendantCancellationInitiator ??= reason;
    else if (metadata.cancellationInitiator === "unknown") metadata.cancellationInitiator = reason;
    save(closed);
    try { send({ type: "prompt", message: `/yokemate-child-cancel ${Buffer.from(JSON.stringify({ runId: identity.runId, reason })).toString("base64")}` }); } catch {}
    const grace = options.stopGraceMs ?? 5000;
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    try { send({ type: "clear_queue" }); send({ type: "abort_retry" }); send({ type: "abort" }); send({ type: "abort_bash" }); } catch {}
    const waitForOwnedExit = (deadline: number) => {
      if (liveOwned().length === 0 || Date.now() >= deadline) return finish();
      setTimeout(() => waitForOwnedExit(deadline), 10);
    };
    const term = setTimeout(() => signalOwned("SIGTERM"), grace);
    const kill = setTimeout(() => { signalOwned("SIGKILL"); waitForOwnedExit(Date.now() + grace); }, grace * 2);
    child.once("close", () => {
      if (liveOwned().length === 0) { clearTimeout(term); clearTimeout(kill); finish(); }
    });
  });
  const hasLiveDescendants = () => liveOwned().some(([pid]) => pid !== child.pid);
  return { process: child, send, request, acceptTerminal: () => { terminal = true; }, hasLiveDescendants, ready, stop, childState, events };
}

export function continueOwnedCoordinator(rpc: CoordinatorRpc, event: RpcEvent, reportBlocked: (reason: string) => void): void {
  if (event.type === "extension_error" && event.event === "send_message") {
    void rpc.request({ type: "prompt", message: `/yokemate-delivery-error ${Buffer.from(JSON.stringify({ runId: rpc.childState.ownerRunId(), deliveryIds: rpc.childState.uncertainDeliveryIds() })).toString("base64")}` }).catch(() => {});
  }
  const deliveryFailure = rpc.childState.deliveryFailureReason();
  if (deliveryFailure) { reportBlocked(deliveryFailure); return; }
  if (event.type !== "agent_settled") return;
  const verdict = rpc.childState.settled();
  if (verdict === "wait") return;
  if (verdict === "blocked") { reportBlocked("coordinator stopped without outcome"); return; }
  void rpc.request({ type: "prompt", message: "Continue the pipeline or call coordinator_finish with a verified outcome.", streamingBehavior: "followUp" }).catch(() => reportBlocked("coordinator completion prompt delivery failed"));
}
