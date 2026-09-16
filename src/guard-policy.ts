import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const ENGINE_ROOT = resolve(new URL("..", import.meta.url).pathname);

export const GUARD_IDS = [
  "settingsWrite",
  "noteFileWrite",
  "wait",
  "noteShellWrite",
  "codingLaunch",
  "massKill",
  "homeDelete",
  "shipConfirmation",
  "doCompletion",
  "modeOwnership",
  "transitionCaller",
  "transitionTicket",
  "transitionSource",
  "spawnCaller",
  "stageCaller",
  "stageForce",
  "duplicateDo",
  "duplicateMode",
  "reportTarget",
  "projectAgentConfirmation",
  "parallelTaskLimit",
  "parallelConcurrencyLimit",
  "detachedLimit",
] as const;

export type GuardId = (typeof GUARD_IDS)[number];
export interface GuardPolicy {
  source: string;
  yolo: boolean;
  workflowApproval: boolean;
  guards: Record<GuardId, boolean>;
}

export class RuntimeSettingsError extends Error {
  readonly path: string;
  constructor(path: string, reason: string) {
    super(`runtime settings in ${path}: ${reason}`);
    this.path = path;
    this.name = "RuntimeSettingsError";
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function resolveGuardPolicy(value: unknown, source = "<settings>"): GuardPolicy {
  if (value !== undefined && !isObject(value)) throw new RuntimeSettingsError(source, "guardPolicy must be an object");
  const raw = (value ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(raw))
    if (key !== "yolo" && key !== "workflowApproval" && key !== "guards")
      throw new RuntimeSettingsError(source, `unknown field guardPolicy.${key}`);
  for (const key of ["yolo", "workflowApproval"] as const)
    if (raw[key] !== undefined && typeof raw[key] !== "boolean")
      throw new RuntimeSettingsError(source, `guardPolicy.${key} must be boolean`);
  if (raw.guards !== undefined && !isObject(raw.guards))
    throw new RuntimeSettingsError(source, "guardPolicy.guards must be an object");
  const overrides = (raw.guards ?? {}) as Record<string, unknown>;
  for (const [key, v] of Object.entries(overrides)) {
    if (!(GUARD_IDS as readonly string[]).includes(key))
      throw new RuntimeSettingsError(source, `unknown field guardPolicy.guards.${key}`);
    if (typeof v !== "boolean") throw new RuntimeSettingsError(source, `guardPolicy.guards.${key} must be boolean`);
  }
  const yolo = raw.yolo === true;
  const fallback = !yolo;
  const guards = Object.fromEntries(GUARD_IDS.map((id) => [id, overrides[id] ?? fallback])) as Record<GuardId, boolean>;
  return { source, yolo, workflowApproval: raw.workflowApproval === undefined ? !yolo : raw.workflowApproval as boolean, guards };
}

export function readGuardPolicy(root = ENGINE_ROOT): GuardPolicy {
  return readRuntimeSettings(root).policy;
}

export { RuntimeSettingsError as GuardPolicyError };

export function formatGuardPolicy(policy: GuardPolicy): string {
  const enabled = GUARD_IDS.filter((id) => policy.guards[id]).join(", ") || "none";
  const disabled = GUARD_IDS.filter((id) => !policy.guards[id]).join(", ") || "none";
  return `Guard policy: ${policy.source}; yolo=${policy.yolo}; workflowApproval=${policy.workflowApproval}; enabled=${enabled}; disabled=${disabled}. Immutable boundaries: assigned scope, quality gates, ready-PR reporting, explicit /ship for merge, external authentication, and required data remain mandatory.`;
}

export interface SubagentLimits {
  maxParallelTasks: number;
  maxConcurrency: number;
  maxDetached: number;
}

export const DEFAULT_SUBAGENT_LIMITS: SubagentLimits = { maxParallelTasks: 8, maxConcurrency: 4, maxDetached: 8 };

export function resolveSubagentLimits(value: unknown): SubagentLimits | null {
  if (!isObject(value)) return null;
  const parallel = value.maxParallelTasks ?? DEFAULT_SUBAGENT_LIMITS.maxParallelTasks;
  const candidate: SubagentLimits = {
    maxParallelTasks: parallel as number,
    maxConcurrency: (value.maxConcurrency ?? Math.min(DEFAULT_SUBAGENT_LIMITS.maxConcurrency, parallel as number)) as number,
    maxDetached: (value.maxDetached ?? Math.max(DEFAULT_SUBAGENT_LIMITS.maxDetached, parallel as number)) as number,
  };
  if (Object.values(candidate).some((v) => !Number.isInteger(v) || v < 1)) return null;
  if (candidate.maxConcurrency > candidate.maxParallelTasks || candidate.maxDetached < candidate.maxParallelTasks) return null;
  return candidate;
}

export function readSubagentLimits(root = ENGINE_ROOT): SubagentLimits {
  return readRuntimeSettings(root).limits;
}

export interface RuntimeSettings {
  readonly source: string;
  readonly policy: GuardPolicy;
  readonly limits: SubagentLimits;
}

export function resolveRuntimeSettings(value: unknown, source = resolve(ENGINE_ROOT, ".pi", "settings.json")): RuntimeSettings {
  source = resolve(source);
  if (value !== undefined && !isObject(value)) throw new RuntimeSettingsError(source, "settings root must be an object");
  const raw = (value ?? {}) as Record<string, unknown>;
  const policy = resolveGuardPolicy(raw.guardPolicy, source);
  if (raw.subagent !== undefined && !isObject(raw.subagent)) throw new RuntimeSettingsError(source, "subagent must be an object");
  const block = (raw.subagent ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(block)) {
    if (!Object.hasOwn(DEFAULT_SUBAGENT_LIMITS, key)) throw new RuntimeSettingsError(source, `unknown field subagent.${key}`);
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
      throw new RuntimeSettingsError(source, `subagent.${key} must be an integer >= 1`);
  }
  const parallel = block.maxParallelTasks as number | undefined ?? DEFAULT_SUBAGENT_LIMITS.maxParallelTasks;
  const limits: SubagentLimits = {
    maxParallelTasks: parallel,
    maxConcurrency: block.maxConcurrency as number | undefined ?? Math.min(4, parallel),
    maxDetached: block.maxDetached as number | undefined ?? Math.max(8, parallel),
  };
  if (limits.maxConcurrency > parallel) throw new RuntimeSettingsError(source, "subagent.maxConcurrency must be <= subagent.maxParallelTasks");
  if (limits.maxDetached < parallel) throw new RuntimeSettingsError(source, "subagent.maxDetached must be >= subagent.maxParallelTasks");
  return { source, policy, limits };
}

export function readRuntimeSettings(root = ENGINE_ROOT): RuntimeSettings {
  const source = resolve(root, ".pi", "settings.json");
  let value: unknown;
  try { value = JSON.parse(readFileSync(source, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new RuntimeSettingsError(source, (error as Error).message);
  }
  return resolveRuntimeSettings(value, source);
}

export function subagentAdmission(
  policy: GuardPolicy,
  limits: SubagentLimits,
  mode: "single" | "parallel" | "chain",
  requested: number,
  activeUnits: number,
): string | null {
  if (mode === "parallel" && policy.guards.parallelTaskLimit && requested > limits.maxParallelTasks)
    return `Too many parallel tasks (${requested}). Max is ${limits.maxParallelTasks}.`;
  const units = mode === "parallel" ? requested : 1;
  if (policy.guards.detachedLimit && activeUnits + units > limits.maxDetached)
    return `Too many detached agents already running (${activeUnits}/${limits.maxDetached}). Wait for their reports before detaching another.`;
  return null;
}

export function subagentConcurrency(policy: GuardPolicy, limits: SubagentLimits, taskCount: number): number {
  return policy.guards.parallelConcurrencyLimit ? limits.maxConcurrency : taskCount;
}
