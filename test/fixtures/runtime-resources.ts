import fs from "node:fs";
import type { ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Server, Socket } from "node:net";

export interface ResourceCleanupOptions {
  timeoutMs?: number;
}

export interface EventWaitOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  closeEvents?: string[];
  errorEvents?: string[];
  label?: string;
}

type Cleanup = { label: string; run: () => Promise<void> | void };
const childCloses = new WeakMap<ChildProcess, Promise<void>>();

function childClose(child: ChildProcess): Promise<void> {
  const existing = childCloses.get(child);
  if (existing) return existing;
  const close = new Promise<void>((resolve) => {
    if (child.pid && childStarttime(child.pid) === undefined && (child.exitCode !== null || child.signalCode !== null)) resolve();
    else child.once("close", () => resolve());
  });
  childCloses.set(child, close);
  return close;
}

function timeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

interface ProcessIdentity { pid: number; ppid: number; starttime: string }

function processIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(/\s+/);
    return { pid, ppid: Number(fields[1]), starttime: fields[19]! };
  } catch {
    return undefined;
  }
}

function childStarttime(pid: number): string | undefined {
  return processIdentity(pid)?.starttime;
}

function ownedProcessTree(rootPid: number, known = new Map<number, ProcessIdentity>()): Map<number, ProcessIdentity> {
  const table = new Map<number, ProcessIdentity>();
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const identity = processIdentity(Number(entry));
    if (identity) table.set(identity.pid, identity);
  }
  const owned = new Set([...known.values()].filter((identity) => processIdentity(identity.pid)?.starttime === identity.starttime).map((identity) => identity.pid));
  if (table.has(rootPid)) owned.add(rootPid);
  let changed = true;
  while (changed) {
    changed = false;
    for (const identity of table.values()) {
      if (!owned.has(identity.pid) && owned.has(identity.ppid)) { owned.add(identity.pid); changed = true; }
    }
  }
  for (const pid of owned) {
    const identity = table.get(pid);
    if (identity) known.set(pid, identity);
  }
  return known;
}

function signalProcessTree(known: Map<number, ProcessIdentity>, signal: NodeJS.Signals): void {
  for (const identity of [...known.values()].reverse()) {
    if (processIdentity(identity.pid)?.starttime !== identity.starttime) continue;
    try { process.kill(identity.pid, signal); } catch {}
  }
}

