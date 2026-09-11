import * as net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureDir, socketDir } from "./inbox.ts";
import type { CoordinatorRequest } from "./coordinator-launch.ts";

export interface ControlOrigin { sessionId: string; runtimeId?: string; pid: number; starttime: string; cwd: string; pane?: string; parentPane?: string; mode?: string; ticket?: string; role?: string }
export interface ControlEnvelope { version: 1; operation: "attach-origin" | "launch" | "status" | "cancel"; requestId: string; originId?: string; origin?: ControlOrigin; targetSessionId?: string; targetRuntimeId?: string; request?: CoordinatorRequest; runId?: string; targetRequestId?: string }
export interface ControlReply { requestId: string; state: "received" | "accepted" | "refused" | "status"; reason?: string; runId?: string; originId?: string; identity?: unknown }
export interface ParentControl { launch(request: CoordinatorRequest, origin: ControlOrigin): Promise<{ runId: string; identity: unknown }>; status(requestId: string, origin: ControlOrigin): ControlReply; cancel(runId: string, origin: ControlOrigin): Promise<void> }
export interface ParentIdentity { root: string; sessionId: string; runtimeId: string; pid: number; starttime: string; cwd: string; pane?: string }

export function processStarttime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
  } catch { return undefined; }
}

function processMatches(pid: number, starttime: string): boolean { return isLiveProcess(pid) && processStarttime(pid) === starttime; }

export function coordinatorSocketPath(root: string, env: NodeJS.ProcessEnv = process.env, uid = process.getuid!()): string {
  return join(socketDir(env, uid), "coordinators", `${createHash("sha256").update(resolve(root)).digest("hex")}.sock`);
}

function isLiveProcess(pid: number): boolean {
  try { return statSync(`/proc/${pid}`).isDirectory(); } catch { return false; }
}

function parentPid(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[1]);
  } catch { return undefined; }
}

function descendantOf(pid: number, starttime: string, ancestor: number, ancestorStarttime: string): boolean {
  if (!processMatches(pid, starttime) || !processMatches(ancestor, ancestorStarttime)) return false;
  let current = pid;
  for (let remaining = 0; remaining < 32 && current > 1; remaining += 1) {
    if (current === ancestor) return processMatches(current, ancestorStarttime);
    const parent = parentPid(current);
    if (!parent) return false;
    current = parent;
  }
  return false;
}

