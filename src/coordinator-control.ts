import * as net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureDir, socketDir } from "./inbox.ts";
import type { CoordinatorRequest } from "./coordinator-launch.ts";
import type { PlanLaunchRequest } from "./plan-launch.ts";
import type { CoordinatorMergeRequest, CoordinatorMergeResult } from "./coordinator-merge.ts";
import type { ShipFinalizeResult } from "./ship-finalize.ts";
import { observePlanProcess, type PlanProcessObserver } from "./plan-lifecycle.ts";
import type { PublicationOutcome } from "./plan-publication-state.ts";
import { assertPlanBinding, readRecordedPlanBinding, type PlanBinding } from "./plan-binding.ts";
import type { ChildIdentity } from "./subagent-runs.ts";

export interface ControlOrigin { sessionId: string; runtimeId?: string; pid: number; starttime: string; cwd: string; pane?: string; parentPane?: string; mode?: string; ticket?: string; role?: string }
export interface ControlEnvelope { version: 1; operation: "attach-origin" | "launch" | "launch-plan" | "merge" | "ship-finalize" | "status" | "cancel" | PlanControlOperation; ticket?: string; path?: string; pane?: string; outcome?: "blocked" | "cancelled"; reason?: string; requestId: string; originId?: string; origin?: ControlOrigin; targetSessionId?: string; targetRuntimeId?: string; request?: CoordinatorRequest; planRequest?: PlanLaunchRequest; mergeRequest?: CoordinatorMergeRequest; runId?: string; listRunId?: string; keyRunId?: string; targetRequestId?: string; publicationId?: number; acceptanceId?: number; recordId?: number; contentHash?: string; child?: ChildIdentity; scoutSequence?: number }
export interface ControlResult { key: string; keyRunId: string; state: "accepted" | "refused"; reservation?: "ready" | "queued"; reason?: string; identity?: unknown }
export type PlanHandoff = "plan-only" | "unavailable" | "started" | "refused";
export interface PlanRecordOutcome { runId?: string; reason: string; facts?: Record<string, unknown>; publication?: "complete" | "pending"; publications?: PublicationOutcome[]; handoff?: PlanHandoff; target?: string; revision?: string }
export type PlanCompletionContext = { kind: "registered"; runId: string; listRunId?: string } | { kind: "save-only"; admissionId: string } | { kind: "main" } | { kind: "problem"; packageKey: string };
export interface ControlReply { requestId: string; state: "received" | "accepted" | "refused" | "status"; reason?: string; runId?: string; listRunId?: string; keyRunId?: string; originId?: string; identity?: unknown; merge?: CoordinatorMergeResult; finalization?: ShipFinalizeResult; results?: ControlResult[]; publicationId?: number; acceptanceId?: number; artifactAcceptance?: "accepted" | "superseded"; recordId?: number; publication?: "complete" | "pending"; publications?: PublicationOutcome[]; handoff?: PlanHandoff; target?: string; revision?: string; snapshotPath?: string; scoutPublication?: number; scoutAcceptance?: number }
export type PlanControlOperation = "register-plan" | "bind-plan" | "plan-started" | "publish-plan-scout" | "reject-plan-scout" | "prepare-plan-publication" | "plan-recorded" | "plan-finished" | "record-plan";
export interface ParentControl { publishPlanScout?(ticket: string, acceptanceId: number, child: ChildIdentity, origin: ControlOrigin): Promise<{ reason: string; publication: "complete" | "pending"; target: string; revision: string; publicationId?: number }>; preparePlanPublication?(ticket: string, path: string, contentHash: string, acceptanceId: number, origin: ControlOrigin, context: PlanCompletionContext): Promise<{ reason: string; recordId: number; snapshotPath: string; scoutAcceptance: number; revision: string; binding: PlanBinding; publicationId?: number; scoutPublication?: number; target?: string }>; recordPlan?(ticket: string, path: string, origin: ControlOrigin, context: PlanCompletionContext, acceptanceId: number, verifyCompletion: (binding: PlanBinding) => void): Promise<PlanRecordOutcome>; planRecorded?(ticket: string, path: string, recordId: number, origin: ControlOrigin, context: PlanCompletionContext, verifyCompletion: (binding: PlanBinding) => void, prior?: PlanRecordOutcome): Promise<PlanRecordOutcome>; planFinished?(ticket: string, context: PlanCompletionContext, outcome: "blocked" | "cancelled", reason: string, origin: ControlOrigin): Promise<void>; launchPlan?(request: PlanLaunchRequest, origin: ControlOrigin): Promise<{ listRunId: string; results: ControlResult[] }>; launch(request: CoordinatorRequest, origin: ControlOrigin): Promise<{ runId?: string; listRunId?: string; identity?: unknown; results?: ControlResult[]; afterAck?(): void }>; merge?(runId: string, request: CoordinatorMergeRequest, origin: ControlOrigin): Promise<CoordinatorMergeResult>; finalizeShip?(runId: string, origin: ControlOrigin): Promise<ShipFinalizeResult>; status(requestId: string, origin: ControlOrigin): ControlReply; cancel(runId: string, origin: ControlOrigin): Promise<void> }
export interface ParentIdentity { root: string; sessionId: string; runtimeId: string; pid: number; starttime: string; cwd: string; pane?: string }

