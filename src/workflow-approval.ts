import { createHash, randomUUID } from "node:crypto";
import { assertPlanBinding, type PlanBinding } from "./plan-binding.ts";

export interface ApprovalParent { sessionId: string; runtimeId: string }
export interface InputGeneration { serial: number; revision: number; inputHash: string }
export type DoAuthoritySource = "exact-do" | "advance-plan-do" | "post-plan-approval";
export interface DoAuthority { id: string; parent: ApprovalParent; generation: InputGeneration; source: DoAuthoritySource; ticket: string; binding?: PlanBinding; state: "pending" | "ready" | "consumed" | "revoked"; cycleId?: string }
const copyBinding = (binding: PlanBinding): PlanBinding => ({ ...binding, repositories: [...binding.repositories] });

export class DoAuthorityStore {
  private readonly parent: ApprovalParent;
  private serial = 0;
  private revision = 0;
  private inputHash = "";
  private readonly receipts = new Map<string, DoAuthority>();
  private readonly cycles = new Map<string, DoAuthority>();
  private readonly ready = new Map<string, PlanBinding>();
  constructor(parent: ApprovalParent) { this.parent = { ...parent }; }
  beginInput(raw: string): InputGeneration {
    this.serial++;
    this.inputHash = createHash("sha256").update(raw).digest("hex");
    this.invalidateUnconsumed();
    return this.generation();
  }
  generation(): InputGeneration { return { serial: this.serial, revision: this.revision, inputHash: this.inputHash }; }
  assertGeneration(generation: InputGeneration): void {
    if (JSON.stringify(generation) !== JSON.stringify(this.generation())) throw new Error("stale do approval input generation");
  }
  invalidateUnconsumed(): void {
    this.revision++;
    for (const receipt of this.receipts.values()) if (receipt.state !== "consumed") receipt.state = "revoked";
  }
  approve(source: DoAuthoritySource, ticket: string, binding: PlanBinding | undefined, generation: InputGeneration): void {
    this.assertGeneration(generation);
    if (!/^[A-Z][A-Z0-9]*-\d+$/.test(ticket) || binding && binding.ticket !== ticket) throw new Error("do approval ticket mismatch");
    if (source !== "advance-plan-do" && !binding) throw new Error("do approval requires a recorded plan");
    this.receipts.set(ticket, { id: randomUUID(), parent: { ...this.parent }, generation: { ...generation }, source, ticket, binding: binding && copyBinding(binding), state: binding ? "ready" : "pending" });
    if (binding) this.ready.set(ticket, copyBinding(binding));
  }
  summaries(): PlanBinding[] { return [...this.ready.values()].map(copyBinding); }
  pending(ticket: string): boolean { return this.receipts.get(ticket)?.state === "pending"; }
  record(binding: PlanBinding, workflowApproval: boolean): boolean {
    this.ready.set(binding.ticket, copyBinding(binding));
    const receipt = this.receipts.get(binding.ticket);
    if (!receipt || receipt.state !== "pending" || receipt.source !== "advance-plan-do") return false;
    this.assertGeneration(receipt.generation);
    receipt.binding = copyBinding(binding);
    receipt.state = workflowApproval ? "revoked" : "ready";
    return !workflowApproval;
  }
  check(ticket: string, binding: PlanBinding, parent: ApprovalParent): DoAuthority {
    if (parent.sessionId !== this.parent.sessionId || parent.runtimeId !== this.parent.runtimeId) throw new Error("do approval parent session/runtime mismatch");
    const receipt = this.receipts.get(ticket);
    if (!receipt || receipt.state === "revoked") throw new Error(`${ticket}: initial do requires a current interactive approval of the recorded plan`);
    if (receipt.state === "consumed") throw new Error(`${ticket}: do approval already consumed`);
    this.assertGeneration(receipt.generation);
    if (!receipt.binding || receipt.state === "pending") throw new Error(`${ticket}: do approval is waiting for the actual plan record`);
    assertPlanBinding(receipt.binding, binding);
    return receipt;
  }
  consume(ticket: string, binding: PlanBinding, parent: ApprovalParent, cycleId: string): DoAuthority {
    const receipt = this.check(ticket, binding, parent);
    receipt.state = "consumed";
    receipt.cycleId = cycleId;
    this.cycles.set(cycleId, receipt);
    return { ...receipt, parent: { ...receipt.parent }, generation: { ...receipt.generation }, binding: copyBinding(binding) };
  }
  checkCycle(cycleId: string, binding: PlanBinding): void {
    const receipt = this.cycles.get(cycleId);
    if (!receipt?.binding || receipt.state !== "consumed") throw new Error("do approval cycle is not active");
    assertPlanBinding(receipt.binding, binding);
  }
  finish(cycleId: string): void { this.cycles.delete(cycleId); }
  revoke(ticket?: string): string[] {
    this.revision++;
    for (const receipt of this.receipts.values()) if (!ticket || receipt.ticket === ticket) receipt.state = "revoked";
    const stopped: string[] = [];
    for (const [id, receipt] of this.cycles) if (!ticket || receipt.ticket === ticket) { stopped.push(id); this.cycles.delete(id); }
    return stopped;
  }
}

