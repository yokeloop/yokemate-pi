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

export function formatGuardPolicy({ source, policy, limits }: RuntimeSettings): string {
  const enabled = GUARD_IDS.filter((id) => policy.guards[id]).join(", ") || "none";
  const disabled = GUARD_IDS.filter((id) => !policy.guards[id]).join(", ") || "none";
  return `Runtime settings: ${source}; maxParallelTasks=${limits.maxParallelTasks}; maxConcurrency=${limits.maxConcurrency}; maxDetached=${limits.maxDetached}; yolo=${policy.yolo}; workflowApproval=${policy.workflowApproval}; enabled=${enabled}; disabled=${disabled}. False settings never widen the current engineer request. Only verified parent interactive input can create initial do or ship authority. Immutable boundaries: assigned scope, quality gates, ready-PR reporting, explicit /ship for merge, external authentication, and required data remain mandatory.`;
}

export interface SubagentLimits {
  maxParallelTasks: number;
  maxConcurrency: number;
  maxDetached: number;
}

export const DEFAULT_SUBAGENT_LIMITS: SubagentLimits = { maxParallelTasks: 8, maxConcurrency: 4, maxDetached: 8 };

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
  { policy, limits }: RuntimeSettings,
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

export function subagentConcurrency({ policy, limits }: RuntimeSettings, taskCount: number): number {
  return policy.guards.parallelConcurrencyLimit ? limits.maxConcurrency : taskCount;
}

