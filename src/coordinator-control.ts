import * as net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureDir, socketDir, type Sidecar } from "./inbox.ts";
import type { CoordinatorRequest } from "./coordinator-launch.ts";
import type { PlanLaunchRequest } from "./plan-launch.ts";
import type { CoordinatorMergeRequest, CoordinatorMergeResult } from "./coordinator-merge.ts";
import type { ShipFinalizeResult } from "./ship-finalize.ts";
import { observePlanProcess, type PlanProcessObserver } from "./plan-lifecycle.ts";
import type { PublicationOutcome } from "./plan-publication-state.ts";
import { assertMandatoryBoundary } from "./workflow-boundaries.ts";
import type { ReviewHandoffOutcome, ReviewInputGeneration, ReviewReworkExtraction, ReviewSurfaceIdentity } from "./review-rework.ts";
import { cancellationResult, type CancellationResult } from "./subagent-runs.ts";

export interface ControlOrigin { sessionId: string; runtimeId?: string; pid: number; starttime: string; cwd: string; pane?: string; parentPane?: string; mode?: string; ticket?: string; role?: string }
export interface ControlEnvelope { version: 1; operation: "attach-origin" | "launch" | "launch-plan" | "merge" | "ship-finalize" | "status" | "cancel" | PlanControlOperation | ReviewControlOperation; ticket?: string; path?: string; pane?: string; surface?: "tab" | "split"; tabId?: string; workerRuntimeId?: string; raw?: string; generation?: ReviewInputGeneration | number; extraction?: ReviewReworkExtraction; outcome?: "blocked" | "cancelled"; reason?: string; requestId: string; originId?: string; origin?: ControlOrigin; targetSessionId?: string; targetRuntimeId?: string; request?: CoordinatorRequest; planRequest?: PlanLaunchRequest; mergeRequest?: CoordinatorMergeRequest; runId?: string; listRunId?: string; keyRunId?: string; targetRequestId?: string; publicationId?: number; acceptanceId?: number; recordId?: number; contentHash?: string; candidateId?: string; failureHash?: string; writerRunId?: string }
export interface ControlResult { key: string; keyRunId: string; state: "accepted" | "refused"; reservation?: "ready" | "queued"; reason?: string; identity?: unknown }
export interface ControlReply { requestId: string; state: "received" | "accepted" | "refused" | "status"; reason?: string; runId?: string; listRunId?: string; keyRunId?: string; originId?: string; identity?: unknown; cancellation?: CancellationResult; merge?: CoordinatorMergeResult; finalization?: ShipFinalizeResult; results?: ControlResult[]; publicationId?: number; acceptanceId?: number; artifactAcceptance?: "accepted" | "superseded"; recordId?: number; publication?: "complete" | "pending"; publications?: PublicationOutcome[]; handoff?: "plan-only" | "started" | "refused"; target?: string; revision?: string; snapshotPath?: string; scoutPublication?: number; scoutAcceptance?: number; generation?: ReviewInputGeneration | number; rework?: ReviewHandoffOutcome; facts?: Record<string, unknown>; candidateId?: string; failureHash?: string; planningIdentity?: string }
export type PlanControlOperation = "register-plan" | "bind-plan" | "plan-started" | "publish-plan-scout" | "reject-plan-scout" | "prepare-plan-publication" | "plan-recorded" | "plan-finished" | "record-plan" | "register-scout-candidate" | "read-scout-candidate" | "continue-scout-candidate" | "bind-recovered-scout" | "read-plan-writer-input" | "admit-plan-writer";
export type ReviewControlOperation = "register-review" | "bind-review" | "review-started" | "review-input" | "review-extraction" | "review-record" | "review-status" | "review-ended";
export interface ParentControl { publishPlanScout?(ticket: string, acceptanceId: number, origin: ControlOrigin): Promise<{ reason: string; publication: "complete" | "pending"; target: string; revision: string; publicationId?: number }>; preparePlanPublication?(ticket: string, path: string, contentHash: string, acceptanceId: number, origin: ControlOrigin, runId?: string, generation?: number): Promise<{ reason: string; recordId: number; snapshotPath: string; scoutAcceptance: number; revision: string; publicationId?: number; scoutPublication?: number; target?: string }>; recordPlan?(ticket: string, path: string, origin: ControlOrigin, runId: string, acceptanceId: number): Promise<{ runId?: string; reason: string; facts?: Record<string, unknown>; publications?: PublicationOutcome[]; handoff?: "plan-only" | "started" | "refused" }>; planRecorded?(ticket: string, path: string, recordIdOrOrigin: number | ControlOrigin, originOrRunId?: ControlOrigin | string, legacyOrigin?: ControlOrigin, runId?: string, generation?: number): Promise<{ runId?: string; reason: string; facts?: Record<string, unknown>; publication?: "complete" | "pending"; publications?: PublicationOutcome[]; handoff?: "plan-only" | "started" | "refused"; target?: string; revision?: string }>; planFinished?(ticket: string, runId: string, outcome: "blocked" | "cancelled", reason: string, origin: ControlOrigin): Promise<void>; reviewStarted?(ticket: string, runId: string, origin: ControlOrigin, surface: ReviewSurfaceIdentity): Promise<void> | void; reviewInput?(ticket: string, runId: string, raw: string, origin: ControlOrigin): Promise<ReviewInputGeneration> | ReviewInputGeneration; reviewExtraction?(ticket: string, runId: string, extraction: ReviewReworkExtraction, generation: ReviewInputGeneration, origin: ControlOrigin): Promise<void> | void; reviewRecord?(ticket: string, runId: string, path: string, origin: ControlOrigin): Promise<ReviewHandoffOutcome>; reviewStatus?(ticket: string, runId: string, origin: ControlOrigin): Promise<ReviewHandoffOutcome | undefined> | ReviewHandoffOutcome | undefined; reviewEnded?(ticket: string, runId: string, reason: string, origin: ControlOrigin): Promise<void> | void; launchPlan?(request: PlanLaunchRequest, origin: ControlOrigin): Promise<{ listRunId: string; results: ControlResult[] }>; launch(request: CoordinatorRequest, origin: ControlOrigin): Promise<{ runId?: string; listRunId?: string; identity?: unknown; results?: ControlResult[]; afterAck?(): void }>; merge?(runId: string, request: CoordinatorMergeRequest, origin: ControlOrigin): Promise<CoordinatorMergeResult>; finalizeShip?(runId: string, origin: ControlOrigin): Promise<ShipFinalizeResult>; status(requestId: string, origin: ControlOrigin): ControlReply; cancel(runId: string, origin: ControlOrigin): Promise<CancellationResult | void> }
export class PlanRecorderFences {
  private readonly fenced = new Set<string>();
  private readonly stopAgents = new Set<string>();
  fence(runId: string, stopAgent: boolean): void { this.fenced.add(runId); if (stopAgent) this.stopAgents.add(runId); }
  active(runId: string): boolean { return this.fenced.has(runId); }
  consume(runId: string): { fenced: boolean; stopAgent: boolean } {
    const fenced = this.fenced.delete(runId);
    const stopAgent = this.stopAgents.delete(runId);
    return { fenced, stopAgent };
  }
  clear(): void { this.fenced.clear(); this.stopAgents.clear(); }
}