interface PlanRunState {
  ticket: string;
  launcher: ControlOrigin;
  listRunId?: string;
  pane?: string;
  worker?: ControlOrigin;
  terminal?: "recording" | "recorded" | "blocked" | "cancelled";
  recordPath?: string;
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
  scoutChildren?: Map<number, ChildIdentity>;
  prepared?: PreparedPlanRecord;
}

interface PreparedPlanRecord {
  recordId: number;
  path: string;
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
  const saveOnlyWorkers = new Map<string, SaveOnlyWorker>();
  const problemPackages = new Map<string, { owner: ControlOrigin; tickets: Set<string> }>();
  const scoutAcceptances = new Map<string, number>();
  const scoutGenerations = new Map<string, number>();
  const scoutRequests = new Map<string, Map<number, number>>();
  const finalizedScoutAcceptances = new Map<string, Set<number>>();
  const scoutChildren = new Map<string, Map<number, ChildIdentity>>();
  const preparedPlans = new Map<string, PreparedPlanRecord>();
  const numericRecords = new Map<string, { owner: ControlOrigin; path: string; recordId: number; binding?: PlanBinding; promise?: Promise<PlanRecordOutcome>; reply?: PlanRecordOutcome }>();
  const completedNumericRecords = new Map<string, { path: string; binding: PlanBinding; contextKind: PlanCompletionContext["kind"]; reply: PlanRecordOutcome }>();
  const preparedNumericContexts = new Map<string, { path: string; context: Extract<PlanCompletionContext, { kind: "save-only" }>; worker: SaveOnlyWorker; prepared: PreparedPlanRecord }>();
  const inflightNumericRecords = new Map<string, { path: string; contextKind: PlanCompletionContext["kind"]; promise: Promise<{ outcome: PlanRecordOutcome; binding: PlanBinding }> }>();
  const sameProcess = (a: ControlOrigin, b: ControlOrigin) => a.pid === b.pid && a.starttime === b.starttime && a.sessionId === b.sessionId && a.pane === b.pane;
  const problemKey = (origin: ControlOrigin) => `${origin.sessionId}\u0000${origin.pane ?? ""}`;
  const saveOnlyKey = (origin: ControlOrigin, ticket: string) => `${origin.sessionId}\u0000${origin.pane ?? ""}\u0000${ticket}`;
  const childMatches = (a: ChildIdentity, b: ChildIdentity) => a.ownerRunId === b.ownerRunId && a.ownerSessionId === b.ownerSessionId && a.batchId === b.batchId && a.runId === b.runId && a.agent === b.agent && a.taskHash === b.taskHash && resolve(a.cwd) === resolve(b.cwd) && a.ticket === b.ticket;
  const childOwnerMatches = (owner: Pick<ChildIdentity, "ownerRunId" | "ownerSessionId">, child: ChildIdentity) => owner.ownerRunId === child.ownerRunId && owner.ownerSessionId === child.ownerSessionId;
  const validScoutChild = (child: ChildIdentity | undefined, ticket: string, origin: ControlOrigin) => !!child && child.agent === "plan-scout" && child.ticket === ticket && child.ownerSessionId === origin.sessionId && resolve(child.cwd) === canonicalRoot;
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
  const origins = new Map<string, ControlOrigin>();
  const paneParents = new Map<string, string | undefined>();
  if (identity.pane) paneParents.set(identity.pane, undefined);
  const replies = new Map<string, ControlReply>();
  const requestOrigins = new Map<string, string>();
  const requestRuns = new Map<string, string[]>();
  const requestLists = new Map<string, string>();
  const runOrigins = new Map<string, string>();
  const finishExitedPlan = async (runId: string, planRun: PlanRunState, worker: ControlOrigin): Promise<void> => {
    if (planRun.terminal === "recording") {
      planRun.pendingExit = { ...worker };
      return;
    }
    if (planRun.terminal) return;
    planRun.terminal = "cancelled";
    planRun.observer?.stop();
    planRun.observer = undefined;
    try {
      if (!parent.planFinished) throw new Error("plan finish handoff is unavailable");
      await parent.planFinished(planRun.ticket, { kind: "registered", runId, ...(planRun.listRunId ? { listRunId: planRun.listRunId } : {}) }, "cancelled", "plan worker process ended before a terminal record", worker);
    } catch {
      if (planRun.terminal === "cancelled") planRun.terminal = undefined;
    }
  };
  const watchPlanWorker = (runId: string, planRun: PlanRunState, worker: ControlOrigin): void => {
    planRun.observer?.stop();
    planRun.observer = observePlanProcess(worker, () => finishExitedPlan(runId, planRun, worker));
  };
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
  const verifyRecordedRetry = (ticket: string, binding: PlanBinding | undefined): void => {
    if (!binding) throw new Error("recorded plan retry binding is unavailable");
    try { assertPlanBinding(binding, readRecordedPlanBinding(canonicalRoot, ticket)); }
    catch { throw new Error("recorded plan retry binding changed"); }
  };
  const planOperations = new Set<PlanControlOperation>(["register-plan", "bind-plan", "plan-started", "publish-plan-scout", "reject-plan-scout", "prepare-plan-publication", "plan-recorded", "plan-finished", "record-plan"]);
  const handlePlanControl = async (envelope: ControlEnvelope, origin: ControlOrigin): Promise<ControlReply> => {
    const ticket = envelope.ticket;
    if (!ticket || !/^[A-Z][A-Z0-9]*-\d+$/.test(ticket)) throw new Error("invalid plan handoff ticket");
    const main = !origin.mode && !origin.role && origin.sessionId === identity.sessionId;
    if (envelope.operation === "register-plan") {
      if (!main) throw new Error("only the verified main parent can register a plan run");
      const runId = randomUUID();
      planRuns.set(runId, { ticket, launcher: { ...origin } });
      return { requestId: envelope.requestId, state: "accepted", runId };
    }
    const runIdPresented = envelope.runId !== undefined;
    if (runIdPresented && (!envelope.runId || !planRuns.has(envelope.runId))) throw new Error("invalid or inactive plan run id");
    const planRun = envelope.runId ? planRuns.get(envelope.runId) : undefined;
    if (planRun && planRun.ticket !== ticket) throw new Error("plan run ticket mismatch");
    if (planRun?.terminal && !(["recording", "recorded"].includes(planRun.terminal) && (envelope.operation === "record-plan" || envelope.operation === "plan-recorded"))) throw new Error("plan run is no longer active");
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
      saveOnly = undefined;
    }
    const registeredWorker = !!planRun?.worker && origin.mode === "plan" && origin.role === "coordinator" && origin.ticket === ticket && origin.pane === planRun.pane && ownerOrDescendant(origin, planRun.worker, ticket);
    let context: PlanCompletionContext;
    if (planRun) {
      if (!registeredWorker) throw new Error("plan operation is not from its registered live worker");
      context = { kind: "registered", runId: envelope.runId!, ...(planRun.listRunId ? { listRunId: planRun.listRunId } : {}) };
    } else if (main) context = { kind: "main" };
    else if (registeredProblemWorker && (envelope.operation === "publish-plan-scout" || envelope.operation === "reject-plan-scout" || packageState?.tickets.has(ticket))) context = { kind: "problem", packageKey };
    else if (origin.mode === "plan" && origin.role === "coordinator" && origin.ticket === ticket && origin.pane) {
      if (saveOnly) {
        const ownerOnly = envelope.operation === "publish-plan-scout" || envelope.operation === "reject-plan-scout";
        if (ownerOnly ? !sameProcess(origin, saveOnly.owner) : !ownerOrDescendant(origin, saveOnly.owner, ticket)) throw new Error("plan operation is not from its admitted live save-only worker");
      } else {
        const parentKnown = origin.parentPane === identity.pane || (origin.parentPane !== undefined && paneParents.has(origin.parentPane));
        if (envelope.operation !== "publish-plan-scout" || !paneOwnerMatches(origin, ticket) || !origin.parentPane || !parentKnown) throw new Error("plan operation is not from its admitted live save-only worker");
      }
      context = { kind: "save-only", admissionId: saveOnly?.admissionId ?? randomUUID() };
    } else throw new Error("plan operation is not from its registered live worker");

