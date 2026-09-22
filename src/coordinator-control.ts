import * as net from "node:net";
import { DatabaseSync } from "node:sqlite";
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
import { assertPlanBinding, readRecordedPlanBinding, type PlanBinding } from "./plan-binding.ts";
import type { ChildIdentity } from "./subagent-runs.ts";

import { assertMandatoryBoundary } from "./workflow-boundaries.ts";
import type { ReviewHandoffOutcome, ReviewInputGeneration, ReviewReworkExtraction, ReviewSurfaceIdentity } from "./review-rework.ts";
import { cancellationResult, type CancellationResult } from "./subagent-runs.ts";
import { PlanApproachStore, type PlanApproachProposal } from "./plan-approach.ts";

export interface ControlOrigin { sessionId: string; runtimeId?: string; pid: number; starttime: string; cwd: string; pane?: string; parentPane?: string; mode?: string; ticket?: string; role?: string }
export interface ControlEnvelope { version: 1; operation: "attach-origin" | "launch" | "launch-plan" | "merge" | "ship-finalize" | "finish" | "status" | "cancel" | PlanControlOperation | ReviewControlOperation; ticket?: string; path?: string; pane?: string; surface?: "tab" | "split"; tabId?: string; workerRuntimeId?: string; raw?: string; generation?: ReviewInputGeneration | number; extraction?: ReviewReworkExtraction; outcome?: "blocked" | "cancelled"; reason?: string; requestId: string; toolCallId?: string; originId?: string; origin?: ControlOrigin; targetSessionId?: string; targetRuntimeId?: string; request?: CoordinatorRequest; planRequest?: PlanLaunchRequest; mergeRequest?: CoordinatorMergeRequest; runId?: string; listRunId?: string; keyRunId?: string; targetRequestId?: string; publicationId?: number; acceptanceId?: number; recordId?: number; contentHash?: string; child?: ChildIdentity; scoutSequence?: number; candidateId?: string; failureHash?: string; writerRunId?: string; facts?: Record<string, unknown> }
export interface ControlResult { key: string; keyRunId: string; state: "accepted" | "refused"; reservation?: "ready" | "queued"; reason?: string; identity?: unknown }
export interface ControlReply { requestId: string; state: "received" | "accepted" | "refused" | "status"; reason?: string; runId?: string; listRunId?: string; keyRunId?: string; originId?: string; identity?: unknown; cancellation?: CancellationResult; merge?: CoordinatorMergeResult; finalization?: ShipFinalizeResult; results?: ControlResult[]; publicationId?: number; acceptanceId?: number; artifactAcceptance?: "accepted" | "superseded"; recordId?: number; publication?: "complete" | "pending"; publications?: PublicationOutcome[]; handoff?: PlanHandoff; target?: string; revision?: string; snapshotPath?: string; scoutPublication?: number; scoutAcceptance?: number; generation?: ReviewInputGeneration | number; rework?: ReviewHandoffOutcome; facts?: Record<string, unknown>; candidateId?: string; failureHash?: string; planningIdentity?: string }
export type PlanControlOperation = "register-plan" | "bind-plan" | "plan-started" | "register-group-plan-scope" | "plan-approach-present" | "plan-input" | "plan-approach-extraction" | "group-plan-activated" | "publish-plan-scout" | "reject-plan-scout" | "prepare-plan-publication" | "plan-recorded" | "plan-finished" | "record-plan" | "register-scout-candidate" | "read-scout-candidate" | "continue-scout-candidate" | "bind-recovered-scout" | "read-plan-writer-input" | "admit-plan-writer";
export type ReviewControlOperation = "register-review" | "bind-review" | "review-started" | "review-input" | "review-extraction" | "review-record" | "review-status" | "review-ended";
export type PlanHandoff = "plan-only" | "unavailable" | "started" | "refused";
export interface PlanRecordOutcome { runId?: string; reason: string; facts?: Record<string, unknown>; publication?: "complete" | "pending"; publications?: PublicationOutcome[]; handoff?: PlanHandoff; target?: string; revision?: string }
export type PlanCompletionContext = { kind: "registered"; runId: string; listRunId?: string } | { kind: "save-only"; admissionId: string } | { kind: "main" } | { kind: "problem"; packageKey: string };
export interface ParentControl { groupPlanActivated?(ticket: string, context: Extract<PlanCompletionContext, { kind: "registered" }>, facts: Record<string, unknown>, origin: ControlOrigin, approach: { store: PlanApproachStore; proposal: PlanApproachProposal }): Promise<void> | void; publishPlanScout?(ticket: string, acceptanceId: number, child: ChildIdentity, origin: ControlOrigin): Promise<{ reason: string; publication: "complete" | "pending"; target: string; revision: string; publicationId?: number }>; preparePlanPublication?(ticket: string, path: string, contentHash: string, acceptanceId: number, origin: ControlOrigin, context: PlanCompletionContext): Promise<{ reason: string; recordId: number; snapshotPath: string; scoutAcceptance: number; revision: string; binding: PlanBinding; publicationId?: number; scoutPublication?: number; target?: string }>; recordPlan?(ticket: string, path: string, origin: ControlOrigin, context: PlanCompletionContext, acceptanceId: number, verifyCompletion: (binding: PlanBinding) => void, contentHash: string): Promise<PlanRecordOutcome>; planRecorded?(ticket: string, path: string, recordId: number, origin: ControlOrigin, context: PlanCompletionContext, verifyCompletion: (binding: PlanBinding) => void, prior: PlanRecordOutcome | undefined, contentHash: string): Promise<PlanRecordOutcome>; planFinished?(ticket: string, context: PlanCompletionContext, outcome: "blocked" | "cancelled", reason: string, origin: ControlOrigin, groupScope?: { groupId: string; treeHash: string }): Promise<void>; reviewStarted?(ticket: string, runId: string, origin: ControlOrigin, surface: ReviewSurfaceIdentity): Promise<void> | void; reviewInput?(ticket: string, runId: string, raw: string, origin: ControlOrigin): Promise<ReviewInputGeneration> | ReviewInputGeneration; reviewExtraction?(ticket: string, runId: string, extraction: ReviewReworkExtraction, generation: ReviewInputGeneration, origin: ControlOrigin): Promise<void> | void; reviewRecord?(ticket: string, runId: string, path: string, origin: ControlOrigin, facts?: Record<string, unknown>): Promise<ReviewHandoffOutcome>; reviewStatus?(ticket: string, runId: string, origin: ControlOrigin): Promise<ReviewHandoffOutcome | undefined> | ReviewHandoffOutcome | undefined; reviewEnded?(ticket: string, runId: string, reason: string, origin: ControlOrigin): Promise<void> | void; planRegistered?(ticket: string, runId: string, origin: ControlOrigin, dispatch: { requestId: string; toolCallId?: string }): void; launchPlan?(request: PlanLaunchRequest, origin: ControlOrigin, dispatch: { requestId: string; toolCallId?: string }): Promise<{ listRunId: string; results: ControlResult[] }>; launch(request: CoordinatorRequest, origin: ControlOrigin, dispatch: { requestId: string; toolCallId?: string }): Promise<{ runId?: string; listRunId?: string; identity?: unknown; results?: ControlResult[]; afterAck?(): void }>; merge?(runId: string, request: CoordinatorMergeRequest, origin: ControlOrigin): Promise<CoordinatorMergeResult>; finalizeShip?(runId: string, origin: ControlOrigin): Promise<ShipFinalizeResult>; finish?(runId: string, outcome: "done" | "blocked", summary: string, reason: string | undefined, origin: ControlOrigin): Promise<void>; status(requestId: string, origin: ControlOrigin): ControlReply; cancel(runId: string, origin: ControlOrigin): Promise<CancellationResult | void> }
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
  recordPath?: string;
  recordContentHash?: string;
  recordId?: number;
  recordAcceptance?: number;
  recordBinding?: PlanBinding;
  recordReply?: PlanRecordOutcome;
  recordPromise?: Promise<PlanRecordOutcome>;
  pendingExit?: ControlOrigin;
  observer?: PlanProcessObserver;
  scoutAcceptance?: number;
  scoutGeneration?: number;
  scoutRequests?: Map<number, number>;
  finalizedScoutAcceptances?: Set<number>;
  recoveryCandidates?: Map<string, { failureHash: string; generation: number; workerSessionId: string }>;
  recovery?: { candidateId: string; failureHash: string; generation: number; planningIdentity: string; state: "active" | "cancelled" | "recorded" };
  scoutChildren?: Map<number, ChildIdentity>;
  prepared?: PreparedPlanRecord;
  groupScope?: { groupId: string; treeHash: string; ownerProject: string; members: Set<string> };
  approachStore?: PlanApproachStore;
  approachProposal?: PlanApproachProposal;
}