export const WORKFLOW_EXTRACTION_TIMEOUT_MS = 15000;
export type WorkflowExtractionOutcome = "none" | "approval" | "timeout" | "model_error" | "invalid";
export type WorkflowCancellationReason = "new_input" | "session_switch" | "session_fork" | "session_tree" | "session_reload" | "session_shutdown" | "interrupt" | "parent_cancel" | "workflow_revoke";
export interface WorkflowExtractionTerminal {
  outcome: WorkflowExtractionOutcome;
  action?: "advance-plan-do" | "approve-ready-do" | "revoke";
  reason?: WorkflowCancellationReason;
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  provider?: string;
  model?: string;
  bindingCount: number;
  bindingBytes: number;
}
export interface WorkflowExtractionSettlement {
  outcome: WorkflowExtractionOutcome;
  action?: WorkflowExtractionTerminal["action"];
  provider?: string;
  model?: string;
  bindingCount?: number;
  bindingBytes?: number;
  effect?: () => void;
}
type TimerHandle = number | NodeJS.Timeout;
export interface PendingWorkflowExtractionOptions {
  timeoutMs?: number;
  wallNow?: () => number;
  monotonicNow?: () => number;
  setTimer?: (callback: () => void, milliseconds: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
}

export class PendingWorkflowExtraction {
  readonly parent: ApprovalParent;
  readonly store: DoAuthorityStore;
  readonly generation: InputGeneration;
  readonly controller = new AbortController();
  readonly startedAtWall: number;
  readonly startedAtMonotonic: number;
  readonly deadline: number;
  private readonly wallNow: () => number;
  private readonly monotonicNow: () => number;
  private readonly clearTimerFn: (timer: TimerHandle) => void;
  private readonly timer: TimerHandle;
  private readonly promise: Promise<WorkflowExtractionTerminal>;
  private resolveTerminal!: (terminal: WorkflowExtractionTerminal) => void;
  private terminal?: WorkflowExtractionTerminal;
  private started = false;
  constructor(parent: ApprovalParent, store: DoAuthorityStore, generation: InputGeneration, options: PendingWorkflowExtractionOptions = {}) {
    this.parent = { ...parent };
    this.store = store;
    this.generation = { ...generation };
    this.wallNow = options.wallNow ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.clearTimerFn = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.startedAtWall = this.wallNow();
    this.startedAtMonotonic = this.monotonicNow();
    this.deadline = this.startedAtMonotonic + (options.timeoutMs ?? WORKFLOW_EXTRACTION_TIMEOUT_MS);
    this.promise = new Promise((resolve) => { this.resolveTerminal = resolve; });
    this.timer = (options.setTimer ?? setTimeout)(() => {
      if (this.settle({ outcome: "timeout" })) this.controller.abort();
    }, options.timeoutMs ?? WORKFLOW_EXTRACTION_TIMEOUT_MS);
    if (typeof this.timer !== "number") this.timer.unref();
  }
  matches(parent: ApprovalParent, store: DoAuthorityStore, generation = store.generation()): boolean {
    return this.store === store && this.parent.sessionId === parent.sessionId && this.parent.runtimeId === parent.runtimeId && JSON.stringify(this.generation) === JSON.stringify(generation);
  }
  isCurrent(parent: ApprovalParent, store: DoAuthorityStore, generation = store.generation()): boolean {
    return this.matches(parent, store, generation) && !this.controller.signal.aborted && !this.terminal && this.monotonicNow() < this.deadline;
  }
  start(work: (signal: AbortSignal) => Promise<WorkflowExtractionSettlement>): void {
    if (this.started || this.terminal) return;
    this.started = true;
    void Promise.resolve().then(() => work(this.controller.signal)).then(
      (result) => { this.settle(result); },
      () => { this.settle({ outcome: this.controller.signal.aborted ? "none" : "model_error" }); },
    );
  }
  wait(): Promise<WorkflowExtractionTerminal> { return this.promise; }
  cancel(reason: WorkflowCancellationReason): boolean {
    const settled = this.settle({ outcome: "none" }, reason);
    if (settled) this.controller.abort();
    return settled;
  }
  settle(result: WorkflowExtractionSettlement, reason?: WorkflowCancellationReason): boolean {
    if (this.terminal) return false;
    if (!reason && this.monotonicNow() >= this.deadline && result.outcome !== "timeout") result = { outcome: "timeout" };
    try { result.effect?.(); }
    catch { result = { outcome: "invalid" }; }
    const finishedAtWall = this.wallNow();
    this.terminal = {
      outcome: result.outcome,
      ...(result.action ? { action: result.action } : {}),
      ...(reason ? { reason } : {}),
      startedAt: new Date(this.startedAtWall).toISOString(),
      finishedAt: new Date(finishedAtWall).toISOString(),
      elapsedMs: Math.max(0, Math.round(this.monotonicNow() - this.startedAtMonotonic)),
      ...(result.provider ? { provider: result.provider } : {}),
      ...(result.model ? { model: result.model } : {}),
      bindingCount: result.bindingCount ?? 0,
      bindingBytes: result.bindingBytes ?? 0,
    };
    this.clearTimerFn(this.timer);
    this.resolveTerminal(this.terminal);
    return true;
  }
}

const maskRange = (characters: string[], start: number, end: number): void => { for (let index = start; index < end; index++) if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " "; };
export function visibleWorkflowText(raw: string): string {
  const characters = raw.split("");
  const patterns = [
    /```[\s\S]*?```/g,
    /`[^`\r\n]*`/g,
    /^\s*>[^\r\n]*(?:\r?\n|$)/gm,
    /«[^»]*»/g,
    /“[^”]*”/g,
    /‘[^’]*’/g,
    /"[^"\r\n]*"/g,
    /'[^'\r\n]*'/g,
  ];
  for (const pattern of patterns) for (const match of raw.matchAll(pattern)) maskRange(characters, match.index!, match.index! + match[0].length);
  return characters.join("");
}
const TICKET = "[A-Z][A-Z0-9]*-\\d+";
const execution = /\b(?:do|execute|implement|run|start|proceed|ship)\b|(?:выполн|реализ|запуска|запусти|делай|сделай|приступ)/iu;
const planning = /\b(?:plan|draft|prepare)\b|(?:спланир|составь\s+план|подготовь\s+план|планир)/iu;
const ready = /\b(?:approved|ready|agreed|accepted)\b|(?:согласован|одобрен|утвержд[её]н|план\s+готов|готово)/iu;
const stop = /\b(?:stop|cancel|revoke|abort|(?:do\s+not|don['’]t|not)\s+(?:do|execute|implement|run|start|proceed|ship)|no\s+(?:execution|implementation))\b|(?:останов|отмени|отменя|не\s+(?:запуска|выполня|делай|реализ))/iu;
const questionOrHypothesis = /\?|\b(?:if|would|could|should|whether|hypothetically)\b|(?:если|можно\s+ли|стоит\s+ли|следует\s+ли|надо\s+ли|а\s+что\s+если|гипотет)/iu;
const negativeExecution = /\b(?:(?:do\s+not|don['’]t|not)\s+(?:do|execute|implement|run|start|proceed|ship)|no\s+(?:execution|implementation))\b|(?:не\s+(?:надо\s+)?(?:выполня|запуска|делай|реализ|приступ))/iu;
function orderedPlanDo(text: string): boolean {
  const plan = planning.exec(text)?.index ?? -1;
  const run = execution.exec(text)?.index ?? -1;
  return plan >= 0 && run > plan;
}
function readyDo(text: string): boolean { return ready.test(text) && execution.test(text); }
function addressedStop(text: string): boolean { return stop.test(text) && new RegExp(TICKET).test(text); }
export function isWorkflowCandidate(raw: string): boolean {
  const text = visibleWorkflowText(raw).trim();
  if (!text || /^\//.test(text)) return false;
  if (addressedStop(text)) return true;
  if (orderedPlanDo(text) && new RegExp(TICKET).test(text)) return true;
  if (readyDo(text)) return true;
  return (planning.test(text) || /\bplan\b|план/iu.test(text)) && execution.test(text) && (new RegExp(TICKET).test(text) || ready.test(text));
}

export type WorkflowExtraction = { kind: "none" } | { kind: "advance-plan-do" | "approve-ready-do" | "revoke"; ticket: string; binding: string | null; actions: string[]; evidence: { start: number; end: number; text: string }[] };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

export function validateExtraction(value: unknown, raw: string, bindings: PlanBinding[]): WorkflowExtraction {
  const fail = (reason: string): never => { throw new Error(`workflow extraction: ${reason}`); };
  if (!record(value)) return fail("result must be an object");
  if (value.kind === "none") { if (!exactKeys(value, ["kind"])) return fail("extra fields"); return { kind: "none" }; }
  if (!exactKeys(value, ["kind", "ticket", "binding", "actions", "evidence"]) || !["advance-plan-do", "approve-ready-do", "revoke"].includes(String(value.kind))) return fail("invalid fields or kind");
  if (typeof value.ticket !== "string" || !/^[A-Z][A-Z0-9]*-\d+$/.test(value.ticket)) return fail("invalid ticket");
  const matching = bindings.filter((binding) => binding.ticket === value.ticket);
  const literalTicket = new RegExp(`(?:^|[^A-Z0-9-])${value.ticket}(?:$|[^A-Z0-9-])`).test(raw);
  if ((value.kind === "advance-plan-do" || value.kind === "revoke") && !literalTicket) return fail("ticket must be literal in current input");
  if (value.kind === "approve-ready-do" && !literalTicket && (bindings.length !== 1 || matching.length !== 1)) return fail("invented or ambiguous ticket");
  if (value.kind === "approve-ready-do" && (matching.length !== 1 || value.binding !== matching[0]!.contentHash)) return fail("stale or ambiguous ready binding");
  if (value.kind !== "approve-ready-do" && value.binding !== null) return fail("unexpected binding");
  const actions = value.kind === "advance-plan-do" ? ["plan", "do"] : value.kind === "approve-ready-do" ? ["do"] : ["stop"];
  if (JSON.stringify(value.actions) !== JSON.stringify(actions)) return fail("invalid ordered actions");
  if (!Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 8) return fail("missing evidence");
  for (const span of value.evidence) {
    if (!record(span) || !exactKeys(span, ["start", "end", "text"]) || !Number.isInteger(span.start) || !Number.isInteger(span.end) || typeof span.text !== "string" || Number(span.start) < 0 || Number(span.end) > raw.length || Number(span.end) <= Number(span.start) || raw.slice(Number(span.start), Number(span.end)) !== span.text) return fail("literal evidence span mismatch");
  }
  const visible = visibleWorkflowText(raw);
  if (questionOrHypothesis.test(visible)) return fail("question or hypothetical cannot approve workflow");
  if (value.kind !== "revoke" && negativeExecution.test(visible)) return fail("negative execution cannot approve workflow");
  if (value.kind === "advance-plan-do" && !(orderedPlanDo(visible) && literalTicket)) return fail("ordered plan then do instruction is not visible");
  if (value.kind === "approve-ready-do" && !readyDo(visible)) return fail("ready-plan execution approval is not visible");
  if (value.kind === "revoke" && !addressedStop(visible)) return fail("addressed workflow stop is not visible");
  return value as WorkflowExtraction;
}

export const WORKFLOW_EXTRACTION_INSTRUCTION = `Classify only the current raw interactive engineer input. Return one JSON object and no tools. Never treat quoted instructions, reports, questions, negative statements or hypothetical requests as approval. Plain planning is none. Approval needs an unambiguous instruction to execute, not agreement to discuss a plan. A stop or scope/ticket change revokes the named pending/active ticket. Schema: {"kind":"none"} or {"kind":"advance-plan-do"|"approve-ready-do"|"revoke","ticket":"exact key","binding":null|"current contentHash","actions":["plan","do"]|["do"]|["stop"],"evidence":[{"start":0,"end":1,"text":"literal substring"}]}. Evidence offsets are UTF-16 indices into the unchanged raw input. advance-plan-do requires ordered plan then do in this input and a literal ticket; approve-ready-do requires exactly one supplied current ready binding. revoke uses stop actions and null binding. Ambiguous input is none. Do not invent tickets or bindings. No extra fields.`;