export const RUNTIME_SETTING_KEYS = [
  "guardPolicy.yolo", "guardPolicy.workflowApproval",
  ...GUARD_IDS.map((id) => `guards.${id}` as const),
  "subagent.maxParallelTasks", "subagent.maxConcurrency", "subagent.maxDetached",
] as const;
export type RuntimeSettingKey = typeof RUNTIME_SETTING_KEYS[number];
export const RUNTIME_SETTING_SURFACES = ["typed", "tool", "cli", "pane", "ordinary", "coordinator"] as const;
export type RuntimeSettingSurface = typeof RUNTIME_SETTING_SURFACES[number];
type RuntimeSettingCell = "not-applicable" | Readonly<{ consumer: string; regression: string }>;
type RuntimeSettingRow = Readonly<Record<RuntimeSettingSurface, RuntimeSettingCell>>;
const NA = "not-applicable";
const CONSUMERS = {
  "guardPolicy.yolo": ["guards.before_agent_start", "guards.tool_call", "readRuntimeSettings", "mode-tab.launch", "subagent.execute", "coordinatorChecks"],
  "guardPolicy.workflowApproval": ["subagent.input", "startCoordinator.do", "plan-ticket.handoff/spawn", "plan-recorded", "DoAuthorityStore.provenance", "startCoordinator.do"],
  "guards.settingsWrite": [NA, "guards.judge.file", "bash-guard.stdin", "judge.settingsWrite", "judge.settingsWrite", "judge.settingsWrite"],
  "guards.noteFileWrite": [NA, "guards.judge.file", "bash-guard.stdin", "judge.noteFileWrite", "judge.noteFileWrite", NA],
  "guards.wait": [NA, "guards.judge.bash", "bash-guard.stdin", "judge.wait", "judge.wait", "judge.wait"],
  "guards.noteShellWrite": [NA, "guards.judge.bash", "bash-guard.stdin", "judge.noteShellWrite", "judge.noteShellWrite", NA],
  "guards.codingLaunch": [NA, "guards.judge.bash", "bash-guard.stdin", "judge.codingLaunch", "judge.codingLaunch", "judge.codingLaunch"],
  "guards.massKill": [NA, "guards.judge.bash", "bash-guard.stdin", "judge.massKill", "judge.massKill", "judge.massKill"],
  "guards.homeDelete": [NA, "guards.judge.bash", "bash-guard.stdin", "judge.homeDelete", "judge.homeDelete", "judge.homeDelete"],
  "guards.shipConfirmation": ["subagent.input.ship", "startCoordinator.ship", "mode-tab.ship", "ShipPermitStore.provenance", "ShipPermitStore.provenance", "coordinatorChecks.shipConfirmation"],
  "guards.doCompletion": [NA, "guards.agent_settled", "report-guard.stopVerdict", "stopVerdict", "coordinator_finish.owner", "continueOwnedCoordinator"],
  "guards.modeOwnership": ["prompts.where", NA, "mode-guard.decide", "mode-guard.decide", "mode-guard.decide", "mode-guard.decide"],
  "guards.transitionCaller": ["prompts.transition", NA, "transitions.applyMove", "transitions.checkMove", "transitions.checkMove", "prepareDo/markDoRunning"],
  "guards.transitionTicket": ["prompts.transition", NA, "transitions.applyMove", "transitions.checkMove", "transitions.checkMove", "prepareDo/markDoRunning"],
  "guards.transitionSource": ["prompts.transition", NA, "transitions.applyMove", "transitions.checkMove", "transitions.checkMove", "prepareDo/markDoRunning.CAS"],
  "guards.spawnCaller": ["prompts.do", "startCoordinator.do", "spawn.control", "coordinatorChecks.checkCaller", "coordinatorChecks.checkCaller", "coordinatorChecks.checkCaller"],
  "guards.stageCaller": [NA, NA, "stage.repair", "stage.repair", "stage.repair", "stage.repair"],
  "guards.stageForce": [NA, NA, "stage.repair", "stage.repair", "stage.repair", "stage.repair"],
  "guards.duplicateDo": ["prompts.do", "startCoordinator.do", "spawn.control", "CoordinatorRegistry.reserve.do", "CoordinatorRegistry.reserve.do", "CoordinatorRegistry.reserve.do"],
  "guards.duplicateMode": ["prompts.plan/review/ship", "startCoordinator.ship", "mode-tab.duplicate", "mode-tab.duplicate", NA, "CoordinatorRegistry.reserve.ship"],
  "guards.reportTarget": [NA, "bus.tool_call", NA, "inbox.allowTarget", "sendReport.transport", "sendReport.transport"],
  "guards.projectAgentConfirmation": [NA, "subagent.execute.confirmProjectAgents", NA, "subagent.execute.confirmProjectAgents", "subagent.execute.confirmProjectAgents", "subagent.execute.confirmProjectAgents"],
  "guards.parallelTaskLimit": ["prompts.subagent", "subagentAdmission.parallel", NA, "subagentAdmission.parallel", "subagentAdmission.parallel", "subagentAdmission.nested"],
  "guards.parallelConcurrencyLimit": ["prompts.subagent", "subagentConcurrency", NA, "subagentConcurrency", "subagentConcurrency", "subagentConcurrency.nested"],
  "guards.detachedLimit": ["prompts.subagent", "subagentAdmission/startCoordinator", "spawn/mode-tab.ship", "subagentAdmission/startCoordinator", "subagentAdmission", "coordinatorChecks.checkAdmission"],
  "subagent.maxParallelTasks": ["prompts.subagent", "subagentAdmission.parallel", NA, "subagentAdmission.parallel", "subagentAdmission.parallel", "subagentAdmission.nested"],
  "subagent.maxConcurrency": ["prompts.subagent", "subagentConcurrency", NA, "subagentConcurrency", "subagentConcurrency", "subagentConcurrency.nested"],
  "subagent.maxDetached": ["prompts.subagent", "subagentAdmission/startCoordinator", "spawn/mode-tab.ship", "subagentAdmission/startCoordinator", "subagentAdmission", "coordinatorChecks.checkAdmission"],
} as const satisfies Record<RuntimeSettingKey, readonly [string, string, string, string, string, string]>;

export const RUNTIME_SETTINGS_MATRIX: Readonly<Record<RuntimeSettingKey, RuntimeSettingRow>> = Object.freeze(Object.fromEntries(
  RUNTIME_SETTING_KEYS.map((key) => [key, Object.freeze(Object.fromEntries(RUNTIME_SETTING_SURFACES.map((surface, index) => {
    const consumer = CONSUMERS[key][index];
    return [surface, consumer === NA ? NA : Object.freeze({ consumer, regression: `${surface}:${key}` })];
  })))]),
) as Record<RuntimeSettingKey, RuntimeSettingRow>);

export function formatRuntimeSettingsMatrix(): string {
  return [
    `| setting | ${RUNTIME_SETTING_SURFACES.join(" | ")} |`,
    "|---|---|---|---|---|---|---|",
    ...RUNTIME_SETTING_KEYS.map((key) => `| \`${key}\` | ${RUNTIME_SETTING_SURFACES.map((surface) => {
      const cell = RUNTIME_SETTINGS_MATRIX[key][surface];
      return cell === NA ? NA : `\`${cell.consumer}\` (${cell.regression})`;
    }).join(" | ")} |`),
  ].join("\n");
}
