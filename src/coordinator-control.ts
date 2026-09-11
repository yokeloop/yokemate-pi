import * as net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureDir, socketDir } from "./inbox.ts";
import type { CoordinatorRequest } from "./coordinator-launch.ts";

export interface ControlOrigin { sessionId: string; runtimeId?: string; pid: number; cwd: string; pane?: string; parentPane?: string; mode?: string; ticket?: string; role?: string }
export interface ControlEnvelope { version: 1; operation: "attach-origin" | "launch" | "status" | "cancel"; requestId: string; originId?: string; targetSessionId?: string; request?: CoordinatorRequest; runId?: string }
export interface ControlReply { requestId: string; state: "received" | "accepted" | "refused" | "status"; reason?: string; runId?: string; identity?: unknown }
export interface ParentControl { launch(request: CoordinatorRequest, origin: ControlOrigin): Promise<{ runId: string; identity: unknown }>; status(requestId: string, origin: ControlOrigin): ControlReply; cancel(runId: string, origin: ControlOrigin): Promise<void> }

export function coordinatorSocketPath(root: string, env: NodeJS.ProcessEnv = process.env, uid = process.getuid!()): string {
  return join(socketDir(env, uid), "coordinators", `${createHash("sha256").update(resolve(root)).digest("hex")}.sock`);
}

export function bindCoordinatorControl(root: string, parent: ParentControl, env: NodeJS.ProcessEnv = process.env, uid = process.getuid!()): net.Server {
  const sock = coordinatorSocketPath(root, env, uid);
  ensureDir(join(socketDir(env, uid), "coordinators"), uid);
  if (existsSync(sock)) rmSync(sock, { force: true });
  const origins = new Map<string, ControlOrigin>();
  const replies = new Map<string, ControlReply>();
  const server = net.createServer((connection) => {
    let buffer = "";
    connection.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let envelope: ControlEnvelope;
      try { envelope = JSON.parse(line); } catch { connection.end(JSON.stringify({ state: "refused", reason: "invalid JSON" }) + "\n"); return; }
      const reply = (value: ControlReply) => { replies.set(value.requestId, value); connection.write(JSON.stringify(value) + "\n"); };
      if (envelope.version !== 1 || !envelope.requestId) { reply({ requestId: envelope.requestId ?? "", state: "refused", reason: "invalid envelope" }); return; }
      if (envelope.operation === "attach-origin") {
        const origin = JSON.parse((connection as unknown as { origin?: string }).origin ?? "null") as ControlOrigin | null;
        if (!origin) { reply({ requestId: envelope.requestId, state: "refused", reason: "origin must be attached by an engine extension" }); return; }
        const originId = randomUUID(); origins.set(originId, origin); reply({ requestId: envelope.requestId, state: "accepted", runId: originId }); return;
      }
      const origin = envelope.originId ? origins.get(envelope.originId) : undefined;
      if (!origin) { reply({ requestId: envelope.requestId, state: "refused", reason: "unknown origin binding" }); return; }
      if (envelope.operation === "status") { reply(parent.status(envelope.requestId, origin)); return; }
      if (envelope.operation === "cancel" && envelope.runId) { await parent.cancel(envelope.runId, origin); reply({ requestId: envelope.requestId, state: "accepted", runId: envelope.runId }); return; }
      if (envelope.operation !== "launch" || !envelope.request) { reply({ requestId: envelope.requestId, state: "refused", reason: "invalid coordinator operation" }); return; }
      reply({ requestId: envelope.requestId, state: "received" });
      try { const accepted = await parent.launch(envelope.request, origin); reply({ requestId: envelope.requestId, state: "accepted", ...accepted }); }
      catch (error) { reply({ requestId: envelope.requestId, state: "refused", reason: (error as Error).message }); }
    });
  });
  server.listen(sock);
  return server;
}

export async function requestCoordinator(root: string, envelope: ControlEnvelope, env: NodeJS.ProcessEnv = process.env): Promise<ControlReply> {
  const sock = coordinatorSocketPath(root, env);
  return new Promise((resolvePromise, reject) => {
    const connection = net.createConnection(sock);
    let buffer = "";
    connection.on("connect", () => connection.write(JSON.stringify(envelope) + "\n"));
    connection.on("data", (chunk) => { buffer += chunk.toString("utf8"); const newline = buffer.indexOf("\n"); if (newline < 0) return; const reply = JSON.parse(buffer.slice(0, newline)) as ControlReply; if (reply.state !== "received") { connection.end(); resolvePromise(reply); } });
    connection.on("error", reject);
  });
}
