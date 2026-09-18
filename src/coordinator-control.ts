import * as net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureDir, socketDir } from "./inbox.ts";
import type { CoordinatorRequest } from "./coordinator-launch.ts";
import type { PlanLaunchRequest } from "./plan-launch.ts";
import type { CoordinatorMergeRequest, CoordinatorMergeResult } from "./coordinator-merge.ts";
import type { ShipFinalizeResult } from "./ship-finalize.ts";

export interface ControlOrigin { sessionId: string; runtimeId?: string; pid: number; starttime: string; cwd: string; pane?: string; parentPane?: string; mode?: string; ticket?: string; role?: string }
export interface ControlEnvelope { version: 1; operation: "attach-origin" | "launch" | "launch-plan" | "merge" | "ship-finalize" | "status" | "cancel" | PlanControlOperation; ticket?: string; path?: string; pane?: string; outcome?: "blocked" | "cancelled"; reason?: string; requestId: string; originId?: string; origin?: ControlOrigin; targetSessionId?: string; targetRuntimeId?: string; request?: CoordinatorRequest; planRequest?: PlanLaunchRequest; mergeRequest?: CoordinatorMergeRequest; runId?: string; listRunId?: string; keyRunId?: string; targetRequestId?: string; publicationId?: number; acceptanceId?: number; recordId?: number; contentHash?: string }
export interface ControlResult { key: string; keyRunId: string; state: "accepted" | "refused"; reservation?: "ready" | "queued"; reason?: string; identity?: unknown }
export interface ControlReply { requestId: string; state: "received" | "accepted" | "refused" | "status"; reason?: string; runId?: string; listRunId?: string; keyRunId?: string; originId?: string; identity?: unknown; merge?: CoordinatorMergeResult; finalization?: ShipFinalizeResult; results?: ControlResult[]; publicationId?: number; acceptanceId?: number; recordId?: number; publication?: "complete" | "pending"; handoff?: "plan-only" | "started" | "refused"; target?: string; revision?: string; snapshotPath?: string; scoutPublication?: number }
export type PlanControlOperation = "register-plan" | "bind-plan" | "plan-started" | "publish-plan-scout" | "reject-plan-scout" | "prepare-plan-publication" | "plan-recorded" | "plan-finished" | "record-plan";
export interface ParentControl { publishPlanScout?(ticket: string, acceptanceId: number, origin: ControlOrigin): Promise<{ reason: string; publication: "complete" | "pending"; target: string; revision: string }>; preparePlanPublication?(ticket: string, path: string, contentHash: string, acceptanceId: number, origin: ControlOrigin): Promise<{ reason: string; publicationId: number; recordId: number; snapshotPath: string; scoutPublication: number; target: string; revision: string }>; recordPlan?(ticket: string, path: string, origin: ControlOrigin, runId: string): Promise<{ runId?: string; reason: string; facts?: Record<string, unknown> }>; planRecorded?(ticket: string, path: string, recordIdOrOrigin: number | ControlOrigin, originOrRunId?: ControlOrigin | string, legacyOrigin?: ControlOrigin): Promise<{ runId?: string; reason: string; facts?: Record<string, unknown>; publication?: "complete" | "pending"; handoff?: "plan-only" | "started" | "refused"; target?: string; revision?: string }>; planFinished?(ticket: string, runId: string, outcome: "blocked" | "cancelled", reason: string, origin: ControlOrigin): Promise<void>; launchPlan?(request: PlanLaunchRequest, origin: ControlOrigin): Promise<{ listRunId: string; results: ControlResult[] }>; launch(request: CoordinatorRequest, origin: ControlOrigin): Promise<{ runId?: string; listRunId?: string; identity?: unknown; results?: ControlResult[]; afterAck?(): void }>; merge?(runId: string, request: CoordinatorMergeRequest, origin: ControlOrigin): Promise<CoordinatorMergeResult>; finalizeShip?(runId: string, origin: ControlOrigin): Promise<ShipFinalizeResult>; status(requestId: string, origin: ControlOrigin): ControlReply; cancel(runId: string, origin: ControlOrigin): Promise<void> }
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
    let owner: { pid?: number; starttime?: string };
    try { owner = JSON.parse(readFileSync(sidecar, "utf8")); }
    catch { throw new Error("coordinator endpoint ownership cannot be verified"); }
    if (!owner.pid || typeof owner.starttime !== "string") throw new Error("coordinator endpoint ownership cannot be verified");
    if (processMatches(owner.pid, owner.starttime)) throw new Error(`coordinator endpoint is owned by live pid ${owner.pid}`);
    rmSync(sock, { force: true });
    rmSync(sidecar, { force: true });
  }
  const planRuns = new Map<string, { ticket: string; launcher: ControlOrigin; listRunId?: string; pane?: string; worker?: ControlOrigin; terminal?: "recording" | "recorded" | "blocked" | "cancelled"; recordReply?: { runId?: string; reason: string; facts?: Record<string, unknown> }; scoutAcceptance?: number; scoutGeneration?: number; scoutRequests?: Map<number, number> }>();
  const problemPackages = new Map<string, { owner: ControlOrigin; tickets: Set<string> }>();
  const scoutAcceptances = new Map<string, number>();
  const scoutGenerations = new Map<string, number>();
  const scoutRequests = new Map<string, Map<number, number>>();
  const sameProcess = (a: ControlOrigin, b: ControlOrigin) => a.pid === b.pid && a.starttime === b.starttime && a.sessionId === b.sessionId && a.pane === b.pane;
  const problemKey = (origin: ControlOrigin) => `${origin.sessionId}\u0000${origin.pane ?? ""}`;
  const origins = new Map<string, ControlOrigin>();
  const paneParents = new Map<string, string | undefined>();
  if (identity.pane) paneParents.set(identity.pane, undefined);
  const replies = new Map<string, ControlReply>();
  const requestOrigins = new Map<string, string>();
  const requestRuns = new Map<string, string[]>();
  const requestLists = new Map<string, string>();
  const runOrigins = new Map<string, string>();
  const bindOrigin = (origin: ControlOrigin): string => {
    if (!origin.sessionId || !origin.pid || !origin.starttime || resolve(origin.cwd) !== canonicalRoot) throw new Error("invalid coordinator origin");
    if (origin.pane) {
      if (origin.parentPane === origin.pane) throw new Error("origin pane cannot parent itself");
      let panel: { pid?: number; cwd?: string; mode?: string; ticket?: string | null } | undefined;
      try { panel = JSON.parse(readFileSync(join(socketDir(env, uid), `${origin.pane}.json`), "utf8")); } catch {}
      const paneStarttime = panel?.pid ? processStarttime(panel.pid) : undefined;
      const panelMode = panel?.mode === "main" ? undefined : panel?.mode;
      if (!panel?.pid || !paneStarttime || !descendantOf(origin.pid, origin.starttime, panel.pid, paneStarttime) || resolve(panel.cwd ?? "") !== canonicalRoot || panelMode !== origin.mode || (panel.ticket ?? undefined) !== origin.ticket) throw new Error("panel origin is not registered with this parent");
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
        if (!processMatches(origin.pid, origin.starttime)) { reply({ requestId: envelope.requestId, state: "refused", reason: "origin process is no longer live" }); continue; }
        if (envelope.operation === "launch-plan") {
          try {
            const main = !origin.mode && !origin.role && origin.sessionId === identity.sessionId;
            if (!main || !envelope.planRequest || !parent.launchPlan) throw new Error("only the verified main parent can launch a plan list");
            const accepted = await parent.launchPlan(envelope.planRequest, origin);
            const originId = envelope.originId!;
            const acceptedIds: string[] = [];
            for (const result of accepted.results) if (result.state === "accepted") {
              acceptedIds.push(result.keyRunId);
              planRuns.set(result.keyRunId, { ticket: result.key, launcher: { ...origin }, listRunId: accepted.listRunId });
              runOrigins.set(result.keyRunId, originId);
            }
            const first = acceptedIds[0];
            if (first) {
              requestOrigins.set(envelope.requestId, originId);
              requestRuns.set(envelope.requestId, acceptedIds);
              requestLists.set(envelope.requestId, accepted.listRunId);
              runOrigins.set(accepted.listRunId, originId);
            }
            reply({ requestId: envelope.requestId, state: first ? "accepted" : "refused", runId: first, listRunId: accepted.listRunId, results: accepted.results, reason: first ? undefined : "plan list accepted no keys" });
          } catch (error) { reply({ requestId: envelope.requestId, state: "refused", reason: (error as Error).message }); }
          continue;
        }
        if (["register-plan", "bind-plan", "plan-started", "publish-plan-scout", "reject-plan-scout", "prepare-plan-publication", "plan-recorded", "plan-finished", "record-plan"].includes(envelope.operation)) {
          try {
            const ticket = envelope.ticket;
            if (!ticket || !/^[A-Z][A-Z0-9]*-\d+$/.test(ticket)) throw new Error("invalid plan handoff ticket");
            const main = !origin.mode && !origin.role && origin.sessionId === identity.sessionId;
            if (envelope.operation === "register-plan") {
              if (!main) throw new Error("only the verified main parent can register a plan run");
              const runId = randomUUID();
              planRuns.set(runId, { ticket, launcher: { ...origin } });
              reply({ requestId: envelope.requestId, state: "accepted", runId });
            } else {
              const planRun = envelope.runId ? planRuns.get(envelope.runId) : undefined;
              if (envelope.operation === "bind-plan") {
                if (!main || !planRun || planRun.ticket !== ticket || (!planRun.listRunId && !sameProcess(planRun.launcher, origin)) || planRun.pane || !envelope.pane) throw new Error("invalid parent-owned plan pane binding");
                planRun.pane = envelope.pane;
                reply({ requestId: envelope.requestId, state: "accepted", runId: envelope.runId });
              } else if (envelope.operation === "plan-started") {
                if (!planRun || planRun.ticket !== ticket || origin.mode !== "plan" || origin.ticket !== ticket || origin.pane !== planRun.pane || planRun.worker && !sameProcess(planRun.worker, origin)) throw new Error("invalid plan worker identity");
                planRun.worker = { ...origin };
                reply({ requestId: envelope.requestId, state: "accepted", runId: envelope.runId });
              } else {
                if (["plan-finished", "record-plan"].includes(envelope.operation)) {
                  if (!main && (!planRun?.worker || planRun.ticket !== ticket || origin.mode !== "plan" || origin.ticket !== ticket || origin.pane !== planRun.pane || origin.sessionId !== planRun.worker.sessionId || !descendantOf(origin.pid, origin.starttime, planRun.worker.pid, planRun.worker.starttime))) throw new Error("plan result is not from its registered live worker");
                  if (planRun?.terminal === "recorded" && envelope.operation === "record-plan") { reply({ requestId: envelope.requestId, state: "accepted", ...planRun.recordReply }); continue; }
                  if (planRun?.terminal || (!main && !planRun)) throw new Error("plan run is no longer active");
                  if (envelope.operation === "plan-finished") {
                    if (!planRun || !envelope.runId || !envelope.outcome || !envelope.reason || !parent.planFinished) throw new Error("plan finish handoff is unavailable");
                    await parent.planFinished(ticket, envelope.runId, envelope.outcome, envelope.reason, origin);
                    planRun.terminal = envelope.outcome;
                    reply({ requestId: envelope.requestId, state: "accepted", runId: envelope.runId });
                  } else {
                  if (!envelope.path || !envelope.runId || !parent.recordPlan) throw new Error("plan record handoff is unavailable");
                  if (planRun) planRun.terminal = "recording";
                  try {
                    const outcome = await parent.recordPlan(ticket, envelope.path, origin, envelope.runId);
                    if (planRun) { planRun.terminal = "recorded"; planRun.recordReply = outcome; }
                    reply({ requestId: envelope.requestId, state: "accepted", ...outcome });
                  } catch (error) {
                    if (planRun?.terminal === "recording") planRun.terminal = /cancelled before lock acquisition/.test((error as Error).message) ? "cancelled" : undefined;
                    throw error;
                  }
                  }
                } else {
                const registeredWorker = !!planRun?.worker && planRun.ticket === ticket && origin.mode === "plan" && origin.ticket === ticket && origin.pane === planRun.pane && origin.sessionId === planRun.worker.sessionId && descendantOf(origin.pid, origin.starttime, planRun.worker.pid, planRun.worker.starttime);
                const problemWorker = origin.mode === "plan" && !origin.ticket && origin.role === "coordinator";
                const packageKey = problemKey(origin);
                let packageState = problemPackages.get(packageKey);
                if (packageState && !processMatches(packageState.owner.pid, packageState.owner.starttime)) {
                  problemPackages.delete(packageKey);
                  packageState = undefined;
                }
                const registeredProblemWorker = problemWorker && (!packageState || sameProcess(packageState.owner, origin) || descendantOf(origin.pid, origin.starttime, packageState.owner.pid, packageState.owner.starttime));
                const packageTickets = packageState?.tickets;
                if (!main && !registeredWorker && !(registeredProblemWorker && (["publish-plan-scout", "reject-plan-scout"].includes(envelope.operation) || packageTickets?.has(ticket)))) throw new Error("plan operation is not from its registered live worker");
                const scoutKey = `${origin.sessionId}\u0000${origin.pane ?? ""}\u0000${ticket}`;
                const requestGenerations = planRun ? (planRun.scoutRequests ??= new Map<number, number>()) : scoutRequests.get(scoutKey) ?? new Map<number, number>();
                if (!planRun && !scoutRequests.has(scoutKey)) scoutRequests.set(scoutKey, requestGenerations);
                if (envelope.operation === "publish-plan-scout") {
                  if (!Number.isSafeInteger(envelope.acceptanceId) || !parent.publishPlanScout) throw new Error("plan scout publication is unavailable");
                  const generation = planRun ? (planRun.scoutGeneration = (planRun.scoutGeneration ?? 0) + 1) : (scoutGenerations.get(scoutKey) ?? 0) + 1;
                  if (!planRun) scoutGenerations.set(scoutKey, generation);
                  requestGenerations.set(envelope.acceptanceId!, generation);
                  const outcome = await parent.publishPlanScout(ticket, envelope.acceptanceId!, origin);
                  const currentGeneration = planRun ? planRun.scoutGeneration : scoutGenerations.get(scoutKey);
                  if (currentGeneration !== generation) {
                    requestGenerations.delete(envelope.acceptanceId!);
                    reply({ requestId: envelope.requestId, state: "accepted", acceptanceId: envelope.acceptanceId, ...outcome, publication: "pending", reason: "scout superseded" });
                    continue;
                  }
                  requestGenerations.clear();
                  requestGenerations.set(envelope.acceptanceId!, generation);
                  if (planRun) planRun.scoutAcceptance = envelope.acceptanceId;
                  else scoutAcceptances.set(scoutKey, envelope.acceptanceId!);
                  if (registeredProblemWorker) {
                    const accepted = packageState ?? { owner: { ...origin }, tickets: new Set<string>() };
                    accepted.tickets.add(ticket);
                    problemPackages.set(packageKey, accepted);
                  }
                  reply({ requestId: envelope.requestId, state: "accepted", acceptanceId: envelope.acceptanceId, ...outcome });
                } else if (envelope.operation === "reject-plan-scout") {
                  const currentGeneration = planRun ? planRun.scoutGeneration : scoutGenerations.get(scoutKey);
                  const ownedGeneration = Number.isSafeInteger(envelope.acceptanceId) ? requestGenerations.get(envelope.acceptanceId!) : currentGeneration;
                  if (ownedGeneration === currentGeneration) {
                    requestGenerations.clear();
                    if (planRun) {
                      planRun.scoutGeneration = (planRun.scoutGeneration ?? 0) + 1;
                      planRun.scoutAcceptance = undefined;
                    } else {
                      scoutGenerations.set(scoutKey, (scoutGenerations.get(scoutKey) ?? 0) + 1);
                      scoutAcceptances.delete(scoutKey);
                    }
                    reply({ requestId: envelope.requestId, state: "accepted", reason: "scout rejected" });
                  } else {
                    if (Number.isSafeInteger(envelope.acceptanceId)) requestGenerations.delete(envelope.acceptanceId!);
                    reply({ requestId: envelope.requestId, state: "accepted", reason: "scout rejection superseded" });
                  }
                } else if (envelope.operation === "prepare-plan-publication") {
                  const acceptanceId = planRun?.scoutAcceptance ?? scoutAcceptances.get(scoutKey);
                  if (!envelope.path || !envelope.contentHash || !Number.isSafeInteger(acceptanceId) || !parent.preparePlanPublication) throw new Error("plan publication preparation requires a current accepted scout");
                  const outcome = await parent.preparePlanPublication(ticket, envelope.path, envelope.contentHash, acceptanceId!, origin);
                  reply({ requestId: envelope.requestId, state: "accepted", ...outcome });
                }
              }
            }
          } catch (error) { reply({ requestId: envelope.requestId, state: "refused", reason: (error as Error).message }); }
          continue;
        }
        if (envelope.operation === "merge") {
          try {
            if (!envelope.runId || !envelope.mergeRequest || !parent.merge) throw new Error("merge request is incomplete");
            const merged = await parent.merge(envelope.runId, envelope.mergeRequest, origin);
            reply({ requestId: envelope.requestId, state: "accepted", runId: envelope.runId, merge: merged });
          } catch (error) { reply({ requestId: envelope.requestId, state: "refused", reason: (error as Error).message }); }
          continue;
        }
        if (envelope.operation === "ship-finalize") {
          try {
            if (!envelope.runId || !parent.finalizeShip) throw new Error("ship finalization request is incomplete");
            const finalization = await parent.finalizeShip(envelope.runId, origin);
            reply({ requestId: envelope.requestId, state: "accepted", runId: envelope.runId, finalization });
          } catch (error) { reply({ requestId: envelope.requestId, state: "refused", reason: (error as Error).message }); }
          continue;
        }
        if (envelope.operation === "status") {
          const target = envelope.targetRequestId ?? envelope.listRunId ?? envelope.keyRunId ?? envelope.requestId;
          const requestOwned = requestOrigins.get(target) === envelope.originId;
          const runOwned = runOrigins.get(target) === envelope.originId;
          if (!requestOwned && !runOwned) { reply({ requestId: envelope.requestId, state: "refused", reason: "origin does not own this coordinator request" }); continue; }
          const statusId = requestOwned ? requestLists.get(target) ?? requestRuns.get(target)?.[0] ?? target : target;
          reply(parent.status(statusId, origin));
          continue;
        }
        if (envelope.operation === "cancel" && envelope.runId) {
          if (runOrigins.get(envelope.runId) !== envelope.originId) { reply({ requestId: envelope.requestId, state: "refused", reason: "origin does not own this coordinator run" }); continue; }
          for (const [planRunId, planRun] of planRuns) if ((planRunId === envelope.runId || planRun.listRunId === envelope.runId) && planRun.terminal !== "recording" && !planRun.terminal) planRun.terminal = "cancelled";
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
          const { afterAck, ...acceptedReply } = accepted;
          const originId = envelope.originId!;
          const runIds = accepted.results?.filter((result) => result.state === "accepted").map((result) => result.keyRunId) ?? (accepted.runId ? [accepted.runId] : []);
          if (!runIds.length) {
            const reason = accepted.results?.map((result) => `${result.key}: ${result.reason ?? "refused"}`).join("; ") || "coordinator launch accepted no keys";
            reply({ requestId: envelope.requestId, state: "refused", reason, listRunId: accepted.listRunId, results: accepted.results });
            afterAck?.();
            continue;
          }
          requestOrigins.set(envelope.requestId, originId);
          requestRuns.set(envelope.requestId, runIds);
          if (accepted.listRunId) { requestLists.set(envelope.requestId, accepted.listRunId); runOrigins.set(accepted.listRunId, originId); }
          for (const runId of runIds) runOrigins.set(runId, originId);
          reply({ requestId: envelope.requestId, state: "accepted", ...acceptedReply, runId: accepted.runId ?? runIds[0] });
          afterAck?.();
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

export async function requestCoordinatorMerge(root: string, runId: string, mergeRequest: CoordinatorMergeRequest, origin: ControlOrigin, target: Pick<ParentIdentity, "sessionId" | "runtimeId">, env: NodeJS.ProcessEnv = process.env): Promise<ControlReply> {
  const attach = await send(root, { version: 1, operation: "attach-origin", requestId: randomUUID(), origin, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId }, env);
  if (attach.state !== "accepted" || !attach.originId) return attach;
  return send(root, { version: 1, operation: "merge", requestId: randomUUID(), originId: attach.originId, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId, runId, mergeRequest }, env);
}

export async function requestShipFinalize(root: string, runId: string, origin: ControlOrigin, target: Pick<ParentIdentity, "sessionId" | "runtimeId">, env: NodeJS.ProcessEnv = process.env): Promise<ControlReply> {
  const attach = await send(root, { version: 1, operation: "attach-origin", requestId: randomUUID(), origin, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId }, env);
  if (attach.state !== "accepted" || !attach.originId) return attach;
  return send(root, { version: 1, operation: "ship-finalize", requestId: randomUUID(), originId: attach.originId, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId, runId }, env);
}

export async function requestPlanLaunch(root: string, planRequest: PlanLaunchRequest, origin: ControlOrigin, target: Pick<ParentIdentity, "sessionId" | "runtimeId">, env: NodeJS.ProcessEnv = process.env): Promise<ControlReply> {
  const attach = await send(root, { version: 1, operation: "attach-origin", requestId: randomUUID(), origin, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId }, env);
  if (attach.state !== "accepted" || !attach.originId) return attach;
  return send(root, { version: 1, operation: "launch-plan", requestId: randomUUID(), originId: attach.originId, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId, planRequest }, env);
}

export async function requestPlanControl(root: string, operation: PlanControlOperation, payload: { ticket: string; path?: string; pane?: string; runId?: string; outcome?: "blocked" | "cancelled"; reason?: string; publicationId?: number; acceptanceId?: number; recordId?: number; contentHash?: string }, origin: ControlOrigin, target: Pick<ParentIdentity, "sessionId" | "runtimeId">, env: NodeJS.ProcessEnv = process.env): Promise<ControlReply> {
  const attach = await send(root, { version: 1, operation: "attach-origin", requestId: randomUUID(), origin, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId }, env);
  if (attach.state !== "accepted" || !attach.originId) return attach;
  return send(root, { version: 1, operation, requestId: randomUUID(), originId: attach.originId, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId, ...payload }, env);
}

export function currentControlOrigin(root: string, sessionId = process.env.PI_SESSION_ID): ControlOrigin {
  if (!sessionId) throw new Error("PI_SESSION_ID is required for parent plan handoff");
  const starttime = processStarttime(process.pid);
  if (!starttime) throw new Error("cannot read plan origin process starttime");
  return { sessionId, pid: process.pid, starttime, cwd: root, pane: process.env.HERDR_PANE_ID, parentPane: process.env.YOKEMATE_PARENT_PANE, mode: process.env.YOKEMATE_MODE, ticket: process.env.YOKEMATE_TICKET, role: process.env.YOKEMATE_ROLE };
}