export function bindCoordinatorControl(root: string, parent: ParentControl, identity: ParentIdentity, env: NodeJS.ProcessEnv = process.env, uid = process.getuid!()): net.Server {
  const canonicalRoot = resolve(root);
  const directory = join(socketDir(env, uid), "coordinators");
  const sock = coordinatorSocketPath(canonicalRoot, env, uid);
  ensureDir(directory, uid);
  if (existsSync(sock)) {
    const sidecar = `${sock}.json`;
    let owner: { pid?: number; starttime?: string } | undefined;
    try { owner = JSON.parse(readFileSync(sidecar, "utf8")); } catch {}
    if (owner?.pid && typeof owner.starttime === "string" && processMatches(owner.pid, owner.starttime)) throw new Error(`coordinator endpoint is owned by live pid ${owner.pid}`);
    rmSync(sock, { force: true });
    rmSync(sidecar, { force: true });
  }
  const origins = new Map<string, ControlOrigin>();
  const paneParents = new Map<string, string | undefined>();
  if (identity.pane) paneParents.set(identity.pane, undefined);
  const replies = new Map<string, ControlReply>();
  const requestOrigins = new Map<string, string>();
  const requestRuns = new Map<string, string>();
  const runOrigins = new Map<string, string>();
  const bindOrigin = (origin: ControlOrigin): string => {
    if (!origin.sessionId || !origin.pid || !origin.starttime || resolve(origin.cwd) !== canonicalRoot) throw new Error("invalid coordinator origin");
    if (origin.pane) {
      if (origin.parentPane === origin.pane) throw new Error("origin pane cannot parent itself");
      let panel: { pid?: number; cwd?: string } | undefined;
      try { panel = JSON.parse(readFileSync(join(socketDir(env, uid), `${origin.pane}.json`), "utf8")); } catch {}
      const paneStarttime = panel?.pid ? processStarttime(panel.pid) : undefined;
      if (!panel?.pid || !paneStarttime || !descendantOf(origin.pid, origin.starttime, panel.pid, paneStarttime) || resolve(panel.cwd ?? "") !== canonicalRoot) throw new Error("panel origin is not registered with this parent");
      const parentKnown = origin.parentPane === identity.pane || (origin.parentPane !== undefined && paneParents.has(origin.parentPane));
      if (origin.sessionId !== identity.sessionId && (!origin.parentPane || !parentKnown)) throw new Error("origin pane chain is not registered with this parent");
      paneParents.set(origin.pane, origin.parentPane);
    } else if (origin.sessionId !== identity.sessionId || !descendantOf(origin.pid, origin.starttime, identity.pid, identity.starttime)) throw new Error("origin session is not registered with this parent");
    const id = randomUUID();
    origins.set(id, { ...origin });
    return id;
  };
  const server = net.createServer((connection) => {
    let buffer = "";
    const reply = (value: ControlReply) => { replies.set(value.requestId, value); connection.write(JSON.stringify(value) + "\n"); };
    connection.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let envelope: ControlEnvelope;
        try { envelope = JSON.parse(line); } catch { reply({ requestId: "", state: "refused", reason: "invalid JSON" }); continue; }
        if (envelope.version !== 1 || !envelope.requestId) { reply({ requestId: envelope.requestId ?? "", state: "refused", reason: "invalid envelope" }); continue; }
        if (envelope.targetSessionId && envelope.targetSessionId !== identity.sessionId || envelope.targetRuntimeId && envelope.targetRuntimeId !== identity.runtimeId) { reply({ requestId: envelope.requestId, state: "refused", reason: "wrong coordinator parent" }); continue; }
        if (envelope.operation === "attach-origin") {
          try { const originId = bindOrigin(envelope.origin!); reply({ requestId: envelope.requestId, state: "accepted", originId }); }
          catch (error) { reply({ requestId: envelope.requestId, state: "refused", reason: (error as Error).message }); }
          continue;
        }
        const origin = envelope.originId ? origins.get(envelope.originId) : undefined;
        if (!origin) { reply({ requestId: envelope.requestId, state: "refused", reason: "unknown origin binding" }); continue; }
        if (envelope.operation === "status") {
          const target = envelope.targetRequestId ?? envelope.requestId;
          if (requestOrigins.get(target) !== envelope.originId) { reply({ requestId: envelope.requestId, state: "refused", reason: "origin does not own this coordinator request" }); continue; }
          reply(parent.status(requestRuns.get(target) ?? target, origin));
          continue;
        }
        if (envelope.operation === "cancel" && envelope.runId) {
          if (runOrigins.get(envelope.runId) !== envelope.originId) { reply({ requestId: envelope.requestId, state: "refused", reason: "origin does not own this coordinator run" }); continue; }
          try { await parent.cancel(envelope.runId, origin); reply({ requestId: envelope.requestId, state: "accepted", runId: envelope.runId }); }
          catch (error) { reply({ requestId: envelope.requestId, state: "refused", reason: (error as Error).message }); }
          continue;
        }
        if (envelope.operation !== "launch" || !envelope.request) { reply({ requestId: envelope.requestId, state: "refused", reason: "invalid coordinator operation" }); continue; }
        const cached = replies.get(envelope.requestId);
        if (cached) { reply(cached); continue; }
        reply({ requestId: envelope.requestId, state: "received" });
        try {
          const accepted = await parent.launch(envelope.request, origin);
          const originId = envelope.originId!;
          requestOrigins.set(envelope.requestId, originId);
          requestRuns.set(envelope.requestId, accepted.runId);
          runOrigins.set(accepted.runId, originId);
          reply({ requestId: envelope.requestId, state: "accepted", ...accepted });
        } catch (error) { reply({ requestId: envelope.requestId, state: "refused", reason: (error as Error).message }); }
      }
    });
  });
  server.on("close", () => { rmSync(sock, { force: true }); rmSync(`${sock}.json`, { force: true }); });
  server.listen(sock);
  writeFileSync(`${sock}.json`, JSON.stringify({ root: canonicalRoot, pid: identity.pid, starttime: identity.starttime, sessionId: identity.sessionId, runtimeId: identity.runtimeId, cwd: identity.cwd, pane: identity.pane }), { mode: 0o600 });
  return server;
}

function send(root: string, envelope: ControlEnvelope, env: NodeJS.ProcessEnv): Promise<ControlReply> {
  return new Promise((resolvePromise, reject) => {
    const connection = net.createConnection(coordinatorSocketPath(root, env));
    let buffer = "";
    connection.on("connect", () => connection.write(JSON.stringify(envelope) + "\n"));
    connection.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n"); if (newline < 0) return;
        const reply = JSON.parse(buffer.slice(0, newline)) as ControlReply; buffer = buffer.slice(newline + 1);
        if (reply.state !== "received") { connection.end(); resolvePromise(reply); return; }
      }
    });
    connection.on("error", reject);
  });
}

export function resolveCoordinatorParent(root: string, env: NodeJS.ProcessEnv = process.env): ParentIdentity {
  const sidecar = `${coordinatorSocketPath(root, env)}.json`;
  let parsed: ParentIdentity;
  try { parsed = JSON.parse(readFileSync(sidecar, "utf8")) as ParentIdentity; }
  catch { throw new Error("no live coordinator parent for this yokemate root"); }
  if (resolve(parsed.root) !== resolve(root) || !parsed.starttime || !processMatches(parsed.pid, parsed.starttime)) throw new Error("coordinator parent is stale");
  return parsed;
}

export async function requestCoordinator(root: string, request: CoordinatorRequest, origin: ControlOrigin, target: Pick<ParentIdentity, "sessionId" | "runtimeId">, env: NodeJS.ProcessEnv = process.env): Promise<ControlReply> {
  const attach = await send(root, { version: 1, operation: "attach-origin", requestId: randomUUID(), origin, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId }, env);
  if (attach.state !== "accepted" || !attach.originId) return attach;
  return send(root, { version: 1, operation: "launch", requestId: randomUUID(), originId: attach.originId, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId, request }, env);
}
