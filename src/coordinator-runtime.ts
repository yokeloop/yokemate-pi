import { readRuntimeSettings, type RuntimeSettings } from "./guard-policy.ts";
import { randomUUID } from "node:crypto";
import type { CoordinatorMode, CoordinatorOrigin, CoordinatorRequest, PreparedCoordinator } from "./coordinator-launch.ts";

export interface RuntimeIdentity { runId: string; parentRunId?: string; parentSessionId: string; mode: CoordinatorMode; ticket: string; project: string[]; role: "coordinator" | "executor"; cwd: string; model: string }
export type RuntimeState = "preparing" | "starting" | "active" | "finishing" | "done" | "blocked";
export interface CoordinatorRun { identity: RuntimeIdentity; request: CoordinatorRequest; origin: CoordinatorOrigin; state: RuntimeState; process?: { kill(signal?: NodeJS.Signals): boolean }; requestId?: string; prepared?: PreparedCoordinator; reason?: string }
export interface CoordinatorLaunchChecks { checkCaller(origin: CoordinatorOrigin, request: CoordinatorRequest): string | undefined; rejectDuplicate(mode: CoordinatorMode): boolean; checkAdmission(activeUnits: number): string | undefined; needsShipConfirmation(origin: CoordinatorOrigin): boolean }

export const IDLE_NUDGE_LIMIT = 3;
export type IdleVerdict = "wait" | "nudge" | "blocked";
export function idleVerdict(state: { nudges: number; hasChildren: boolean }, limit = IDLE_NUDGE_LIMIT, settings: RuntimeSettings = readRuntimeSettings()): IdleVerdict {
  if (state.hasChildren) return "wait";
  return settings.policy.guards.doCompletion && state.nudges < limit ? "nudge" : "blocked";
}

export const coordinatorChecks = ({ policy, limits }: RuntimeSettings): CoordinatorLaunchChecks => ({
  checkCaller(origin, request) {
    if (request.mode === "do" && policy.guards.spawnCaller && (origin.YOKEMATE_MODE || origin.YOKEMATE_ROLE)) return `spawn runs in the main chat only — this pane is stamped ${origin.YOKEMATE_MODE ?? origin.YOKEMATE_ROLE}`;
    return undefined;
  },
  rejectDuplicate(mode) { return mode === "do" ? policy.guards.duplicateDo : policy.guards.duplicateMode; },
  checkAdmission(activeUnits) { return policy.guards.detachedLimit && activeUnits >= limits.maxDetached ? `Too many detached agents already running (${activeUnits}/${limits.maxDetached})` : undefined; },
  needsShipConfirmation() { return policy.guards.shipConfirmation; },
});

export class CoordinatorRegistry {
  private readonly runs = new Map<string, CoordinatorRun>();
  private readonly keyIndex = new Map<string, Set<string>>();
  reserve(request: CoordinatorRequest, origin: CoordinatorOrigin, parentSessionId: string, model: string, cwd: string, projects: string[], rejectDuplicate: boolean): CoordinatorRun {
    const keys = request.tickets.map((ticket) => `${request.mode}:${ticket}`);
    if (rejectDuplicate) {
      const existing = keys.flatMap((key) => [...(this.keyIndex.get(key) ?? [])]).map((id) => this.runs.get(id)).find((run) => run && !["done", "blocked"].includes(run.state));
      if (existing) throw new Error(`${existing.identity.ticket} already runs as ${existing.identity.runId}, cwd ${existing.identity.cwd}, model ${existing.identity.model}`);
    }
    const runId = randomUUID();
    const identity: RuntimeIdentity = { runId, parentSessionId, mode: request.mode, ticket: request.tickets.join("+"), project: projects, role: "coordinator", cwd, model };
    const run: CoordinatorRun = { identity, request: { ...request, tickets: [...request.tickets] }, origin: { ...origin }, state: "preparing" };
    this.runs.set(runId, run);
    for (const key of keys) (this.keyIndex.get(key) ?? this.keyIndex.set(key, new Set()).get(key)!).add(runId);
    return run;
  }
  attachProcess(runId: string, process: { kill(signal?: NodeJS.Signals): boolean }): void { const run = this.required(runId); run.process = process; run.state = "active"; }
  setPrepared(runId: string, prepared: PreparedCoordinator): void { const run = this.required(runId); run.prepared = prepared; run.state = "starting"; }
  get(runId: string): CoordinatorRun | undefined { return this.runs.get(runId); }
  active(): CoordinatorRun[] { return [...this.runs.values()].filter((run) => !["done", "blocked"].includes(run.state)); }
  finalize(runId: string, state: "done" | "blocked", reason?: string): CoordinatorRun { const run = this.required(runId); if (["done", "blocked"].includes(run.state)) return run; run.state = state; run.reason = reason; run.process = undefined; return run; }
  cancel(runId: string, reason = "cancelled"): CoordinatorRun { const run = this.required(runId); try { run.process?.kill("SIGTERM"); } catch {} return this.finalize(runId, "blocked", reason); }
  private required(runId: string): CoordinatorRun { const run = this.runs.get(runId); if (!run) throw new Error(`unknown coordinator run ${runId}`); return run; }
}

export class ShipPermitStore {
  private permit?: { tickets: string[]; parentSessionId: string; serial: number; used: boolean };
  private serial = 0;
  observeInteractiveShip(tickets: string[], parentSessionId: string): void { this.permit = { tickets: [...tickets], parentSessionId, serial: ++this.serial, used: false }; }
  invalidate(): void { this.permit = undefined; }
  consume(tickets: string[], parentSessionId: string): boolean {
    const permit = this.permit;
    if (!permit || permit.used || permit.parentSessionId !== parentSessionId || permit.tickets.join("\u0000") !== tickets.join("\u0000")) return false;
    permit.used = true;
    return true;
  }
}

export function runtimeEnv(identity: RuntimeIdentity): NodeJS.ProcessEnv {
  return { YOKEMATE_MODE: identity.mode, YOKEMATE_TICKET: identity.ticket, YOKEMATE_ROLE: identity.role, YOKEMATE_RUN_ID: identity.runId, YOKEMATE_PARENT_RUN_ID: identity.parentRunId, YOKEMATE_PARENT_SESSION_ID: identity.parentSessionId, YOKEMATE_PROJECT: JSON.stringify(identity.project) };
}