    if (envelope.operation === "plan-finished") {
      if (context.kind !== "registered" || !planRun || !envelope.outcome || !envelope.reason || !parent.planFinished) throw new Error("plan finish handoff is unavailable");
      if (planRun.terminal) throw new Error("plan run is no longer active");
      await parent.planFinished(ticket, context, envelope.outcome, envelope.reason, origin);
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
        if (context.kind === "save-only" && !saveOnly!.admitted && requestGenerations.size === 0 && saveOnlyWorkers.get(saveKey) === saveOnly) saveOnlyWorkers.delete(saveKey);
        throw error;
      }
      const ownerStillValid = context.kind === "registered" ? !!planRun!.worker && ownerLive(planRun!.worker, ticket) : context.kind === "save-only" ? ownerLive(saveOnly!.owner, ticket) : context.kind === "problem" ? problemOwnerMatches(packageState?.owner ?? origin) : processMatches(origin.pid, origin.starttime);
      if (!ownerStillValid) {
        requestGenerations.delete(acceptanceId);
        children.delete(acceptanceId);
        if (context.kind === "save-only") saveOnlyWorkers.delete(saveKey);
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
      if (ownedGeneration === currentGeneration) {
        requestGenerations.clear();
        if (Number.isSafeInteger(envelope.acceptanceId)) finalized.add(envelope.acceptanceId!);
        if (context.kind === "registered") {
          planRun!.scoutGeneration = (planRun!.scoutGeneration ?? 0) + 1;
          planRun!.scoutAcceptance = undefined;
          planRun!.prepared = undefined;
        } else if (context.kind === "save-only") {
          saveOnly!.scoutGeneration += 1;
          saveOnly!.scoutAcceptance = undefined;
          saveOnly!.prepared = undefined;
          if (!saveOnly!.admitted) saveOnlyWorkers.delete(saveKey);
        } else {
          scoutGenerations.set(scoutKey, (scoutGenerations.get(scoutKey) ?? 0) + 1);
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
      if ((context.kind === "registered" && (!planRun!.worker || !ownerLive(planRun!.worker, ticket))) || (context.kind === "save-only" && !ownerLive(saveOnly!.owner, ticket))) throw new Error("plan preparation owner is no longer live");
      const currentAcceptance = context.kind === "registered" ? planRun!.scoutAcceptance : context.kind === "save-only" ? saveOnly!.scoutAcceptance : scoutAcceptances.get(scoutKey);
      if (currentAcceptance !== acceptanceId) throw new Error("plan publication preparation was superseded");
      if (!outcome.binding || outcome.binding.ticket !== ticket || resolve(outcome.binding.path) !== resolve(envelope.path) || outcome.binding.contentHash !== envelope.contentHash || outcome.scoutAcceptance !== acceptanceId || outcome.revision !== outcome.binding.contentHash) throw new Error("binding_changed");
      const prepared = { recordId: outcome.recordId, path: outcome.binding.path, contentHash: outcome.binding.contentHash, acceptanceId: outcome.scoutAcceptance, binding: { ...outcome.binding, repositories: [...outcome.binding.repositories] }, snapshotPath: outcome.snapshotPath };
      if (context.kind === "registered") planRun!.prepared = prepared;
      else if (context.kind === "save-only") {
        saveOnly!.prepared = prepared;
        preparedNumericContexts.set(`${ticket}\u0000${prepared.recordId}`, { path: prepared.path, context, worker: saveOnly!, prepared });
      } else {
        preparedPlans.set(scoutKey, prepared);
        numericRecords.delete(`${context.kind}\u0000${scoutKey}`);
      }
      const { binding: _binding, ...replyOutcome } = outcome;
      return { requestId: envelope.requestId, state: "accepted", ...replyOutcome };
    }

    if (envelope.operation === "record-plan") {
      if (context.kind !== "registered" || !planRun || !envelope.path || !parent.recordPlan || !Number.isSafeInteger(acceptanceId)) throw new Error("plan record requires a current accepted scout");
      if (planRun.terminal === "recorded") {
        if (planRun.recordPath !== envelope.path || planRun.recordAcceptance !== acceptanceId || !planRun.recordReply) throw new Error("recorded plan retry binding changed");
        verifyRecordedRetry(ticket, planRun.recordBinding);
        return { requestId: envelope.requestId, state: "accepted", ...planRun.recordReply };
      }
      if (planRun.terminal && planRun.terminal !== "recording") throw new Error("plan run is no longer active");
      if (planRun.recordPromise) {
        if (planRun.recordPath !== envelope.path || planRun.recordAcceptance !== acceptanceId) throw new Error("plan record is already running with another binding");
        return { requestId: envelope.requestId, state: "accepted", ...(await planRun.recordPromise) };
      }
      planRun.terminal = "recording";
      planRun.recordPath = envelope.path;
      planRun.recordAcceptance = acceptanceId;
      const recordGeneration = planRun.scoutGeneration;
      let completedBinding: PlanBinding | undefined;
      const verifyCompletion = (binding: PlanBinding) => {
        if (!planRun.worker || planRun.scoutAcceptance !== acceptanceId || planRun.scoutGeneration !== recordGeneration) throw new Error("plan completion scout changed");
        completedBinding = { ...binding, repositories: [...binding.repositories] };
      };
      planRun.recordPromise = parent.recordPlan(ticket, envelope.path, origin, context, acceptanceId!, verifyCompletion);
      try {
        const outcome = await planRun.recordPromise;
        if (!completedBinding) throw new Error("plan completion was not verified");
        planRun.terminal = "recorded";
        planRun.recordReply = outcome;
        planRun.recordBinding = completedBinding;
        planRun.pendingExit = undefined;
        planRun.observer?.stop();
        planRun.observer = undefined;
        return { requestId: envelope.requestId, state: "accepted", ...outcome };
      } catch (error) {
        planRun.recordPromise = undefined;
        if (planRun.terminal === "recording") {
          planRun.terminal = /cancelled before lock acquisition/.test((error as Error).message) ? "cancelled" : undefined;
          const pendingExit = planRun.pendingExit;
          planRun.pendingExit = undefined;
          if (!planRun.terminal && pendingExit && envelope.runId) setImmediate(() => void finishExitedPlan(envelope.runId!, planRun, pendingExit));
        }
        throw error;
      }
    }

    if (envelope.operation === "plan-recorded") {
      if (!envelope.path || !Number.isSafeInteger(envelope.recordId) || !parent.planRecorded) throw new Error("plan record handoff is unavailable");
      let recordContext = context;
      let recordSaveOnly = saveOnly;
      let recordPrepared: PreparedPlanRecord | undefined;
      let recordScoutKey = scoutKey;
      if (context.kind === "main") {
        const provenance = preparedNumericContexts.get(`${ticket}\u0000${envelope.recordId}`);
        if (provenance && resolve(provenance.path) === resolve(envelope.path)) {
          recordContext = provenance.context;
          recordSaveOnly = provenance.worker;
          recordPrepared = provenance.prepared;
          recordScoutKey = saveOnlyKey(provenance.worker.owner, ticket);
        }
      }
      const prepared = recordPrepared ?? (recordContext.kind === "registered" ? planRun!.prepared : recordContext.kind === "save-only" ? recordSaveOnly!.prepared : preparedPlans.get(recordScoutKey));
      const preparedAcceptance = recordContext.kind === "save-only" ? recordSaveOnly!.scoutAcceptance : acceptanceId;
      if ((!prepared && recordContext.kind !== "main") || (prepared && (prepared.recordId !== envelope.recordId || resolve(prepared.path) !== resolve(envelope.path) || prepared.acceptanceId !== preparedAcceptance))) throw new Error("prepared plan record binding changed");
      const state = recordContext.kind === "registered" ? planRun! : recordContext.kind === "save-only" ? recordSaveOnly! : undefined;
      if (state?.recordReply) {
        if (state.recordPath !== envelope.path || state.recordId !== envelope.recordId) throw new Error("recorded plan retry binding changed");
        verifyRecordedRetry(ticket, state.recordBinding);
        const pendingReconciliation = context.kind === "main" && recordContext.kind === "save-only" && (state.recordReply.publication === "pending" || state.recordReply.publications?.some((publication) => publication.state === "pending"));
        if (!pendingReconciliation) {
          if (recordContext.kind === "save-only" && !ownerLive(recordSaveOnly!.owner, ticket)) throw new Error("plan completion owner is no longer live");
          return { requestId: envelope.requestId, state: "accepted", recordId: envelope.recordId, ...state.recordReply };
        }
      }
      if (state?.recordPromise) {
        if (state.recordPath !== envelope.path || state.recordId !== envelope.recordId) throw new Error("plan record is already running with another binding");
        return { requestId: envelope.requestId, state: "accepted", recordId: envelope.recordId, ...(await state.recordPromise) };
      }
      const numericKey = `${recordContext.kind}\u0000${recordScoutKey}`;
      const completedKey = `${ticket}\u0000${envelope.recordId}`;
      const globalInflight = inflightNumericRecords.get(completedKey);
      if (globalInflight) {
        if (globalInflight.path !== envelope.path) throw new Error("recorded plan retry binding changed");
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
        if (!processMatches(numeric.owner.pid, numeric.owner.starttime) || numeric.path !== envelope.path || numeric.recordId !== envelope.recordId) throw new Error("recorded plan retry binding changed");
        if (numeric.reply) {
          verifyRecordedRetry(ticket, numeric.binding);
          return { requestId: envelope.requestId, state: "accepted", recordId: envelope.recordId, ...numeric.reply };
        }
        return { requestId: envelope.requestId, state: "accepted", recordId: envelope.recordId, ...(await numeric.promise!) };
      }
      if (prior) {
        if (context.kind !== "main" || prior.path !== envelope.path) throw new Error("recorded plan retry binding changed");
        verifyRecordedRetry(ticket, prior.binding);
      }
      const completionGeneration = recordContext.kind === "registered" ? planRun!.scoutGeneration : recordContext.kind === "save-only" ? recordSaveOnly!.scoutGeneration : scoutGenerations.get(recordScoutKey);
      let completedBinding: PlanBinding | undefined;
      const verifyCompletion = (binding: PlanBinding) => {
        if (recordContext.kind === "registered" && (!planRun!.worker || !ownerLive(planRun!.worker, ticket) || planRun!.prepared !== prepared || planRun!.scoutAcceptance !== acceptanceId || planRun!.scoutGeneration !== completionGeneration)) throw new Error("plan completion owner or scout changed");
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
      const globalEntry = { path: envelope.path, contextKind: prior?.contextKind ?? recordContext.kind, promise: globalPromise };
      const ownsGlobalEntry = !inflightNumericRecords.has(completedKey);
      if (ownsGlobalEntry) inflightNumericRecords.set(completedKey, globalEntry);
      const parentPromise = parent.planRecorded(ticket, envelope.path, envelope.recordId!, recordContext.kind === "save-only" ? recordSaveOnly!.owner : origin, recordContext, verifyCompletion, prior?.reply);
      const verifiedPromise = parentPromise.then((outcome) => {
        const binding = completedBinding;
        if (!binding) throw new Error("plan completion was not verified");
        return { outcome, binding };
      });
      void verifiedPromise.then(resolveGlobal, rejectGlobal);
      const promise = verifiedPromise.then(({ outcome }) => outcome);
      if (state) {
        state.recordPath = envelope.path;
        state.recordId = envelope.recordId;
        state.recordPromise = promise;
        state.terminal = "recording";
      } else {
        numeric = { owner: { ...origin }, path: envelope.path, recordId: envelope.recordId!, promise };
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
        completedNumericRecords.set(completedKey, { path: envelope.path, binding, contextKind: prior?.contextKind ?? recordContext.kind, reply: outcome });
        if (recordContext.kind === "main" || recordContext.kind === "problem") preparedPlans.delete(recordScoutKey);
        return { requestId: envelope.requestId, state: "accepted", recordId: envelope.recordId, ...outcome };
      } catch (error) {
        if (state) {
          state.recordPromise = undefined;
          state.terminal = undefined;
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
          for (const [planRunId, planRun] of planRuns) if ((planRunId === envelope.runId || planRun.listRunId === envelope.runId) && planRun.terminal !== "recording" && !planRun.terminal) {
            planRun.terminal = "cancelled";
            planRun.observer?.stop();
            planRun.observer = undefined;
          }
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
  server.on("close", () => {
    for (const planRun of planRuns.values()) planRun.observer?.stop();
    rmSync(sock, { force: true });
    rmSync(`${sock}.json`, { force: true });
  });
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

export async function requestPlanControl(root: string, operation: PlanControlOperation, payload: { ticket: string; path?: string; pane?: string; runId?: string; outcome?: "blocked" | "cancelled"; reason?: string; publicationId?: number; acceptanceId?: number; recordId?: number; contentHash?: string; child?: ChildIdentity; scoutSequence?: number }, origin: ControlOrigin, target: Pick<ParentIdentity, "sessionId" | "runtimeId">, env: NodeJS.ProcessEnv = process.env): Promise<ControlReply> {
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