interface PreparedPlanRecord {
  recordId: number;
  path: string;
  requestedPath: string;
  contentHash: string;
  acceptanceId: number;
  binding: PlanBinding;
  snapshotPath: string;
}

interface SaveOnlyWorker {
  admissionId: string;
  ticket: string;
  owner: ControlOrigin;
  admitted: boolean;
  childOwner: Pick<ChildIdentity, "ownerRunId" | "ownerSessionId">;
  scoutAcceptance?: number;
  scoutGeneration: number;
  scoutRequests: Map<number, number>;
  finalizedScoutAcceptances: Set<number>;
  scoutChildren: Map<number, ChildIdentity>;
  prepared?: PreparedPlanRecord;
  terminal?: "recording" | "recorded";
  recordPath?: string;
  recordContentHash?: string;
  recordId?: number;
  recordBinding?: PlanBinding;
  recordReply?: PlanRecordOutcome;
  recordPromise?: Promise<PlanRecordOutcome>;
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
  const saveOnlyWorkers = new Map<string, SaveOnlyWorker>();
  const saveOnlyApproaches = new Map<string, { store: PlanApproachStore; proposal: PlanApproachProposal }>();
  const problemPackages = new Map<string, { owner: ControlOrigin; tickets: Set<string> }>();
  const scoutAcceptances = new Map<string, number>();
  const scoutGenerations = new Map<string, number>();
  const scoutReservations = new Map<string, { child: ChildIdentity; sequence: number }>();
  const scoutRequests = new Map<string, Map<number, number>>();
  const finalizedScoutAcceptances = new Map<string, Set<number>>();
  const scoutChildren = new Map<string, Map<number, ChildIdentity>>();
  const preparedPlans = new Map<string, PreparedPlanRecord>();
  const numericRecords = new Map<string, { owner: ControlOrigin; path: string; contentHash: string; recordId: number; binding?: PlanBinding; promise?: Promise<PlanRecordOutcome>; reply?: PlanRecordOutcome }>();
  const completedNumericRecords = new Map<string, { path: string; contentHash: string; binding: PlanBinding; contextKind: PlanCompletionContext["kind"]; reply: PlanRecordOutcome }>();
  const preparedNumericContexts = new Map<string, { path: string; contentHash: string; context: Extract<PlanCompletionContext, { kind: "save-only" }>; worker: SaveOnlyWorker; prepared: PreparedPlanRecord }>();
  const inflightNumericRecords = new Map<string, { path: string; contentHash: string; contextKind: PlanCompletionContext["kind"]; promise: Promise<{ outcome: PlanRecordOutcome; binding: PlanBinding }> }>();
  const sameProcess = (a: ControlOrigin, b: ControlOrigin) => a.pid === b.pid && a.starttime === b.starttime && a.sessionId === b.sessionId && a.pane === b.pane && a.parentPane === b.parentPane && a.mode === b.mode && a.ticket === b.ticket && a.role === b.role && resolve(a.cwd) === resolve(b.cwd);
  const problemKey = (origin: ControlOrigin) => `${origin.sessionId}\u0000${origin.pane ?? ""}`;
  const origins = new Map<string, BoundOrigin>();
  const panes = new Map<string, PaneRegistration>();
  if (identity.pane) panes.set(identity.pane, { pane: identity.pane, pid: identity.pid, starttime: identity.starttime, sessionId: identity.sessionId });
  const saveOnlyKey = (origin: ControlOrigin, ticket: string) => `${origin.sessionId}\u0000${origin.pane ?? ""}\u0000${ticket}`;
  const childMatches = (a: ChildIdentity, b: ChildIdentity) => a.ownerRunId === b.ownerRunId && a.ownerSessionId === b.ownerSessionId && a.batchId === b.batchId && a.runId === b.runId && a.agent === b.agent && a.taskHash === b.taskHash && resolve(a.cwd) === resolve(b.cwd) && a.ticket === b.ticket;
  const childOwnerMatches = (owner: Pick<ChildIdentity, "ownerRunId" | "ownerSessionId">, child: ChildIdentity) => owner.ownerRunId === child.ownerRunId && owner.ownerSessionId === child.ownerSessionId;
  const validScoutChild = (child: ChildIdentity | undefined, ticket: string, origin: ControlOrigin) => !!child && [child.ownerRunId, child.ownerSessionId, child.batchId, child.runId, child.taskHash, child.cwd].every((value) => typeof value === "string" && value.length > 0) && child.agent === "plan-scout" && child.ticket === ticket && child.ownerSessionId === origin.sessionId && resolve(child.cwd) === canonicalRoot;
  const paneOwnerMatches = (origin: ControlOrigin, ticket: string): boolean => {
    if (!origin.pane || origin.mode !== "plan" || origin.role !== "coordinator" || origin.ticket !== ticket || resolve(origin.cwd) !== canonicalRoot) return false;
    try {
      const panel = JSON.parse(readFileSync(join(socketDir(env, uid), `${origin.pane}.json`), "utf8")) as { pid?: number; cwd?: string; mode?: string; ticket?: string | null };
      const starttime = panel.pid ? processStarttime(panel.pid) : undefined;
      return panel.pid === origin.pid && starttime === origin.starttime && resolve(panel.cwd ?? "") === canonicalRoot && panel.mode === "plan" && panel.ticket === ticket;
    } catch { return false; }
  };
  const problemOwnerMatches = (origin: ControlOrigin): boolean => {
    if (!origin.pane || origin.mode !== "plan" || origin.role !== "coordinator" || origin.ticket !== undefined || resolve(origin.cwd) !== canonicalRoot) return false;
    try {
      const panel = JSON.parse(readFileSync(join(socketDir(env, uid), `${origin.pane}.json`), "utf8")) as { pid?: number; cwd?: string; mode?: string; ticket?: string | null };
      const starttime = panel.pid ? processStarttime(panel.pid) : undefined;
      return panel.pid === origin.pid && starttime === origin.starttime && resolve(panel.cwd ?? "") === canonicalRoot && panel.mode === "plan" && (panel.ticket ?? undefined) === undefined;
    } catch { return false; }
  };
  const ownerLive = (owner: ControlOrigin, ticket: string) => processMatches(owner.pid, owner.starttime) && paneOwnerMatches(owner, ticket);
  const ownerOrDescendant = (origin: ControlOrigin, owner: ControlOrigin, ticket: string) => ownerLive(owner, ticket) && origin.sessionId === owner.sessionId && origin.pane === owner.pane && origin.mode === "plan" && origin.role === "coordinator" && origin.ticket === ticket && descendantOf(origin.pid, origin.starttime, owner.pid, owner.starttime);
  const launchRequests = new Map<string, { origin: ControlOrigin; fingerprint: string; promise: Promise<{ reply: ControlReply; afterAck?: () => void }> }>();
  const requestOrigins = new Map<string, string>();
  const requestRuns = new Map<string, string[]>();
  const requestLists = new Map<string, string>();
  const runOrigins = new Map<string, string>();
  const fencePlanRun = (planRun: PlanRunState, terminal: "blocked" | "cancelled"): void => {
    planRun.approachStore?.revoke();
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
      await parent.planFinished(planRun.ticket, { kind: "registered", runId, ...(planRun.listRunId ? { listRunId: planRun.listRunId } : {}) }, "cancelled", "plan worker process ended before a terminal record", worker, planRun.groupScope ? { groupId: planRun.groupScope.groupId, treeHash: planRun.groupScope.treeHash } : undefined);
    } catch {
      if (planRun.terminal === "cancelled") planRun.terminal = undefined;
    }
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
  const registeredWorker = (planRun: PlanRunState | undefined, ticket: string, origin: ControlOrigin): boolean => !!planRun?.worker && (planRun.ticket === ticket || planRun.groupScope?.members.has(ticket) === true) && origin.mode === "plan" && origin.ticket === planRun.ticket && origin.role === "coordinator" && origin.pane === planRun.pane && origin.sessionId === planRun.worker.sessionId && descendantOf(origin.pid, origin.starttime, planRun.worker.pid, planRun.worker.starttime);
  const verifyRecordedRetry = (ticket: string, binding: PlanBinding | undefined, requestedPath?: string, contentHash?: string): void => {
    try {
      const current = readRecordedPlanBinding(canonicalRoot, ticket);
      if (binding) assertPlanBinding(binding, current);
      else if (!requestedPath || !contentHash || resolve(current.path) !== resolve(requestedPath) || current.contentHash !== contentHash) throw new Error("binding changed");
    } catch { throw new Error(binding ? "recorded plan retry binding changed" : "recorded plan retry binding is unavailable"); }
  };
  const planOperations = new Set<PlanControlOperation>(["register-plan", "bind-plan", "plan-started", "register-group-plan-scope", "plan-approach-present", "plan-input", "plan-approach-extraction", "group-plan-activated", "publish-plan-scout", "reject-plan-scout", "prepare-plan-publication", "plan-recorded", "plan-finished", "record-plan"]);
  const handlePlanControl = async (envelope: ControlEnvelope, origin: ControlOrigin): Promise<ControlReply> => {
    const ticket = envelope.ticket;
    if (!ticket || !/^[A-Z][A-Z0-9]*-\d+$/.test(ticket)) throw new Error("invalid plan handoff ticket");
    const main = mainOrigin(origin);
    if (envelope.operation === "register-plan") {
      if (!main) throw new Error("only the verified main parent can register a plan run");
      const runId = randomUUID();
      planRuns.set(runId, { ticket, launcher: { ...origin } });
      parent.planRegistered?.(ticket, runId, origin, { requestId: envelope.requestId, toolCallId: envelope.toolCallId });
      runOrigins.set(runId, envelope.originId!);
      return { requestId: envelope.requestId, state: "accepted", runId };
    }
    const runIdPresented = envelope.runId !== undefined;
    if (runIdPresented && (!envelope.runId || !planRuns.has(envelope.runId))) throw new Error("invalid or inactive plan run id");
    const planRun = envelope.runId ? planRuns.get(envelope.runId) : undefined;
    if (planRun && planRun.ticket !== ticket && !planRun.groupScope?.members.has(ticket)) throw new Error("plan run ticket mismatch");
    const continuedRecovery = envelope.operation === "record-plan" && planRun?.terminal === "blocked" && planRun.recovery?.state === "active";
    const finishingRecording = envelope.operation === "plan-finished" && planRun?.terminal === "recording";
    if (planRun?.terminal && !continuedRecovery && !finishingRecording && !(["recording", "recorded"].includes(planRun.terminal) && (envelope.operation === "record-plan" || envelope.operation === "plan-recorded"))) throw new Error("plan run is no longer active");
    if (!runIdPresented && [...planRuns.values()].some((candidate) => candidate.ticket === ticket && candidate.pane && candidate.pane === origin.pane)) throw new Error("registered plan worker did not present its run id");
    if (envelope.operation === "bind-plan") {
      if (!main || !planRun || !envelope.runId || (!planRun.listRunId && !sameProcess(planRun.launcher, origin)) || planRun.pane || !envelope.pane) throw new Error("invalid parent-owned plan pane binding");
      planRun.pane = envelope.pane;
      return { requestId: envelope.requestId, state: "accepted", runId: envelope.runId };
    }
    if (envelope.operation === "plan-started") {
      if (!planRun || !envelope.runId || planRun.terminal || origin.mode !== "plan" || origin.role !== "coordinator" || origin.ticket !== ticket || origin.pane !== planRun.pane || !paneOwnerMatches(origin, ticket) || planRun.worker && !sameProcess(planRun.worker, origin)) throw new Error("invalid plan worker identity");
      const firstRegistration = !planRun.worker;
      planRun.worker = { ...origin };
      if (firstRegistration) watchPlanWorker(envelope.runId, planRun, planRun.worker);
      return { requestId: envelope.requestId, state: "accepted", runId: envelope.runId };
    }
    if (envelope.operation === "register-group-plan-scope") {
      if (!planRun || !envelope.runId || !planRun.worker || !registeredWorker(planRun, planRun.ticket, origin) || !envelope.facts) throw new Error("invalid group plan scope owner");
      const groupId = envelope.facts.groupId;
      const treeHash = envelope.facts.treeHash;
      const ownerProject = envelope.facts.ownerProject;
      const members = envelope.facts.members;
      if (typeof groupId !== "string" || typeof treeHash !== "string" || !/^[a-f0-9]{64}$/.test(treeHash) || typeof ownerProject !== "string" || !Array.isArray(members) || !members.length || members.some((member) => typeof member !== "string" || !/^[A-Z][A-Z0-9]*-\d+$/.test(member)) || members[0] !== planRun.ticket || new Set(members).size !== members.length) throw new Error("invalid group plan scope facts");
      const state = new DatabaseSync(join(canonicalRoot, "yokemate.db"), { readOnly: true });
      try {
        const group = state.prepare("SELECT root_ticket FROM task_group WHERE id=? AND root_ticket=?").get(groupId, planRun.ticket);
        const claimed = state.prepare("SELECT COUNT(*) count FROM member_claim WHERE group_id=? AND tree_hash=? AND state='reserved'").get(groupId, treeHash) as { count: number };
        if (!group || claimed.count !== members.length) throw new Error("group plan scope claims are missing or stale");
      } finally { state.close(); }
      planRun.groupScope = { groupId, treeHash, ownerProject, members: new Set(members as string[]) };
      return { requestId: envelope.requestId, state: "accepted", runId: envelope.runId, facts: { groupId, treeHash, ownerProject, members } };
    }
    if (envelope.operation === "plan-approach-present") {
      if (!envelope.facts) throw new Error("invalid plan approach owner");
      const { approachText, treeHash, acceptedScouts } = envelope.facts;
      if (typeof approachText !== "string" || typeof treeHash !== "string" || !Array.isArray(acceptedScouts)) throw new Error("invalid plan approach facts");
      const saveApproachKey = saveOnlyKey(origin, ticket);
      const saveWorker = saveOnlyWorkers.get(saveApproachKey);
      const registered = Boolean(planRun && envelope.runId && planRun.worker && registeredWorker(planRun, planRun.ticket, origin));
      if (!registered && (!saveWorker || !ownerOrDescendant(origin, saveWorker.owner, ticket))) throw new Error("invalid plan approach owner");
      const planRunId = envelope.runId ?? `save-only:${saveApproachKey}`;
      const owner = { sessionId: origin.sessionId, runtimeId: origin.runtimeId ?? planRunId, planRunId };
      const store = new PlanApproachStore(owner);
      const proposal = store.present({ approachText, treeHash, acceptedScouts: acceptedScouts as any });
      if (registered) {
        planRun!.approachStore?.revoke();
        planRun!.approachStore = store;
        planRun!.approachProposal = proposal;
      } else {
        saveOnlyApproaches.get(saveApproachKey)?.store.revoke();
        saveOnlyApproaches.set(saveApproachKey, { store, proposal });
      }
      return { requestId: envelope.requestId, state: "accepted", runId: envelope.runId, facts: { generation: proposal.generation, approachHash: proposal.approachHash, treeHash: proposal.treeHash } };
    }
    if (envelope.operation === "plan-input" || envelope.operation === "plan-approach-extraction") {
      const saveApproachKey = saveOnlyKey(origin, ticket);
      const saveWorker = saveOnlyWorkers.get(saveApproachKey);
      const registered = Boolean(planRun && envelope.runId && planRun.worker && registeredWorker(planRun, planRun.ticket, origin));
      const approach = registered && planRun?.approachStore && planRun.approachProposal ? { store: planRun.approachStore, proposal: planRun.approachProposal } : saveOnlyApproaches.get(saveApproachKey);
      if (!approach || !registered && (!saveWorker || !ownerOrDescendant(origin, saveWorker.owner, ticket))) throw new Error("invalid plan approach input owner");
      if (envelope.operation === "plan-input") {
        if (typeof envelope.raw !== "string") throw new Error("invalid plan approach input");
        const generation = approach.store.observeInput(envelope.raw, approach.store.owner);
        return { requestId: envelope.requestId, state: "accepted", runId: envelope.runId, generation: generation.serial, facts: generation as unknown as Record<string, unknown> };
      }
      if (!envelope.facts) throw new Error("invalid plan approach extraction facts");
      const generation = envelope.facts.generation;
      const extraction = envelope.facts.extraction;
      if (!generation || typeof generation !== "object" || !extraction || typeof extraction !== "object") throw new Error("invalid plan approach extraction facts");
      if ((extraction as { kind?: string }).kind === "revoke") {
        approach.store.revoke();
        return { requestId: envelope.requestId, state: "accepted", runId: envelope.runId, facts: { state: "revoked" } };
      }
      const receipt = approach.store.approve(generation as any, extraction as any, approach.store.owner);
      return { requestId: envelope.requestId, state: "accepted", runId: envelope.runId, facts: { receiptId: receipt.id } };
    }
    if (envelope.operation === "group-plan-activated") {
      if (!planRun || !envelope.runId || !planRun.groupScope || !planRun.approachStore || !planRun.approachProposal || !envelope.facts || !registeredWorker(planRun, planRun.ticket, origin) || !parent.groupPlanActivated) throw new Error("invalid group plan activation owner");
      const groupId = envelope.facts.groupId;
      const revisionHash = envelope.facts.revisionHash;
      if (groupId !== planRun.groupScope.groupId || typeof revisionHash !== "string" || !/^[a-f0-9]{64}$/.test(revisionHash)) throw new Error("group plan activation facts changed");
      planRun.approachStore.assertCurrent({ treeHash: planRun.approachProposal.treeHash, acceptedScouts: planRun.approachProposal.acceptedScouts, approachHash: planRun.approachProposal.approachHash }, planRun.approachStore.owner);
      const context = { kind: "registered" as const, runId: envelope.runId, ...(planRun.listRunId ? { listRunId: planRun.listRunId } : {}) };
      await parent.groupPlanActivated(ticket, context, envelope.facts, origin, { store: planRun.approachStore, proposal: planRun.approachProposal });
      const state = new DatabaseSync(join(canonicalRoot, "yokemate.db"), { readOnly: true });
      try {
        const row = state.prepare("SELECT active_revision,phase FROM task_group WHERE id=?").get(groupId) as { active_revision: string; phase: string } | undefined;
        if (!row || row.active_revision !== revisionHash || row.phase !== "planned") throw new Error("group plan activation is not durable");
      } finally { state.close(); }
      planRun.terminal = "recorded";
      planRun.observer?.stop();
      planRun.observer = undefined;
      return { requestId: envelope.requestId, state: "accepted", runId: envelope.runId, facts: envelope.facts };
    }

    const problemWorker = origin.mode === "plan" && !origin.ticket && origin.role === "coordinator";
    const packageKey = problemKey(origin);
    let packageState = problemPackages.get(packageKey);
    if (packageState && !processMatches(packageState.owner.pid, packageState.owner.starttime)) {
      problemPackages.delete(packageKey);
      packageState = undefined;
    }
    const registeredProblemWorker = problemWorker && (!packageState ? problemOwnerMatches(origin) : sameProcess(packageState.owner, origin) || descendantOf(origin.pid, origin.starttime, packageState.owner.pid, packageState.owner.starttime));
    const saveKey = saveOnlyKey(origin, ticket);
    let saveOnly = saveOnlyWorkers.get(saveKey);
    if (saveOnly && !ownerLive(saveOnly.owner, ticket)) {
      saveOnlyWorkers.delete(saveKey);
      saveOnlyApproaches.get(saveKey)?.store.revoke();
      saveOnlyApproaches.delete(saveKey);
      saveOnly = undefined;
    }
    const isRegisteredWorker = registeredWorker(planRun, ticket, origin);
    let context: PlanCompletionContext;
    if (planRun) {
      if (!isRegisteredWorker) throw new Error("plan operation is not from its registered live worker");
      context = { kind: "registered", runId: envelope.runId!, ...(planRun.listRunId ? { listRunId: planRun.listRunId } : {}) };
    } else if (main) context = { kind: "main" };
    else if (registeredProblemWorker && (envelope.operation === "publish-plan-scout" || envelope.operation === "reject-plan-scout" || packageState?.tickets.has(ticket))) context = { kind: "problem", packageKey };
    else if (origin.mode === "plan" && origin.role === "coordinator" && origin.ticket === ticket && origin.pane) {
      if (saveOnly) {
        const ownerOnly = envelope.operation === "publish-plan-scout" || envelope.operation === "reject-plan-scout";
        if (ownerOnly ? !sameProcess(origin, saveOnly.owner) : !ownerOrDescendant(origin, saveOnly.owner, ticket)) throw new Error("plan operation is not from its admitted live save-only worker");
      } else {
        const parentKnown = origin.parentPane === identity.pane || (origin.parentPane !== undefined && panes.has(origin.parentPane));
        if (!(envelope.operation === "publish-plan-scout" || envelope.operation === "reject-plan-scout" && envelope.acceptanceId === undefined && Number.isSafeInteger(envelope.scoutSequence) && envelope.scoutSequence! > 0 && validScoutChild(envelope.child, ticket, origin)) || !paneOwnerMatches(origin, ticket) || !origin.parentPane || !parentKnown) throw new Error("plan operation is not from its admitted live save-only worker");
      }
      context = { kind: "save-only", admissionId: saveOnly?.admissionId ?? randomUUID() };
    } else throw new Error("plan operation is not from its registered live worker");

    if (envelope.operation === "plan-finished") {
      if (context.kind !== "registered" || !planRun || !envelope.outcome || !envelope.reason || !parent.planFinished) throw new Error("plan finish handoff is unavailable");
      if (planRun.terminal && !finishingRecording) throw new Error("plan run is no longer active");
      fencePlanRun(planRun, envelope.outcome);
      await parent.planFinished(ticket, context, envelope.outcome, envelope.reason, origin, planRun.groupScope ? { groupId: planRun.groupScope.groupId, treeHash: planRun.groupScope.treeHash } : undefined);
      planRun.terminal = envelope.outcome;
      planRun.observer?.stop();
      planRun.observer = undefined;
      return { requestId: envelope.requestId, state: "accepted", runId: context.runId };
    }

    const scoutKey = context.kind === "registered" ? envelope.runId! : context.kind === "save-only" ? saveKey : `${origin.sessionId}\u0000${origin.pane ?? ""}\u0000${ticket}`;
    const requestGenerations = context.kind === "registered" ? (planRun!.scoutRequests ??= new Map()) : context.kind === "save-only" ? (saveOnly?.scoutRequests ?? new Map()) : scoutRequests.get(scoutKey) ?? new Map();
    const finalized = context.kind === "registered" ? (planRun!.finalizedScoutAcceptances ??= new Set()) : context.kind === "save-only" ? (saveOnly?.finalizedScoutAcceptances ?? new Set()) : finalizedScoutAcceptances.get(scoutKey) ?? new Set();
    const children = context.kind === "registered" ? (planRun!.scoutChildren ??= new Map()) : context.kind === "save-only" ? (saveOnly?.scoutChildren ?? new Map()) : scoutChildren.get(scoutKey) ?? new Map();
    if (context.kind !== "registered" && context.kind !== "save-only") {
      if (!scoutRequests.has(scoutKey)) scoutRequests.set(scoutKey, requestGenerations);
      if (!finalizedScoutAcceptances.has(scoutKey)) finalizedScoutAcceptances.set(scoutKey, finalized);
      if (!scoutChildren.has(scoutKey)) scoutChildren.set(scoutKey, children);
    }

    const reservation = scoutReservations.get(scoutKey);
    if (envelope.scoutSequence !== undefined) {
      if (!Number.isSafeInteger(envelope.scoutSequence) || envelope.scoutSequence <= 0 || !validScoutChild(envelope.child, ticket, origin)) throw new Error("invalid scout sequence identity");
      if (reservation && !childOwnerMatches(reservation.child, envelope.child!)) throw new Error("scout sequence owner changed");
      if (context.kind === "save-only" && saveOnly && !childOwnerMatches(saveOnly.childOwner, envelope.child!)) throw new Error("scout sequence owner changed");
    }
    if (envelope.operation === "reject-plan-scout" && envelope.scoutSequence !== undefined && !Number.isSafeInteger(envelope.acceptanceId)) {
      if (context.kind === "registered" && !sameProcess(origin, planRun!.worker!)) throw new Error("scout reservation requires its exact live worker");
      if (context.kind === "save-only" && !saveOnly) {
        saveOnly = { admissionId: context.admissionId, ticket, owner: { ...origin }, admitted: false, childOwner: { ownerRunId: envelope.child!.ownerRunId, ownerSessionId: envelope.child!.ownerSessionId }, scoutGeneration: 0, scoutRequests: requestGenerations, finalizedScoutAcceptances: finalized, scoutChildren: children };
        saveOnlyWorkers.set(saveKey, saveOnly);
      }
    }

    if (envelope.operation === "publish-plan-scout") {
      if (!Number.isSafeInteger(envelope.acceptanceId) || !parent.publishPlanScout || !validScoutChild(envelope.child, ticket, origin)) throw new Error("plan scout publication identity is unavailable");
      const acceptanceId = envelope.acceptanceId!;
      if (finalized.has(acceptanceId)) throw new Error("scout artifact is superseded");
      const priorChild = children.get(acceptanceId);
      if (priorChild && !childMatches(priorChild, envelope.child!)) throw new Error("accepted scout identity does not match its delivery");
      if (context.kind === "save-only" && !saveOnly) {
        saveOnly = { admissionId: context.admissionId, ticket, owner: { ...origin }, admitted: false, childOwner: { ownerRunId: envelope.child!.ownerRunId, ownerSessionId: envelope.child!.ownerSessionId }, scoutGeneration: 0, scoutRequests: requestGenerations, finalizedScoutAcceptances: finalized, scoutChildren: children };
        saveOnlyWorkers.set(saveKey, saveOnly);
      }
      if (context.kind === "save-only" && !childOwnerMatches(saveOnly!.childOwner, envelope.child!)) throw new Error("accepted scout owner does not match its save-only worker");
      const currentAcceptance = context.kind === "registered" ? planRun!.scoutAcceptance : context.kind === "save-only" ? saveOnly!.scoutAcceptance : scoutAcceptances.get(scoutKey);
      const observedGeneration = context.kind === "registered" ? planRun!.scoutGeneration ?? 0 : context.kind === "save-only" ? saveOnly!.scoutGeneration : scoutGenerations.get(scoutKey) ?? 0;
      const suppliedSequence = Number.isSafeInteger(envelope.scoutSequence) && envelope.scoutSequence! > 0 ? envelope.scoutSequence : undefined;
      const generation = suppliedSequence ?? observedGeneration + 1;
      const staleSequence = suppliedSequence !== undefined && generation <= observedGeneration;
      if (!staleSequence) {
        if (suppliedSequence !== undefined && reservation && (generation !== reservation.sequence + 1 || !childMatches(reservation.child, envelope.child!))) throw new Error("scout completion does not match its reservation");
        if (currentAcceptance !== undefined && currentAcceptance !== acceptanceId) {
          finalized.add(currentAcceptance);
          requestGenerations.delete(currentAcceptance);
        }
        if (context.kind === "registered") {
          planRun!.scoutGeneration = generation;
          planRun!.scoutAcceptance = undefined;
          planRun!.prepared = undefined;
          if (!planRun!.recordPromise) {
            planRun!.recordPath = undefined;
            planRun!.recordContentHash = undefined;
            planRun!.recordId = undefined;
            planRun!.recordBinding = undefined;
            planRun!.recordReply = undefined;
            if (planRun!.terminal === "recorded") planRun!.terminal = undefined;
          }
        } else if (context.kind === "save-only") {
          saveOnly!.scoutGeneration = generation;
          saveOnly!.scoutAcceptance = undefined;
          saveOnly!.prepared = undefined;
          if (!saveOnly!.recordPromise) {
            saveOnly!.recordPath = undefined;
            saveOnly!.recordContentHash = undefined;
            saveOnly!.recordId = undefined;
            saveOnly!.recordBinding = undefined;
            saveOnly!.recordReply = undefined;
            if (saveOnly!.terminal === "recorded") saveOnly!.terminal = undefined;
          }
        } else {
          scoutGenerations.set(scoutKey, generation);
          scoutAcceptances.delete(scoutKey);
          preparedPlans.delete(scoutKey);
        }
      }
      requestGenerations.set(acceptanceId, generation);
      children.set(acceptanceId, { ...envelope.child! });
      let outcome: Awaited<ReturnType<NonNullable<ParentControl["publishPlanScout"]>>>;
      try { outcome = await parent.publishPlanScout(ticket, acceptanceId, envelope.child!, origin); }
      catch (error) {
        requestGenerations.delete(acceptanceId);
        children.delete(acceptanceId);
        throw error;
      }
      const ownerStillValid = context.kind === "registered" ? !!planRun!.worker && ownerLive(planRun!.worker, ticket) : context.kind === "save-only" ? ownerLive(saveOnly!.owner, ticket) : context.kind === "problem" ? problemOwnerMatches(packageState?.owner ?? origin) : processMatches(origin.pid, origin.starttime);
      if (!ownerStillValid) {
        requestGenerations.delete(acceptanceId);
        children.delete(acceptanceId);
        if (context.kind === "save-only") {
          saveOnlyWorkers.delete(saveKey);
          saveOnlyApproaches.get(saveKey)?.store.revoke();
          saveOnlyApproaches.delete(saveKey);
        }
        throw new Error("plan scout owner is no longer live");
      }
      const currentGeneration = context.kind === "registered" ? planRun!.scoutGeneration : context.kind === "save-only" ? saveOnly!.scoutGeneration : scoutGenerations.get(scoutKey);
      if (staleSequence || currentGeneration !== generation) {
        requestGenerations.delete(acceptanceId);
        finalized.add(acceptanceId);
        return { requestId: envelope.requestId, state: "accepted", acceptanceId, ...outcome, artifactAcceptance: "superseded", reason: "scout superseded" };
      }
      requestGenerations.clear();
      requestGenerations.set(acceptanceId, generation);
      if (context.kind === "registered") planRun!.scoutAcceptance = acceptanceId;
      else if (context.kind === "save-only") {
        saveOnly!.admitted = true;
        saveOnly!.scoutAcceptance = acceptanceId;
      } else scoutAcceptances.set(scoutKey, acceptanceId);
      if (context.kind === "problem") {
        const accepted = packageState ?? { owner: { ...origin }, tickets: new Set<string>() };
        accepted.tickets.add(ticket);
        problemPackages.set(packageKey, accepted);
      }
      return { requestId: envelope.requestId, state: "accepted", acceptanceId, ...outcome, artifactAcceptance: "accepted" };
    }

    if (envelope.operation === "reject-plan-scout") {
      const currentGeneration = context.kind === "registered" ? planRun!.scoutGeneration ?? 0 : context.kind === "save-only" ? saveOnly!.scoutGeneration : scoutGenerations.get(scoutKey) ?? 0;
      if (!Number.isSafeInteger(envelope.acceptanceId)) {
        const sequence = Number.isSafeInteger(envelope.scoutSequence) && envelope.scoutSequence! > 0 ? envelope.scoutSequence! : undefined;
        if (sequence === undefined || sequence <= currentGeneration) return { requestId: envelope.requestId, state: "accepted", reason: "uncorrelated scout rejection ignored" };
        if (sequence % 2 === 1) scoutReservations.set(scoutKey, { child: { ...envelope.child! }, sequence });
        requestGenerations.clear();
        if (context.kind === "registered") {
          planRun!.scoutGeneration = sequence;
          planRun!.scoutAcceptance = undefined;
          planRun!.prepared = undefined;
        } else if (context.kind === "save-only") {
          saveOnly!.scoutGeneration = sequence;
          saveOnly!.scoutAcceptance = undefined;
          saveOnly!.prepared = undefined;
        } else {
          scoutGenerations.set(scoutKey, sequence);
          scoutAcceptances.delete(scoutKey);
          preparedPlans.delete(scoutKey);
        }
        return { requestId: envelope.requestId, state: "accepted", reason: "scout rejected" };
      }
      const ownedGeneration = requestGenerations.get(envelope.acceptanceId!);
      const rejectedGeneration = envelope.scoutSequence === undefined ? currentGeneration + 1 : Math.max(currentGeneration, envelope.scoutSequence);
      if (envelope.child && (!validScoutChild(envelope.child, ticket, origin) || children.has(envelope.acceptanceId!) && !childMatches(children.get(envelope.acceptanceId!)!, envelope.child))) throw new Error("rejected scout identity does not match its delivery");
      if (ownedGeneration === currentGeneration) {
        requestGenerations.clear();
        if (Number.isSafeInteger(envelope.acceptanceId)) finalized.add(envelope.acceptanceId!);
        if (context.kind === "registered") {
          planRun!.scoutGeneration = rejectedGeneration;
          planRun!.scoutAcceptance = undefined;
          planRun!.prepared = undefined;
        } else if (context.kind === "save-only") {
          saveOnly!.scoutGeneration = rejectedGeneration;
          saveOnly!.scoutAcceptance = undefined;
          saveOnly!.prepared = undefined;
        } else {
          scoutGenerations.set(scoutKey, rejectedGeneration);
          scoutAcceptances.delete(scoutKey);
          preparedPlans.delete(scoutKey);
        }
        return { requestId: envelope.requestId, state: "accepted", reason: "scout rejected" };
      }
      if (Number.isSafeInteger(envelope.acceptanceId)) requestGenerations.delete(envelope.acceptanceId!);
      return { requestId: envelope.requestId, state: "accepted", reason: "scout rejection superseded" };
    }

    const acceptanceId = context.kind === "registered" ? planRun!.scoutAcceptance : context.kind === "save-only" ? saveOnly!.scoutAcceptance : scoutAcceptances.get(scoutKey);
    if (envelope.operation === "prepare-plan-publication") {
      if (!envelope.path || !envelope.contentHash || !Number.isSafeInteger(acceptanceId) || !parent.preparePlanPublication) throw new Error("plan publication preparation requires a current accepted scout");
      const outcome = await parent.preparePlanPublication(ticket, envelope.path, envelope.contentHash, acceptanceId!, origin, context);
      if (planRun?.terminal) throw new Error("plan run is no longer active");
      if ((context.kind === "registered" && (!planRun!.worker || !ownerLive(planRun!.worker, ticket))) || (context.kind === "save-only" && !ownerLive(saveOnly!.owner, ticket))) throw new Error("plan preparation owner is no longer live");
      const currentAcceptance = context.kind === "registered" ? planRun!.scoutAcceptance : context.kind === "save-only" ? saveOnly!.scoutAcceptance : scoutAcceptances.get(scoutKey);
      if (currentAcceptance !== acceptanceId) throw new Error("plan publication preparation was superseded");
      if (!outcome.binding || outcome.binding.ticket !== ticket || resolve(outcome.binding.path) !== resolve(envelope.path) || outcome.binding.contentHash !== envelope.contentHash || outcome.scoutAcceptance !== acceptanceId || outcome.revision !== outcome.binding.contentHash) throw new Error("binding_changed");
      const prepared = { recordId: outcome.recordId, path: outcome.binding.path, requestedPath: envelope.path, contentHash: outcome.binding.contentHash, acceptanceId: outcome.scoutAcceptance, binding: { ...outcome.binding, repositories: [...outcome.binding.repositories] }, snapshotPath: outcome.snapshotPath };
      if (context.kind === "registered") planRun!.prepared = prepared;
      else if (context.kind === "save-only") {
        saveOnly!.prepared = prepared;
        preparedNumericContexts.set(`${ticket}\u0000${prepared.recordId}`, { path: prepared.requestedPath, contentHash: prepared.contentHash, context, worker: saveOnly!, prepared });
      } else {
        preparedPlans.set(scoutKey, prepared);
        numericRecords.delete(`${context.kind}\u0000${scoutKey}`);
      }
      const { binding: _binding, ...replyOutcome } = outcome;
      return { requestId: envelope.requestId, state: "accepted", ...replyOutcome };
    }

    if (envelope.operation === "record-plan") {
      if (context.kind !== "registered" || !planRun || !envelope.path || !/^[a-f0-9]{64}$/.test(envelope.contentHash ?? "") || !parent.recordPlan || !Number.isSafeInteger(acceptanceId)) throw new Error("plan record requires a current accepted scout and content hash");
      if (!planRun.approachStore || !planRun.approachProposal) throw new Error("plan record requires an approved current plan approach");
      planRun.approachStore.assertCurrent({ treeHash: planRun.approachProposal.treeHash, acceptedScouts: planRun.approachProposal.acceptedScouts, approachHash: planRun.approachProposal.approachHash }, planRun.approachStore.owner);
      if (planRun.terminal === "recorded") {
        if (planRun.recordPath !== envelope.path || planRun.recordContentHash !== envelope.contentHash || planRun.recordAcceptance !== acceptanceId || !planRun.recordReply) throw new Error("recorded plan retry binding changed");
        verifyRecordedRetry(ticket, planRun.recordBinding);
        return { requestId: envelope.requestId, state: "accepted", ...planRun.recordReply };
      }
      if (planRun.terminal && planRun.terminal !== "recording" && !continuedRecovery) throw new Error("plan run is no longer active");
      if (planRun.recordPromise) {
        if (planRun.recordPath !== envelope.path || planRun.recordContentHash !== envelope.contentHash || planRun.recordAcceptance !== acceptanceId) throw new Error("plan record is already running with another binding");
        const outcome = await planRun.recordPromise;
        verifyRecordedRetry(ticket, planRun.recordBinding, envelope.path, envelope.contentHash);
        return { requestId: envelope.requestId, state: "accepted", ...outcome };
      }
      planRun.terminal = "recording";
      planRun.recordPath = envelope.path;
      planRun.recordContentHash = envelope.contentHash;
      planRun.recordAcceptance = acceptanceId;
      const recordGeneration = planRun.scoutGeneration;
      let completedBinding: PlanBinding | undefined;
      const verifyCompletion = (binding: PlanBinding) => {
        if (planRun.terminal !== "recording") throw new Error("plan recorder was superseded by logical stop");
        if (!planRun.worker || planRun.scoutAcceptance !== acceptanceId || planRun.scoutGeneration !== recordGeneration) throw new Error("plan completion scout changed");
        completedBinding = { ...binding, repositories: [...binding.repositories] };
      };
      planRun.recordPromise = parent.recordPlan(ticket, envelope.path, origin, context, acceptanceId!, verifyCompletion, envelope.contentHash!);
      try {
        const outcome = await planRun.recordPromise;
        if (planRun.terminal !== "recording") throw new Error("plan recorder was superseded by logical stop");
        if (!completedBinding) throw new Error("plan completion was not verified");
        planRun.terminal = "recorded";
        if (planRun.recovery) planRun.recovery.state = "recorded";
        planRun.recordReply = outcome;
        planRun.recordBinding = completedBinding;
        planRun.pendingExit = undefined;
        planRun.observer?.stop();
        planRun.observer = undefined;
        return { requestId: envelope.requestId, state: "accepted", ...outcome };
      } catch (error) {
        planRun.recordPromise = undefined;
        if (planRun.terminal === "recording") {
          planRun.terminal = /cancelled before lock acquisition/.test((error as Error).message) ? "cancelled" : continuedRecovery ? "blocked" : undefined;
          const pendingExit = planRun.pendingExit;
          planRun.pendingExit = undefined;
          if (!planRun.terminal && pendingExit && envelope.runId) setImmediate(() => void finishExitedPlan(envelope.runId!, planRun, pendingExit));
        }
        throw error;
      }
    }

    if (envelope.operation === "plan-recorded") {
      if (!envelope.path || !/^[a-f0-9]{64}$/.test(envelope.contentHash ?? "") || !Number.isSafeInteger(envelope.recordId) || !parent.planRecorded) throw new Error("plan record handoff is unavailable");
      const approach = context.kind === "registered" && planRun?.approachStore && planRun.approachProposal ? { store: planRun.approachStore, proposal: planRun.approachProposal } : context.kind === "save-only" ? saveOnlyApproaches.get(saveKey) : undefined;
      if (["registered", "save-only"].includes(context.kind)) {
        if (!approach) throw new Error("plan record requires an approved current plan approach");
        approach.store.assertCurrent({ treeHash: approach.proposal.treeHash, acceptedScouts: approach.proposal.acceptedScouts, approachHash: approach.proposal.approachHash }, approach.store.owner);
      }
      let recordContext = context;
      let recordSaveOnly = saveOnly;
      let recordPrepared: PreparedPlanRecord | undefined;
      let recordScoutKey = scoutKey;
      if (context.kind === "main") {
        const provenance = preparedNumericContexts.get(`${ticket}\u0000${envelope.recordId}`);
        if (provenance && provenance.path === envelope.path && provenance.contentHash === envelope.contentHash) {
          recordContext = provenance.context;
          recordSaveOnly = provenance.worker;
          recordPrepared = provenance.prepared;
          recordScoutKey = saveOnlyKey(provenance.worker.owner, ticket);
        }
      }
      const prepared = recordPrepared ?? (recordContext.kind === "registered" ? planRun!.prepared : recordContext.kind === "save-only" ? recordSaveOnly!.prepared : preparedPlans.get(recordScoutKey));
      const preparedAcceptance = recordContext.kind === "save-only" ? recordSaveOnly!.scoutAcceptance : acceptanceId;
      if ((!prepared && recordContext.kind !== "main") || (prepared && (prepared.recordId !== envelope.recordId || prepared.requestedPath !== envelope.path || prepared.contentHash !== envelope.contentHash || prepared.acceptanceId !== preparedAcceptance))) throw new Error("prepared plan record binding changed");
      const state = recordContext.kind === "registered" ? planRun! : recordContext.kind === "save-only" ? recordSaveOnly! : undefined;
      if (state?.recordReply) {
        if (state.recordPath !== envelope.path || state.recordContentHash !== envelope.contentHash || state.recordId !== envelope.recordId) throw new Error("recorded plan retry binding changed");
        verifyRecordedRetry(ticket, state.recordBinding);
        const pendingReconciliation = context.kind === "main" && recordContext.kind === "save-only" && (state.recordReply.publication === "pending" || state.recordReply.publications?.some((publication) => publication.state === "pending"));
        if (!pendingReconciliation) {
          if (recordContext.kind === "save-only" && !ownerLive(recordSaveOnly!.owner, ticket)) throw new Error("plan completion owner is no longer live");
          return { requestId: envelope.requestId, state: "accepted", recordId: envelope.recordId, ...state.recordReply };
        }
      }
      if (state?.recordPromise) {
        if (state.recordPath !== envelope.path || state.recordContentHash !== envelope.contentHash || state.recordId !== envelope.recordId) throw new Error("plan record is already running with another binding");
        const outcome = await state.recordPromise;
        verifyRecordedRetry(ticket, state.recordBinding, envelope.path, envelope.contentHash);
        return { requestId: envelope.requestId, state: "accepted", recordId: envelope.recordId, ...outcome };
      }
      const numericKey = `${recordContext.kind}\u0000${recordScoutKey}`;
      const completedKey = `${ticket}\u0000${envelope.recordId}`;
      const globalInflight = inflightNumericRecords.get(completedKey);
      if (globalInflight) {
        if (globalInflight.path !== envelope.path || globalInflight.contentHash !== envelope.contentHash) throw new Error("recorded plan retry binding changed");
        const result = await globalInflight.promise;
        verifyRecordedRetry(ticket, result.binding);
        return { requestId: envelope.requestId, state: "accepted", recordId: envelope.recordId, ...result.outcome };
      }
      const prior = context.kind === "main" && recordContext.kind === "main" && prepared ? undefined : completedNumericRecords.get(completedKey);
      if (context.kind === "main" && recordContext.kind === "main" && !prepared && !prior) throw new Error("main plan reconciliation requires an exact prepared or completed record");
      let numeric = numericRecords.get(numericKey);
      if (!state && numeric && recordContext.kind === "main" && (prior || prepared) && !processMatches(numeric.owner.pid, numeric.owner.starttime)) {
        numericRecords.delete(numericKey);
        numeric = undefined;
      }
      if (!state && numeric) {
        if (!processMatches(numeric.owner.pid, numeric.owner.starttime) || numeric.path !== envelope.path || numeric.contentHash !== envelope.contentHash || numeric.recordId !== envelope.recordId) throw new Error("recorded plan retry binding changed");
        if (numeric.reply) {
          verifyRecordedRetry(ticket, numeric.binding);
          return { requestId: envelope.requestId, state: "accepted", recordId: envelope.recordId, ...numeric.reply };
        }
        const outcome = await numeric.promise!;
        verifyRecordedRetry(ticket, numeric.binding, envelope.path, envelope.contentHash);
        return { requestId: envelope.requestId, state: "accepted", recordId: envelope.recordId, ...outcome };
      }
      if (prior) {
        if (context.kind !== "main" || prior.path !== envelope.path || prior.contentHash !== envelope.contentHash) throw new Error("recorded plan retry binding changed");
        verifyRecordedRetry(ticket, prior.binding);
      }
      const completionGeneration = recordContext.kind === "registered" ? planRun!.scoutGeneration : recordContext.kind === "save-only" ? recordSaveOnly!.scoutGeneration : scoutGenerations.get(recordScoutKey);
      let completedBinding: PlanBinding | undefined;
      const verifyCompletion = (binding: PlanBinding) => {
        if (recordContext.kind === "registered" && ((planRun!.terminal !== undefined && planRun!.terminal !== "recording") || !planRun!.worker || !ownerLive(planRun!.worker, ticket) || planRun!.prepared !== prepared || planRun!.scoutAcceptance !== acceptanceId || planRun!.scoutGeneration !== completionGeneration)) throw new Error("plan completion owner or scout changed");
        if (recordContext.kind === "save-only" && !(context.kind === "main" && prior) && (!ownerLive(recordSaveOnly!.owner, ticket) || recordSaveOnly!.prepared !== prepared || recordSaveOnly!.scoutAcceptance !== prepared!.acceptanceId || recordSaveOnly!.scoutGeneration !== completionGeneration)) throw new Error("plan completion owner or scout changed");
        if (recordContext.kind === "problem" && (!packageState || !problemOwnerMatches(packageState.owner) || preparedPlans.get(recordScoutKey) !== prepared || scoutAcceptances.get(recordScoutKey) !== acceptanceId || scoutGenerations.get(recordScoutKey) !== completionGeneration)) throw new Error("plan completion owner or scout changed");
        if (recordContext.kind === "main" && !processMatches(origin.pid, origin.starttime)) throw new Error("plan completion owner is no longer live");
        if (prepared) assertPlanBinding(prepared.binding, binding);
        if (prior) assertPlanBinding(prior.binding, binding);
        completedBinding = { ...binding, repositories: [...binding.repositories] };
      };
      let resolveGlobal!: (value: { outcome: PlanRecordOutcome; binding: PlanBinding }) => void;
      let rejectGlobal!: (reason: unknown) => void;
      const globalPromise = new Promise<{ outcome: PlanRecordOutcome; binding: PlanBinding }>((resolve, reject) => { resolveGlobal = resolve; rejectGlobal = reject; });
      void globalPromise.catch(() => {});
      const globalEntry = { path: envelope.path, contentHash: envelope.contentHash!, contextKind: prior?.contextKind ?? recordContext.kind, promise: globalPromise };
      const ownsGlobalEntry = !inflightNumericRecords.has(completedKey);
      if (ownsGlobalEntry) inflightNumericRecords.set(completedKey, globalEntry);
      const parentPromise = parent.planRecorded(ticket, envelope.path, envelope.recordId!, recordContext.kind === "save-only" ? recordSaveOnly!.owner : origin, recordContext, verifyCompletion, prior?.reply, envelope.contentHash!);
      const verifiedPromise = parentPromise.then((outcome) => {
        const binding = completedBinding;
        if (!binding) throw new Error("plan completion was not verified");
        return { outcome, binding };
      });
      void verifiedPromise.then(resolveGlobal, rejectGlobal);
      const promise = verifiedPromise.then(({ outcome }) => outcome);
      if (state) {
        state.recordPath = envelope.path;
        state.recordContentHash = envelope.contentHash;
        state.recordId = envelope.recordId;
        state.recordPromise = promise;
        state.terminal = "recording";
      } else {
        numeric = { owner: { ...origin }, path: envelope.path, contentHash: envelope.contentHash!, recordId: envelope.recordId!, promise };
        numericRecords.set(numericKey, numeric);
      }
      try {
        const outcome = await promise;
        const binding = completedBinding;
        if (!binding) throw new Error("plan completion was not verified");
        if (state) {
          state.recordReply = outcome;
          state.recordBinding = binding;
          state.terminal = "recorded";
          state.recordPromise = undefined;
        } else {
          numeric!.binding = binding;
          numeric!.reply = outcome;
          numeric!.promise = undefined;
        }
        completedNumericRecords.set(completedKey, { path: envelope.path, contentHash: envelope.contentHash!, binding, contextKind: prior?.contextKind ?? recordContext.kind, reply: outcome });
        if (recordContext.kind === "main" || recordContext.kind === "problem") preparedPlans.delete(recordScoutKey);
        return { requestId: envelope.requestId, state: "accepted", recordId: envelope.recordId, ...outcome };
      } catch (error) {
        if (state) {
          state.recordPromise = undefined;
          if (state.terminal === "recording") state.terminal = undefined;
        } else numericRecords.delete(numericKey);
        throw error;
      } finally {
        if (ownsGlobalEntry && inflightNumericRecords.get(completedKey) === globalEntry) inflightNumericRecords.delete(completedKey);
      }
    }
    throw new Error("invalid plan control operation");
  };
  const server = net.createServer((connection) => {
    let buffer = "";
    const reply = (value: ControlReply) => { connection.write(JSON.stringify(value) + "\n"); };
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
            const accepted = await parent.launchPlan(envelope.planRequest, origin, { requestId: envelope.requestId, toolCallId: envelope.toolCallId });
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
              const rework = await parent.reviewRecord(ticket, envelope.runId, envelope.path, origin, envelope.facts);
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
        if (planOperations.has(envelope.operation as PlanControlOperation)) {
          try { reply(await handlePlanControl(envelope, origin)); }
          catch (error) { reply({ requestId: envelope.requestId, state: "refused", reason: (error as Error).message }); }
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
        if (envelope.operation === "finish") {
          try {
            const summary = typeof envelope.facts?.summary === "string" ? envelope.facts.summary : "";
            const outcome = envelope.facts?.outcome;
            if (!envelope.runId || (outcome !== "done" && outcome !== "blocked") || !summary || !parent.finish) throw new Error("coordinator finish request is incomplete");
            await parent.finish(envelope.runId, outcome, summary, envelope.reason, origin);
            reply({ requestId: envelope.requestId, state: "accepted", runId: envelope.runId });
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
        const originId = envelope.originId!;
        const fingerprint = createHash("sha256").update(JSON.stringify({ request: envelope.request, toolCallId: envelope.toolCallId ?? null })).digest("hex");
        const existing = launchRequests.get(envelope.requestId);
        if (existing && (!sameProcess(existing.origin, origin) || existing.fingerprint !== fingerprint)) { reply({ requestId: envelope.requestId, state: "refused", reason: "coordinator request id collision" }); continue; }
        reply({ requestId: envelope.requestId, state: "received" });
        const ownsDispatch = !existing;
        let owned = existing;
        if (!owned) {
          const request = envelope.request;
          const requestId = envelope.requestId;
          const toolCallId = envelope.toolCallId;
          const promise = (async (): Promise<{ reply: ControlReply; afterAck?: () => void }> => {
            try {
              const accepted = await parent.launch(request, origin, { requestId, toolCallId });
              const { afterAck, ...acceptedReply } = accepted;
              const runIds = accepted.results?.filter((result) => result.state === "accepted").map((result) => result.keyRunId) ?? (accepted.runId ? [accepted.runId] : []);
              let terminal: ControlReply;
              if (!runIds.length) {
                const reason = accepted.results?.map((result) => `${result.key}: ${result.reason ?? "refused"}`).join("; ") || "coordinator launch accepted no keys";
                terminal = { requestId, state: "refused", reason, listRunId: accepted.listRunId, results: accepted.results };
              } else {
                requestOrigins.set(requestId, originId);
                requestRuns.set(requestId, runIds);
                if (accepted.listRunId) { requestLists.set(requestId, accepted.listRunId); runOrigins.set(accepted.listRunId, originId); }
                for (const runId of runIds) runOrigins.set(runId, originId);
                terminal = { requestId, state: "accepted", ...acceptedReply, runId: accepted.runId ?? runIds[0] };
              }
              return { reply: terminal, afterAck };
            } catch (error) { return { reply: { requestId, state: "refused", reason: (error as Error).message } }; }
          })();
          owned = { origin: { ...origin }, fingerprint, promise };
          launchRequests.set(requestId, owned);
        }
        const result = await owned.promise;
        reply(result.reply);
        if (ownsDispatch) result.afterAck?.();
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

export async function requestCoordinator(root: string, request: CoordinatorRequest, origin: ControlOrigin, target: Pick<ParentIdentity, "sessionId" | "runtimeId">, env: NodeJS.ProcessEnv = process.env, dispatch: { requestId?: string; toolCallId?: string } = {}): Promise<ControlReply> {
  const attach = await send(root, { version: 1, operation: "attach-origin", requestId: randomUUID(), origin, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId }, env);
  if (attach.state !== "accepted" || !attach.originId) return attach;
  return send(root, { version: 1, operation: "launch", requestId: dispatch.requestId ?? randomUUID(), toolCallId: dispatch.toolCallId, originId: attach.originId, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId, request }, env);
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

export async function requestCoordinatorFinish(root: string, runId: string, outcome: "done" | "blocked", summary: string, reason: string | undefined, origin: ControlOrigin, target: Pick<ParentIdentity, "sessionId" | "runtimeId">, env: NodeJS.ProcessEnv = process.env): Promise<ControlReply> {
  const attach = await send(root, { version: 1, operation: "attach-origin", requestId: randomUUID(), origin, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId }, env);
  if (attach.state !== "accepted" || !attach.originId) return attach;
  return send(root, { version: 1, operation: "finish", requestId: randomUUID(), originId: attach.originId, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId, runId, reason, facts: { outcome, summary } }, env);
}

export async function requestPlanLaunch(root: string, planRequest: PlanLaunchRequest, origin: ControlOrigin, target: Pick<ParentIdentity, "sessionId" | "runtimeId">, env: NodeJS.ProcessEnv = process.env): Promise<ControlReply> {
  const attach = await send(root, { version: 1, operation: "attach-origin", requestId: randomUUID(), origin, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId }, env);
  if (attach.state !== "accepted" || !attach.originId) return attach;
  return send(root, { version: 1, operation: "launch-plan", requestId: randomUUID(), originId: attach.originId, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId, planRequest }, env);
}

export async function requestPlanControl(root: string, operation: PlanControlOperation, payload: { ticket: string; path?: string; pane?: string; runId?: string; raw?: string; outcome?: "blocked" | "cancelled"; reason?: string; publicationId?: number; acceptanceId?: number; recordId?: number; contentHash?: string; child?: ChildIdentity; scoutSequence?: number; candidateId?: string; failureHash?: string; generation?: number; writerRunId?: string; facts?: Record<string, unknown> }, origin: ControlOrigin, target: Pick<ParentIdentity, "sessionId" | "runtimeId">, env: NodeJS.ProcessEnv = process.env): Promise<ControlReply> {
  const attach = await send(root, { version: 1, operation: "attach-origin", requestId: randomUUID(), origin, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId }, env);
  if (attach.state !== "accepted" || !attach.originId) return attach;
  return send(root, { version: 1, operation, requestId: randomUUID(), originId: attach.originId, targetSessionId: target.sessionId, targetRuntimeId: target.runtimeId, ...payload }, env);
}

export async function requestReviewControl(root: string, operation: ReviewControlOperation, payload: { ticket: string; path?: string; pane?: string; surface?: "tab" | "split"; tabId?: string; workerRuntimeId?: string; runId?: string; raw?: string; generation?: ReviewInputGeneration; extraction?: ReviewReworkExtraction; reason?: string; facts?: Record<string, unknown> }, origin: ControlOrigin, target: Pick<ParentIdentity, "sessionId" | "runtimeId">, env: NodeJS.ProcessEnv = process.env, timeoutMs = 30_000): Promise<ControlReply> {
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