async function waitForProcessTree(known: Map<number, ProcessIdentity>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (![...known.values()].some((identity) => processIdentity(identity.pid)?.starttime === identity.starttime)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

export function waitForEvent<T = unknown>(source: EventEmitter, event: string, options: EventWaitOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const closeEvents = options.closeEvents ?? ["close", "exit"];
  const errorEvents = options.errorEvents ?? ["error"];
  const label = options.label ?? event;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const listeners: Array<[string, (...arguments_: any[]) => void]> = [];
    const finish = (error?: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", aborted);
      for (const [name, listener] of listeners) source.removeListener(name, listener);
      if (error !== undefined) reject(error);
      else resolve(value as T);
    };
    const listen = (name: string, listener: (...arguments_: any[]) => void) => {
      listeners.push([name, listener]);
      source.once(name, listener);
    };
    const aborted = () => finish(options.signal?.reason ?? new Error(`${label} aborted`));
    listen(event, (...arguments_: unknown[]) => finish(undefined, (arguments_.length <= 1 ? arguments_[0] : arguments_) as T));
    for (const name of closeEvents.filter((name) => name !== event)) listen(name, () => finish(new Error(`${label} source closed before ${event}`)));
    for (const name of errorEvents.filter((name) => name !== event)) listen(name, (error) => finish(error instanceof Error ? error : new Error(`${label} source error`)));
    if (options.signal?.aborted) aborted();
    else options.signal?.addEventListener("abort", aborted, { once: true });
    timer = setTimeout(() => finish(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
}

export async function stopOwnedProcess(child: ChildProcess, options: { termMs?: number; killMs?: number } = {}): Promise<void> {
  const termMs = options.termMs ?? 5_000;
  const killMs = options.killMs ?? 3_000;
  const pid = child.pid;
  const starttime = pid ? childStarttime(pid) : undefined;
  let closed = false;
  const close = childClose(child).then(() => { closed = true; });
  const signalIfOwned = (value: NodeJS.Signals) => {
    if (!pid || !starttime || childStarttime(pid) !== starttime) return;
    try { child.kill(value); } catch {}
  };
  if (!closed) signalIfOwned("SIGTERM");
  try {
    await timeout(close, termMs, "owned process TERM close");
    return;
  } catch {}
  signalIfOwned("SIGKILL");
  await timeout(close, killMs, "owned process KILL close");
  if (pid && childStarttime(pid) === starttime) throw new Error(`owned process ${pid} remains alive after close`);
}

export async function stopOwnedProcessTree(child: ChildProcess, options: { termMs?: number; killMs?: number } = {}): Promise<void> {
  const pid = child.pid;
  if (!pid) { await stopOwnedProcess(child, options); return; }
  const known = ownedProcessTree(pid);
  signalProcessTree(known, "SIGTERM");
  const direct = childClose(child);
  const termMs = options.termMs ?? 5_000;
  if (await waitForProcessTree(known, termMs)) { await timeout(direct, termMs, "owned process tree TERM close"); return; }
  signalProcessTree(known, "SIGKILL");
  await timeout(direct, options.killMs ?? 3_000, "owned process tree KILL close");
  if (!await waitForProcessTree(known, options.killMs ?? 3_000)) throw new Error("owned process tree remains alive after SIGKILL");
}

export async function closeOwnedServer(server: Server, sockets: Iterable<Socket> = [], options: { peerGraceMs?: number; closeMs?: number } = {}): Promise<void> {
  const peers = [...sockets];
  for (const socket of peers) if (!socket.destroyed) socket.end();
  const close = new Promise<void>((resolve, reject) => {
    if (!server.listening) { resolve(); return; }
    server.close((error) => error ? reject(error) : resolve());
  });
  let peerTimer: NodeJS.Timeout | undefined;
  try {
    peerTimer = setTimeout(() => { for (const socket of peers) if (!socket.destroyed) socket.destroy(); }, options.peerGraceMs ?? 1_000);
    peerTimer.unref?.();
    await timeout(close, options.closeMs ?? 2_000, "owned server close");
  } finally {
    clearTimeout(peerTimer);
    for (const socket of peers) if (!socket.destroyed) socket.destroy();
  }
}

export class RuntimeResources {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly cleanups: Cleanup[] = [];
  private readonly cleanupTimeoutMs: number;
  private cleanupPromise?: Promise<void>;

  constructor(parentSignal?: AbortSignal, cleanupTimeoutMs = 30_000) {
    this.signal = this.controller.signal;
    this.cleanupTimeoutMs = cleanupTimeoutMs;
    if (parentSignal?.aborted) this.controller.abort(parentSignal.reason);
    else parentSignal?.addEventListener("abort", () => this.controller.abort(parentSignal.reason), { once: true });
  }

  add(label: string, cleanup: () => Promise<void> | void): void {
    this.cleanups.push({ label, run: cleanup });
  }

  path(candidate: string): void {
    const registry = process.env.YOKEMATE_TEST_RESOURCE_REGISTRY;
    const root = process.env.YOKEMATE_TEST_RESOURCE_ROOT;
    if (registry && root) {
      const relative = candidate.startsWith(`${root}/`) || candidate === root;
      if (!relative) throw new Error(`resource path is outside supervisor root: ${candidate}`);
      fs.appendFileSync(registry, JSON.stringify({ path: candidate }) + "\n");
    }
    this.add(`path ${candidate}`, () => fs.rmSync(candidate, { recursive: true, force: true }));
  }

  child(child: ChildProcess): void {
    childClose(child);
    this.add(`process ${child.pid ?? "unknown"}`, () => stopOwnedProcess(child));
  }

  server(server: Server): Set<Socket> {
    const sockets = new Set<Socket>();
    const connected = (socket: Socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    };
    server.on("connection", connected);
    this.add("server", async () => {
      server.removeListener("connection", connected);
      await closeOwnedServer(server, sockets);
    });
    return sockets;
  }

  abort(reason?: unknown): void {
    if (!this.signal.aborted) this.controller.abort(reason ?? new Error("runtime resource scope aborted"));
  }

  cleanup(options: ResourceCleanupOptions = {}): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = (async () => {
      this.abort(new Error("runtime resource cleanup"));
      const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? this.cleanupTimeoutMs, this.cleanupTimeoutMs));
      const errors: unknown[] = [];
      const tasks = [...this.cleanups].reverse().map(async ({ label, run }) => {
        try { await run(); }
        catch (error) { errors.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`)); }
      });
      try { await timeout(Promise.allSettled(tasks).then(() => undefined), timeoutMs, "runtime resource cleanup"); }
      catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "runtime resource cleanup failed");
    })();
    return this.cleanupPromise;
  }
}