export interface ParentIdentity { root: string; sessionId: string; runtimeId: string; pid: number; starttime: string; cwd: string; pane?: string }

type PaneMode = "plan" | "review" | "do" | "ship" | "worklog" | "note" | "research";
const PANE_MODES = new Set<PaneMode>(["plan", "review", "do", "ship", "worklog", "note", "research"]);

export function controlPaneMode(value: unknown, source: "origin" | "sidecar"): PaneMode | undefined {
  if (source === "origin" && value === undefined) return undefined;
  if (typeof value !== "string" || !value || (source === "origin" && value === "main") || (value !== "main" && !PANE_MODES.has(value as PaneMode)))
    throw new Error(source === "origin" ? "invalid coordinator origin" : "pane sidecar is invalid");
  return value === "main" ? undefined : value as PaneMode;
}

interface PaneRegistration {
  pane: string;
  pid: number;
  starttime: string;
  sessionId: string;
  parentPane?: string;
  mode?: PaneMode;
  ticket?: string;
}

interface BoundOrigin {
  origin: ControlOrigin;
  pane?: string;
}

interface PlanRunState {
  ticket: string;
  launcher: ControlOrigin;
  listRunId?: string;
  pane?: string;
  worker?: ControlOrigin;
  terminal?: "recording" | "recorded" | "blocked" | "cancelled";
  recordReply?: { runId?: string; reason: string; facts?: Record<string, unknown>; publications?: PublicationOutcome[]; handoff?: "plan-only" | "started" | "refused" };
  pendingExit?: ControlOrigin;
  observer?: PlanProcessObserver;
  scoutAcceptance?: number;
  scoutGeneration?: number;
  scoutRequests?: Map<number, number>;
  finalizedScoutAcceptances?: Set<number>;
  recoveryCandidates?: Map<string, { failureHash: string; generation: number; workerSessionId: string }>;
  recovery?: { candidateId: string; failureHash: string; generation: number; planningIdentity: string; state: "active" | "cancelled" | "recorded" };
}

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
  assertMandatoryBoundary("workflow.live-owner", identity.pid === process.pid && processMatches(identity.pid, identity.starttime), "coordinator parent identity is not live");
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
  const planRuns = new Map<string, PlanRunState>();
  const reviewRuns = new Map<string, { ticket: string; launcher: ControlOrigin; expectedRuntimeId: string; pane?: string; surface?: "tab" | "split"; tabId?: string; worker?: ControlOrigin; ended?: boolean }>();
  const problemPackages = new Map<string, { owner: ControlOrigin; tickets: Set<string> }>();
  const scoutAcceptances = new Map<string, number>();
  const scoutGenerations = new Map<string, number>();
  const scoutRequests = new Map<string, Map<number, number>>();
  const finalizedScoutAcceptances = new Map<string, Set<number>>();
  const sameProcess = (a: ControlOrigin, b: ControlOrigin) => a.pid === b.pid && a.starttime === b.starttime && a.sessionId === b.sessionId && a.pane === b.pane && a.parentPane === b.parentPane && a.mode === b.mode && a.ticket === b.ticket && a.role === b.role && resolve(a.cwd) === resolve(b.cwd);
  const problemKey = (origin: ControlOrigin) => `${origin.sessionId}\u0000${origin.pane ?? ""}`;
  const origins = new Map<string, BoundOrigin>();
  const panes = new Map<string, PaneRegistration>();
  if (identity.pane) panes.set(identity.pane, { pane: identity.pane, pid: identity.pid, starttime: identity.starttime, sessionId: identity.sessionId });
  const replies = new Map<string, ControlReply>();
  const requestOrigins = new Map<string, string>();
  const requestRuns = new Map<string, string[]>();
  const requestLists = new Map<string, string>();
  const runOrigins = new Map<string, string>();
  const fencePlanRun = (planRun: PlanRunState, terminal: "blocked" | "cancelled"): void => {
    planRun.terminal = terminal;
    planRun.observer?.stop();
    planRun.observer = undefined;
    if (planRun.scoutAcceptance !== undefined) (planRun.finalizedScoutAcceptances ??= new Set()).add(planRun.scoutAcceptance);
    planRun.scoutAcceptance = undefined;
    planRun.scoutGeneration = (planRun.scoutGeneration ?? 0) + 1;
    planRun.scoutRequests?.clear();
  };
  const finishExitedPlan = async (runId: string, planRun: PlanRunState, worker: ControlOrigin): Promise<void> => {
    if (planRun.terminal === "recording") {
      planRun.pendingExit = { ...worker };
      return;
    }
    if (planRun.terminal === "blocked" && planRun.recovery?.state === "active") {
      planRun.recovery.state = "cancelled";
      planRun.observer?.stop();
      planRun.observer = undefined;
      return;
    }
    if (planRun.terminal) return;
    fencePlanRun(planRun, "cancelled");
    try {
      if (!parent.planFinished) throw new Error("plan finish handoff is unavailable");
      await parent.planFinished(planRun.ticket, runId, "cancelled", "plan worker process ended before a terminal record", worker);
    } catch {}
  };
  const watchPlanWorker = (runId: string, planRun: PlanRunState, worker: ControlOrigin): void => {
    planRun.observer?.stop();
    planRun.observer = observePlanProcess(worker, () => finishExitedPlan(runId, planRun, worker));
  };
  const validOriginShape = (origin: unknown): origin is ControlOrigin => {
    if (!origin || typeof origin !== "object" || Array.isArray(origin)) return false;
    const value = origin as Record<string, unknown>;
    if (typeof value.sessionId !== "string" || !value.sessionId || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || typeof value.starttime !== "string" || !value.starttime || typeof value.cwd !== "string" || !value.cwd) return false;
    for (const key of ["pane", "parentPane", "ticket", "role"] as const) if (value[key] !== undefined && typeof value[key] !== "string") return false;
    try { controlPaneMode(value.mode, "origin"); } catch { return false; }
    return true;
  };
  const readPane = (pane: string): PaneRegistration => {
    const sidecar = join(socketDir(env, uid), `${pane}.json`);
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(sidecar, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("pane sidecar is missing");
      throw new Error("pane sidecar is invalid");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("pane sidecar is invalid");
    const value = raw as Partial<Sidecar> & Record<string, unknown>;
    let mode: PaneMode | undefined;
    try { mode = controlPaneMode(value.mode, "sidecar"); } catch { throw new Error("pane sidecar is invalid"); }
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || typeof value.starttime !== "string" || !value.starttime || typeof value.cwd !== "string" || !value.cwd || typeof value.sessionId !== "string" || !value.sessionId || !(value.ticket === null || typeof value.ticket === "string") || !(value.parentPane === null || value.parentPane === undefined || typeof value.parentPane === "string")) throw new Error("pane sidecar is invalid");
    if (!processMatches(value.pid as number, value.starttime)) throw new Error("pane sidecar is stale");
    if (resolve(value.cwd) !== canonicalRoot) throw new Error("pane root mismatch");
    return { pane, pid: value.pid as number, starttime: value.starttime, sessionId: value.sessionId, parentPane: value.parentPane ?? undefined, mode, ticket: value.ticket ?? undefined };
  };
  const samePane = (a: PaneRegistration, b: PaneRegistration): boolean => a.pane === b.pane && a.pid === b.pid && a.starttime === b.starttime && a.sessionId === b.sessionId && a.parentPane === b.parentPane && a.mode === b.mode && a.ticket === b.ticket;
  const validatePaneChain = (pane: string): void => {
    const seen = new Set<string>();
    let current: string | undefined = pane;
    while (current) {
      if (seen.has(current)) throw new Error("origin pane chain is not registered with this parent");
      seen.add(current);
      const registered = panes.get(current);
      if (!registered || !processMatches(registered.pid, registered.starttime)) throw new Error("origin pane chain is not registered with this parent");
      let live: PaneRegistration;
      try { live = readPane(current); } catch { throw new Error("origin pane chain is not registered with this parent"); }
      if (!samePane(registered, live)) throw new Error("origin pane chain is not registered with this parent");
      if (current === identity.pane) {
        if (registered.pid !== identity.pid || registered.starttime !== identity.starttime || registered.sessionId !== identity.sessionId || registered.parentPane !== undefined) throw new Error("origin pane chain is not registered with this parent");
        return;
      }
      if (!registered.parentPane) throw new Error("origin pane chain is not registered with this parent");
      current = registered.parentPane;
    }
    throw new Error("origin pane chain is not registered with this parent");
  };
  const validatePaneOrigin = (origin: ControlOrigin, registering: boolean): PaneRegistration => {
    const pane = origin.pane!;
    const sidecar = readPane(pane);
    if (pane === identity.pane) {
      if (sidecar.pid !== identity.pid || sidecar.starttime !== identity.starttime || sidecar.sessionId !== identity.sessionId || sidecar.parentPane !== undefined) throw new Error("origin pane chain is not registered with this parent");
    }
    if (!descendantOf(origin.pid, origin.starttime, sidecar.pid, sidecar.starttime)) throw new Error("origin process is not descended from pane");
    if (origin.sessionId !== sidecar.sessionId) throw new Error("origin pane chain is not registered with this parent");
    if (origin.parentPane !== sidecar.parentPane) throw new Error("origin pane chain is not registered with this parent");
    if (controlPaneMode(origin.mode, "origin") !== sidecar.mode) throw new Error("pane mode mismatch");
    if (origin.ticket !== sidecar.ticket) throw new Error("pane ticket mismatch");
    const registered = panes.get(pane);
    if (registered && !samePane(registered, sidecar)) throw new Error("origin pane chain is not registered with this parent");
    if (!registered) {
      if (!registering || !sidecar.parentPane || !panes.has(sidecar.parentPane)) throw new Error("origin pane chain is not registered with this parent");
      panes.set(pane, sidecar);
    }
    validatePaneChain(pane);
    return sidecar;
  };
  const validateBoundOrigin = (bound: BoundOrigin): ControlOrigin => {
    const origin = bound.origin;
    if (!processMatches(origin.pid, origin.starttime)) throw new Error("origin process is stale");
    if (bound.pane) validatePaneOrigin(origin, false);
    else if (origin.sessionId !== identity.sessionId || !descendantOf(origin.pid, origin.starttime, identity.pid, identity.starttime)) throw new Error("origin session is not registered with this parent");
    return origin;
  };
  const bindOrigin = (candidate: ControlOrigin): string => {
    if (!validOriginShape(candidate)) throw new Error("invalid coordinator origin");
    controlPaneMode(candidate.mode, "origin");
    const origin = { ...candidate };
    if (resolve(origin.cwd) !== canonicalRoot) throw new Error("origin root mismatch");
    if (!processMatches(origin.pid, origin.starttime)) throw new Error("origin process is stale");
    if (origin.pane) validatePaneOrigin(origin, true);
    else if (origin.sessionId !== identity.sessionId || !descendantOf(origin.pid, origin.starttime, identity.pid, identity.starttime)) throw new Error("origin session is not registered with this parent");
    const id = randomUUID();
    origins.set(id, { origin, pane: origin.pane });
    return id;
  };
  const mainOrigin = (origin: ControlOrigin): boolean => origin.mode === undefined && origin.ticket === undefined && origin.role === undefined && origin.sessionId === identity.sessionId;
  const paneOwner = (origin: ControlOrigin): ControlOrigin | undefined => {
    if (!origin.pane) return undefined;
    const pane = panes.get(origin.pane);
    if (!pane) return undefined;
    return { sessionId: pane.sessionId, pid: pane.pid, starttime: pane.starttime, cwd: canonicalRoot, pane: pane.pane, parentPane: pane.parentPane, mode: pane.mode, ticket: pane.ticket, role: origin.role };
  };
  const registeredWorker = (planRun: PlanRunState | undefined, ticket: string, origin: ControlOrigin): boolean => !!planRun?.worker && planRun.ticket === ticket && origin.mode === "plan" && origin.ticket === ticket && origin.role === "coordinator" && origin.pane === planRun.pane && origin.sessionId === planRun.worker.sessionId && descendantOf(origin.pid, origin.starttime, planRun.worker.pid, planRun.worker.starttime);
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
        const bound = envelope.originId ? origins.get(envelope.originId) : undefined;
        if (!bound) { reply({ requestId: envelope.requestId, state: "refused", reason: "unknown origin binding" }); continue; }
        let origin: ControlOrigin;
        try { origin = validateBoundOrigin(bound); }
        catch (error) { reply({ requestId: envelope.requestId, state: "refused", reason: (error as Error).message }); continue; }
        if (envelope.operation === "launch-plan") {
          try {
            const main = mainOrigin(origin);
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
        if (["register-review", "bind-review", "review-started", "review-input", "review-extraction", "review-record", "review-status", "review-ended"].includes(envelope.operation)) {
          try {
            const ticket = envelope.ticket;
            if (!ticket || !/^[A-Z][A-Z0-9]*-\d+$/.test(ticket)) throw new Error("invalid review handoff ticket");
            const main = !origin.mode && !origin.role && origin.sessionId === identity.sessionId;
            if (envelope.operation === "register-review") {
              if (!main) throw new Error("only the verified main parent can register a review run");
              if (!envelope.workerRuntimeId || envelope.workerRuntimeId.length > 200) throw new Error("review registration requires its expected worker runtime");
              const runId = randomUUID();
              reviewRuns.set(runId, { ticket, launcher: { ...origin }, expectedRuntimeId: envelope.workerRuntimeId });
              reply({ requestId: envelope.requestId, state: "accepted", runId });
              continue;
            }
            const reviewRun = envelope.runId ? reviewRuns.get(envelope.runId) : undefined;
            if (!reviewRun || reviewRun.ticket !== ticket || !envelope.runId) throw new Error("unknown review run");
            if (envelope.operation === "bind-review") {
              if (!main || !sameProcess(reviewRun.launcher, origin) || reviewRun.pane || !envelope.pane || !envelope.surface || envelope.surface === "tab" && !envelope.tabId || envelope.surface === "split" && envelope.tabId) throw new Error("invalid parent-owned review surface binding");
              reviewRun.pane = envelope.pane;
              reviewRun.surface = envelope.surface;
              reviewRun.tabId = envelope.tabId;
              reply({ requestId: envelope.requestId, state: "accepted", runId: envelope.runId });
              continue;
            }
            const exactWorker = !!reviewRun.worker && sameProcess(reviewRun.worker, origin) && origin.runtimeId === reviewRun.worker.runtimeId;
            let exactPaneRuntime = false;
            try {
              const panel = JSON.parse(readFileSync(join(socketDir(env, uid), `${reviewRun.pane}.json`), "utf8")) as { pid?: number };
              exactPaneRuntime = panel.pid === origin.pid && processStarttime(origin.pid) === origin.starttime;
            } catch {}
            const workerCandidate = origin.mode === "review" && origin.role === "coordinator" && origin.ticket === ticket && origin.pane === reviewRun.pane && origin.runtimeId === reviewRun.expectedRuntimeId && exactPaneRuntime;
            const descendant = !!reviewRun.worker && origin.mode === "review" && origin.ticket === ticket && origin.pane === reviewRun.pane && origin.sessionId === reviewRun.worker.sessionId && origin.runtimeId === reviewRun.worker.runtimeId && descendantOf(origin.pid, origin.starttime, reviewRun.worker.pid, reviewRun.worker.starttime);
            if (envelope.operation === "review-started") {
              if (reviewRun.ended || !workerCandidate || reviewRun.worker && !exactWorker || !reviewRun.surface || !reviewRun.pane) throw new Error("invalid review worker identity");
              reviewRun.worker = { ...origin };
              await parent.reviewStarted?.(ticket, envelope.runId, origin, { surface: reviewRun.surface, paneId: reviewRun.pane, ...(reviewRun.tabId ? { tabId: reviewRun.tabId } : {}) });
              reply({ requestId: envelope.requestId, state: "accepted", runId: envelope.runId });
            } else if (envelope.operation === "review-input") {
              if (reviewRun.ended || !exactWorker || typeof envelope.raw !== "string" || !parent.reviewInput) throw new Error("review input is not from its registered runtime");
              const generation = await parent.reviewInput(ticket, envelope.runId, envelope.raw, origin);
              reply({ requestId: envelope.requestId, state: "accepted", runId: envelope.runId, generation });
            } else if (envelope.operation === "review-extraction") {
              if (reviewRun.ended || !exactWorker || (typeof envelope.generation !== "object" || !envelope.generation) || !envelope.extraction || !parent.reviewExtraction) throw new Error("review extraction is not from its registered runtime");
              await parent.reviewExtraction(ticket, envelope.runId, envelope.extraction, envelope.generation, origin);
              reply({ requestId: envelope.requestId, state: "accepted", runId: envelope.runId });
            } else if (envelope.operation === "review-record") {
              if (reviewRun.ended || !descendant || !envelope.path || !parent.reviewRecord) throw new Error("review record is not from its registered live worker");
              const rework = await parent.reviewRecord(ticket, envelope.runId, envelope.path, origin);
              reply({ requestId: envelope.requestId, state: "accepted", runId: rework.runId, rework });
            } else if (envelope.operation === "review-status") {
              if (!descendant && !(main && sameProcess(reviewRun.launcher, origin))) throw new Error("review status is not owned by this origin");
              const rework = await parent.reviewStatus?.(ticket, envelope.runId, origin);
              reply({ requestId: envelope.requestId, state: "status", runId: rework?.runId ?? envelope.runId, rework });
            } else {
              if (!exactWorker || reviewRun.ended || !envelope.reason) throw new Error("review end is not from its registered runtime");
              reviewRun.ended = true;
              await parent.reviewEnded?.(ticket, envelope.runId, envelope.reason, origin);
              reply({ requestId: envelope.requestId, state: "accepted", runId: envelope.runId });
            }
          } catch (error) { reply({ requestId: envelope.requestId, state: "refused", reason: (error as Error).message }); }
          continue;
        }
        if (["register-scout-candidate", "read-scout-candidate", "continue-scout-candidate", "bind-recovered-scout", "read-plan-writer-input", "admit-plan-writer"].includes(envelope.operation)) {
          try {
            const ticket = envelope.ticket;
            const planRun = envelope.runId ? planRuns.get(envelope.runId) : undefined;
            const main = mainOrigin(origin);
            if (!ticket || !envelope.runId || !planRun || planRun.ticket !== ticket) throw new Error("unknown plan recovery lineage");
            const worker = registeredWorker(planRun, ticket, origin);
            if (envelope.operation === "register-scout-candidate") {
              if (!worker || planRun.terminal || !envelope.candidateId || !/^[a-f0-9-]{36}$/.test(envelope.candidateId) || !envelope.failureHash || !/^[a-f0-9]{64}$/.test(envelope.failureHash) || typeof envelope.generation !== "number" || !Number.isSafeInteger(envelope.generation) || envelope.generation! < 1) throw new Error("invalid recovery candidate registration");
              const candidates = planRun.recoveryCandidates ??= new Map();
              const prior = candidates.get(envelope.candidateId);
              const next = { failureHash: envelope.failureHash, generation: envelope.generation!, workerSessionId: origin.sessionId };
              if (prior && JSON.stringify(prior) !== JSON.stringify(next)) throw new Error("recovery candidate identity changed");
              candidates.set(envelope.candidateId, next);
              reply({ requestId: envelope.requestId, state: "accepted", runId: envelope.runId, candidateId: envelope.candidateId, failureHash: envelope.failureHash, generation: envelope.generation });
            } else if (envelope.operation === "read-scout-candidate") {
              if (!main || !envelope.candidateId) throw new Error("only the verified main parent can read a recovery candidate");
              const candidate = planRun.recoveryCandidates?.get(envelope.candidateId);
              if (!candidate) throw new Error("unknown recovery candidate");
              reply({ requestId: envelope.requestId, state: "accepted", runId: envelope.runId, candidateId: envelope.candidateId, ...candidate });
            } else if (envelope.operation === "continue-scout-candidate") {
              if (!main || planRun.terminal !== "blocked" || !planRun.worker || !processMatches(planRun.worker.pid, planRun.worker.starttime) || !envelope.candidateId || !envelope.failureHash) throw new Error("blocked plan lineage is not recoverable");
              const candidate = planRun.recoveryCandidates?.get(envelope.candidateId);
              if (!candidate || candidate.failureHash !== envelope.failureHash || candidate.workerSessionId !== planRun.worker.sessionId || planRun.recovery) throw new Error("recovery candidate is stale, foreign, or already continued");
              const generation = candidate.generation + 1;
              const planningIdentity = `${envelope.runId}:${generation}`;
              planRun.recovery = { candidateId: envelope.candidateId, failureHash: envelope.failureHash, generation, planningIdentity, state: "active" };
              watchPlanWorker(envelope.runId, planRun, planRun.worker);
              reply({ requestId: envelope.requestId, state: "accepted", runId: envelope.runId, candidateId: envelope.candidateId, failureHash: envelope.failureHash, generation, planningIdentity });
            } else if (envelope.operation === "bind-recovered-scout") {
              if (!main || planRun.terminal !== "blocked" || !planRun.recovery || planRun.recovery.state !== "active" || planRun.recovery.candidateId !== envelope.candidateId || planRun.recovery.failureHash !== envelope.failureHash || !Number.isSafeInteger(envelope.acceptanceId)) throw new Error("recovered scout binding is invalid");
              if (planRun.scoutAcceptance !== undefined && planRun.scoutAcceptance !== envelope.acceptanceId) throw new Error("recovered scout acceptance changed");
              planRun.scoutAcceptance = envelope.acceptanceId;
              reply({ requestId: envelope.requestId, state: "accepted", runId: envelope.runId, candidateId: envelope.candidateId, acceptanceId: envelope.acceptanceId, generation: planRun.recovery.generation, planningIdentity: planRun.recovery.planningIdentity });
            } else if (envelope.operation === "read-plan-writer-input") {
              if (!worker || !Number.isSafeInteger(planRun.scoutAcceptance) || planRun.terminal && !(planRun.terminal === "blocked" && planRun.recovery?.state === "active")) throw new Error("plan writer input is unavailable");
              reply({ requestId: envelope.requestId, state: "accepted", runId: envelope.runId, acceptanceId: planRun.scoutAcceptance, ...(planRun.recovery ? { candidateId: planRun.recovery.candidateId, failureHash: planRun.recovery.failureHash, generation: planRun.recovery.generation, planningIdentity: planRun.recovery.planningIdentity } : {}) });
            } else {
              if (!worker || planRun.terminal !== "blocked" || !planRun.recovery || planRun.recovery.state !== "active" || planRun.recovery.candidateId !== envelope.candidateId || planRun.recovery.failureHash !== envelope.failureHash || planRun.recovery.generation !== envelope.generation || planRun.scoutAcceptance !== envelope.acceptanceId || !envelope.writerRunId) throw new Error("plan writer is outside the continued recovery lineage");
              reply({ requestId: envelope.requestId, state: "accepted", runId: envelope.runId, candidateId: envelope.candidateId, failureHash: envelope.failureHash, generation: envelope.generation, planningIdentity: planRun.recovery.planningIdentity });
            }
          } catch (error) { reply({ requestId: envelope.requestId, state: "refused", reason: (error as Error).message }); }
          continue;
        }
        if (["register-plan", "bind-plan", "plan-started", "publish-plan-scout", "reject-plan-scout", "prepare-plan-publication", "plan-recorded", "plan-finished", "record-plan"].includes(envelope.operation)) {
          try {
            const ticket = envelope.ticket;
            if (!ticket || !/^[A-Z][A-Z0-9]*-\d+$/.test(ticket)) throw new Error("invalid plan handoff ticket");
            const main = mainOrigin(origin);
            if (envelope.operation === "register-plan") {
              if (!main) throw new Error("only the verified main parent can register a plan run");
              const runId = randomUUID();
              planRuns.set(runId, { ticket, launcher: { ...origin } });
              runOrigins.set(runId, envelope.originId!);
              reply({ requestId: envelope.requestId, state: "accepted", runId });
            } else {
              const planRun = envelope.runId ? planRuns.get(envelope.runId) : undefined;
              if (envelope.operation === "bind-plan") {
                if (!main || !planRun || planRun.ticket !== ticket || (!planRun.listRunId && !sameProcess(planRun.launcher, origin)) || planRun.pane || !envelope.pane) throw new Error("invalid parent-owned plan pane binding");
                planRun.pane = envelope.pane;
                reply({ requestId: envelope.requestId, state: "accepted", runId: envelope.runId });
              } else if (envelope.operation === "plan-started") {
                const owner = paneOwner(origin);
                if (!planRun || !envelope.runId || planRun.ticket !== ticket || origin.mode !== "plan" || origin.ticket !== ticket || origin.role !== "coordinator" || origin.pane !== planRun.pane || !owner || owner.mode !== "plan" || owner.ticket !== ticket || owner.role !== "coordinator" || planRun.worker && !sameProcess(planRun.worker, owner)) throw new Error("invalid plan worker identity");
                if (origin.pid !== owner.pid || origin.starttime !== owner.starttime) throw new Error("invalid plan worker identity");
                const firstRegistration = !planRun.worker;
                planRun.worker = owner;
                if (firstRegistration) watchPlanWorker(envelope.runId, planRun, planRun.worker);
                reply({ requestId: envelope.requestId, state: "accepted", runId: envelope.runId });
              } else {
                if (["plan-finished", "record-plan"].includes(envelope.operation)) {
                  if (!registeredWorker(planRun, ticket, origin)) throw new Error("plan result is not from its registered live worker");
                  if (planRun?.terminal === "recorded" && envelope.operation === "record-plan") { reply({ requestId: envelope.requestId, state: "accepted", ...planRun.recordReply }); continue; }
                  const continuedRecovery = envelope.operation === "record-plan" && planRun?.terminal === "blocked" && planRun.recovery?.state === "active";
                  const finishingRecording = envelope.operation === "plan-finished" && planRun?.terminal === "recording";
                  if (planRun?.terminal && !finishingRecording && !continuedRecovery || !main && !planRun) throw new Error("plan run is no longer active");
                  if (envelope.operation === "plan-finished") {
                    if (!planRun || !envelope.runId || !envelope.outcome || !envelope.reason || !parent.planFinished) throw new Error("plan finish handoff is unavailable");
                    fencePlanRun(planRun, envelope.outcome);
                    await parent.planFinished(ticket, envelope.runId, envelope.outcome, envelope.reason, origin);
                    reply({ requestId: envelope.requestId, state: "accepted", runId: envelope.runId });
                  } else {
                  if (!envelope.path || !envelope.runId || !parent.recordPlan) throw new Error("plan record handoff is unavailable");
                  if (planRun) planRun.terminal = "recording";
                  try {
                    const acceptanceId = planRun?.scoutAcceptance;
                    if (!Number.isSafeInteger(acceptanceId)) throw new Error("plan record requires a current accepted scout");
                    const outcome = await parent.recordPlan(ticket, envelope.path, origin, envelope.runId, acceptanceId!);
                    if (planRun?.terminal !== "recording") throw new Error("plan recorder was superseded by logical stop");
                    if (planRun) {
                      planRun.terminal = "recorded";
                      if (planRun.recovery) planRun.recovery.state = "recorded";
                      planRun.recordReply = outcome;
                      planRun.pendingExit = undefined;
                      planRun.observer?.stop();
                      planRun.observer = undefined;
                    }
                    reply({ requestId: envelope.requestId, state: "accepted", ...outcome });
                  } catch (error) {
                    if (planRun?.terminal === "recording") {
                      planRun.terminal = /cancelled before lock acquisition/.test((error as Error).message) ? "cancelled" : continuedRecovery ? "blocked" : undefined;
                      const pendingExit = planRun.pendingExit;
                      planRun.pendingExit = undefined;
                      if (!planRun.terminal && pendingExit && envelope.runId) setImmediate(() => void finishExitedPlan(envelope.runId!, planRun, pendingExit));
                    }
                    throw error;
                  }
                  }
                } else {
                if (planRun?.terminal) throw new Error("plan run is no longer active");
                const keyedWorker = registeredWorker(planRun, ticket, origin);
                const problemWorker = !planRun && origin.mode === "plan" && !origin.ticket && origin.role === "coordinator";
                const packageKey = problemKey(origin);
                let packageState = problemPackages.get(packageKey);
                if (packageState && !processMatches(packageState.owner.pid, packageState.owner.starttime)) {
                  problemPackages.delete(packageKey);
                  packageState = undefined;
                }
                const problemOwner = problemWorker ? paneOwner(origin) : undefined;
                const registeredProblemWorker = problemWorker && !!problemOwner && (!packageState || sameProcess(packageState.owner, problemOwner) && descendantOf(origin.pid, origin.starttime, problemOwner.pid, problemOwner.starttime));
                const packageTickets = packageState?.tickets;
                const legacyMain = !planRun && main;
                if (!legacyMain && !keyedWorker && !(registeredProblemWorker && (["publish-plan-scout", "reject-plan-scout"].includes(envelope.operation) || packageTickets?.has(ticket)))) throw new Error("plan operation is not from its registered live worker");
                const scoutKey = `${origin.sessionId}\u0000${origin.pane ?? ""}\u0000${ticket}`;
                const requestGenerations = planRun ? (planRun.scoutRequests ??= new Map<number, number>()) : scoutRequests.get(scoutKey) ?? new Map<number, number>();
                if (!planRun && !scoutRequests.has(scoutKey)) scoutRequests.set(scoutKey, requestGenerations);
                const finalized = planRun ? (planRun.finalizedScoutAcceptances ??= new Set<number>()) : finalizedScoutAcceptances.get(scoutKey) ?? new Set<number>();
                if (!planRun && !finalizedScoutAcceptances.has(scoutKey)) finalizedScoutAcceptances.set(scoutKey, finalized);
                if (envelope.operation === "publish-plan-scout") {
                  if (!Number.isSafeInteger(envelope.acceptanceId) || !parent.publishPlanScout) throw new Error("plan scout publication is unavailable");
                  if (finalized.has(envelope.acceptanceId!)) throw new Error("scout artifact is superseded");
                  const currentAcceptance = planRun?.scoutAcceptance ?? scoutAcceptances.get(scoutKey);
                  if (currentAcceptance !== undefined && currentAcceptance !== envelope.acceptanceId) finalized.add(currentAcceptance);
                  const generation = planRun ? (planRun.scoutGeneration = (planRun.scoutGeneration ?? 0) + 1) : (scoutGenerations.get(scoutKey) ?? 0) + 1;
                  if (!planRun) scoutGenerations.set(scoutKey, generation);
                  requestGenerations.set(envelope.acceptanceId!, generation);
                  const outcome = await parent.publishPlanScout(ticket, envelope.acceptanceId!, origin);
                  const currentGeneration = planRun ? planRun.scoutGeneration : scoutGenerations.get(scoutKey);
                  if (currentGeneration !== generation) {
                    requestGenerations.delete(envelope.acceptanceId!);
                    finalized.add(envelope.acceptanceId!);
                    reply({ requestId: envelope.requestId, state: "accepted", acceptanceId: envelope.acceptanceId, ...outcome, artifactAcceptance: "superseded", reason: "scout superseded" });
                    continue;
                  }
                  requestGenerations.clear();
                  requestGenerations.set(envelope.acceptanceId!, generation);
                  if (planRun) planRun.scoutAcceptance = envelope.acceptanceId;
                  else scoutAcceptances.set(scoutKey, envelope.acceptanceId!);
                  if (registeredProblemWorker) {
                    const accepted = packageState ?? { owner: { ...problemOwner! }, tickets: new Set<string>() };
                    accepted.tickets.add(ticket);
                    problemPackages.set(packageKey, accepted);
                  }
                  reply({ requestId: envelope.requestId, state: "accepted", acceptanceId: envelope.acceptanceId, ...outcome, artifactAcceptance: "accepted" });
                } else if (envelope.operation === "reject-plan-scout") {
                  const currentGeneration = planRun ? planRun.scoutGeneration : scoutGenerations.get(scoutKey);
                  const ownedGeneration = Number.isSafeInteger(envelope.acceptanceId) ? requestGenerations.get(envelope.acceptanceId!) : currentGeneration;
                  if (ownedGeneration === currentGeneration) {
                    requestGenerations.clear();
                    if (Number.isSafeInteger(envelope.acceptanceId)) finalized.add(envelope.acceptanceId!);
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
                  const generation = planRun?.scoutGeneration ?? scoutGenerations.get(scoutKey) ?? 0;
                  const outcome = await parent.preparePlanPublication(ticket, envelope.path, envelope.contentHash, acceptanceId!, origin, envelope.runId, generation);
                  if (planRun?.terminal || (planRun && planRun.scoutGeneration !== generation)) throw new Error("plan run is no longer active");
                  reply({ requestId: envelope.requestId, state: "accepted", ...outcome });
                } else {
                  if (!envelope.path || !Number.isSafeInteger(envelope.recordId) || !parent.planRecorded) throw new Error("plan record handoff is unavailable");
                  const generation = planRun?.scoutGeneration ?? scoutGenerations.get(scoutKey) ?? 0;
                  const outcome = await parent.planRecorded(ticket, envelope.path, envelope.recordId!, origin, undefined, envelope.runId, generation);
                  if (planRun?.terminal || (planRun && (planRun.scoutGeneration ?? 0) !== generation)) throw new Error("plan run is no longer active");
                  reply({ requestId: envelope.requestId, state: "accepted", recordId: envelope.recordId, ...outcome });
                }
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
          const registeredOriginId = runOrigins.get(envelope.runId);
          if (!registeredOriginId) { reply({ requestId: envelope.requestId, state: "accepted", runId: envelope.runId, cancellation: cancellationResult(envelope.runId, "unknown", "unknown", false) }); continue; }
          const registeredOrigin = origins.get(registeredOriginId);
          if (!registeredOrigin || !sameProcess(validateBoundOrigin(registeredOrigin), origin)) { reply({ requestId: envelope.requestId, state: "accepted", runId: envelope.runId, cancellation: cancellationResult(envelope.runId, "coordinator", "not_owned", false, "coordinator run belongs to another owner") }); continue; }
          for (const [planRunId, planRun] of planRuns) if (planRunId === envelope.runId || planRun.listRunId === envelope.runId) {
            if (planRun.terminal === "blocked" && planRun.recovery?.state === "active") planRun.recovery.state = "cancelled";
            else if (planRun.terminal !== "recording" && !planRun.terminal) planRun.terminal = "cancelled";
            else continue;
            planRun.observer?.stop();
            planRun.observer = undefined;
          }
          try { const cancellation = await parent.cancel(envelope.runId, origin) ?? cancellationResult(envelope.runId, "coordinator", "cancelled", true); reply({ requestId: envelope.requestId, state: "accepted", runId: envelope.runId, cancellation }); }
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
  server.on("close", () => {
    for (const planRun of planRuns.values()) planRun.observer?.stop();
    rmSync(sock, { force: true });
    rmSync(`${sock}.json`, { force: true });
  });
  server.listen(sock);
  writeFileSync(`${sock}.json`, JSON.stringify({ root: canonicalRoot, pid: identity.pid, starttime: identity.starttime, sessionId: identity.sessionId, runtimeId: identity.runtimeId, cwd: identity.cwd, pane: identity.pane }), { mode: 0o600 });
  return server;
}

function send(root: string, envelope: ControlEnvelope, env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<ControlReply> {
  return new Promise((resolvePromise) => {
    const connection = net.createConnection(coordinatorSocketPath(root, env));
    let buffer = "";
    let settled = false;
    const finish = (reply: ControlReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.destroy();
      resolvePromise(reply);
    };
    const timer = setTimeout(() => finish({ requestId: envelope.requestId, state: "refused", reason: `coordinator control timed out after ${timeoutMs}ms` }), timeoutMs);
    connection.on("connect", () => connection.write(JSON.stringify(envelope) + "\n"));
    connection.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n"); if (newline < 0) return;
        let reply: ControlReply;
        try { reply = JSON.parse(buffer.slice(0, newline)) as ControlReply; }
        catch { finish({ requestId: envelope.requestId, state: "refused", reason: "invalid coordinator control reply" }); return; }
        buffer = buffer.slice(newline + 1);
        if (reply.state !== "received") { finish(reply); return; }
      }
    });
    connection.on("error", (error) => finish({ requestId: envelope.requestId, state: "refused", reason: error.message }));
    connection.on("end", () => finish({ requestId: envelope.requestId, state: "refused", reason: "coordinator control closed before a final reply" }));
    connection.on("close", () => finish({ requestId: envelope.requestId, state: "refused", reason: "coordinator control connection closed" }));
  });
}

export function resolveCoordinatorParent(root: string, env: NodeJS.ProcessEnv = process.env): ParentIdentity {
  const sidecar = `${coordinatorSocketPath(root, env)}.json`;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(sidecar, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("coordinator parent sidecar is missing");
    throw new Error("coordinator parent sidecar is invalid");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("coordinator parent sidecar is invalid");
  const parsed = raw as Record<string, unknown>;
  if (typeof parsed.root !== "string" || !parsed.root || typeof parsed.sessionId !== "string" || !parsed.sessionId || typeof parsed.runtimeId !== "string" || !parsed.runtimeId || !Number.isSafeInteger(parsed.pid) || Number(parsed.pid) <= 0 || typeof parsed.starttime !== "string" || !parsed.starttime || typeof parsed.cwd !== "string" || !parsed.cwd || !(parsed.pane === undefined || typeof parsed.pane === "string")) throw new Error("coordinator parent sidecar is invalid");
  if (!processMatches(parsed.pid as number, parsed.starttime)) throw new Error("coordinator parent is stale");
  if (resolve(parsed.root) !== resolve(root)) throw new Error("coordinator parent root mismatch");
  return parsed as unknown as ParentIdentity;
}

export async function requestCoordinator(root: string, request: CoordinatorRequest, origin: ControlOrigin, target: Pick<ParentIdentity, "sessionId" | "runtimeId">, env: NodeJS.ProcessEnv = process.env): Promise<ControlReply> {
  const attach = await send(root, { version: 1, operation: "attach-origin", requestId: randomUUID(), origin, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId }, env);
  if (attach.state !== "accepted" || !attach.originId) return attach;
  return send(root, { version: 1, operation: "launch", requestId: randomUUID(), originId: attach.originId, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId, request }, env);
}

export async function requestCoordinatorCancel(root: string, runId: string, origin: ControlOrigin, target: Pick<ParentIdentity, "sessionId" | "runtimeId">, env: NodeJS.ProcessEnv = process.env): Promise<ControlReply> {
  const attach = await send(root, { version: 1, operation: "attach-origin", requestId: randomUUID(), origin, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId }, env);
  if (attach.state !== "accepted" || !attach.originId) return attach;
  return send(root, { version: 1, operation: "cancel", requestId: randomUUID(), originId: attach.originId, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId, runId }, env);
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

export async function requestPlanControl(root: string, operation: PlanControlOperation, payload: { ticket: string; path?: string; pane?: string; runId?: string; outcome?: "blocked" | "cancelled"; reason?: string; publicationId?: number; acceptanceId?: number; recordId?: number; contentHash?: string; candidateId?: string; failureHash?: string; generation?: number; writerRunId?: string }, origin: ControlOrigin, target: Pick<ParentIdentity, "sessionId" | "runtimeId">, env: NodeJS.ProcessEnv = process.env): Promise<ControlReply> {
  const attach = await send(root, { version: 1, operation: "attach-origin", requestId: randomUUID(), origin, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId }, env);
  if (attach.state !== "accepted" || !attach.originId) return attach;
  return send(root, { version: 1, operation, requestId: randomUUID(), originId: attach.originId, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId, ...payload }, env);
}

export async function requestReviewControl(root: string, operation: ReviewControlOperation, payload: { ticket: string; path?: string; pane?: string; surface?: "tab" | "split"; tabId?: string; workerRuntimeId?: string; runId?: string; raw?: string; generation?: ReviewInputGeneration; extraction?: ReviewReworkExtraction; reason?: string }, origin: ControlOrigin, target: Pick<ParentIdentity, "sessionId" | "runtimeId">, env: NodeJS.ProcessEnv = process.env, timeoutMs = 30_000): Promise<ControlReply> {
  const attach = await send(root, { version: 1, operation: "attach-origin", requestId: randomUUID(), origin, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId }, env, timeoutMs);
  if (attach.state !== "accepted" || !attach.originId) return attach;
  return send(root, { version: 1, operation, requestId: randomUUID(), originId: attach.originId, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId, ...payload }, env, timeoutMs);
}

function reviewTransportFailure(reply: ControlReply): boolean {
  return reply.state === "refused" && /coordinator control (?:timed out|closed|connection closed)|ECONN|EPIPE|socket/i.test(reply.reason ?? "");
}

export async function requestReviewRecordWithStatus(root: string, payload: { ticket: string; path: string; runId: string }, origin: ControlOrigin, target: Pick<ParentIdentity, "sessionId" | "runtimeId">, env: NodeJS.ProcessEnv = process.env, options: { recordTimeoutMs?: number; statusTimeoutMs?: number; pollMs?: number } = {}): Promise<ControlReply> {
  const recordTimeoutMs = options.recordTimeoutMs ?? 30_000;
  const statusTimeoutMs = options.statusTimeoutMs ?? 120_000;
  const pollMs = options.pollMs ?? 250;
  const reply = await requestReviewControl(root, "review-record", payload, origin, target, env, recordTimeoutMs);
  if (!reviewTransportFailure(reply)) return reply;
  const deadline = Date.now() + statusTimeoutMs;
  let last = reply;
  while (Date.now() < deadline) {
    const status = await requestReviewControl(root, "review-status", { ticket: payload.ticket, runId: payload.runId }, origin, target, env, Math.min(30_000, Math.max(1, deadline - Date.now())));
    if (status.rework) return { ...status, state: "accepted" };
    if (status.state === "refused" && !reviewTransportFailure(status)) return status;
    last = status;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
  return { ...last, state: "refused", reason: `review handoff status timed out after ${statusTimeoutMs}ms; initial transport: ${reply.reason ?? "unavailable"}` };
}

export function currentControlOrigin(root: string, sessionId = process.env.PI_SESSION_ID): ControlOrigin {
  if (!sessionId) throw new Error("PI_SESSION_ID is required for coordinator control");
  const starttime = processStarttime(process.pid);
  if (!starttime) throw new Error("cannot read coordinator origin process starttime");
  const mode = controlPaneMode(process.env.YOKEMATE_MODE, "origin");
  return { sessionId, runtimeId: process.env.YOKEMATE_REVIEW_RUNTIME_ID, pid: process.pid, starttime, cwd: root, pane: process.env.HERDR_PANE_ID, parentPane: process.env.YOKEMATE_PARENT_PANE, mode, ticket: process.env.YOKEMATE_TICKET, role: process.env.YOKEMATE_ROLE };
}
