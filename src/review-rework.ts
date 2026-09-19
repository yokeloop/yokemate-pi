import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { assertPlanBinding, type PlanBinding } from "./plan-binding.ts";

export interface ReviewParentIdentity { sessionId: string; runtimeId: string }
export interface ReviewWorkerIdentity { sessionId: string; runtimeId: string; pid: number; starttime: string }
export interface ReviewSurfaceIdentity { surface: "tab" | "split"; paneId: string; tabId?: string }
export interface ReviewReworkOwner { parent: ReviewParentIdentity; reviewRunId: string; ticket: string; worker: ReviewWorkerIdentity; surface: ReviewSurfaceIdentity }
export interface ReviewInputGeneration { serial: number; revision: number; inputHash: string }
export type ReviewReworkExtraction = { kind: "none" } | { kind: "rework" | "revoke"; evidence: { start: number; end: number; text: string }[] };
export interface ReviewHandoffOutcome { state: "started" | "refused" | "cancelled"; recorded: boolean; runId?: string; model?: string; reason?: string; stage?: string; plan?: string; contentHash?: string; close?: { state: "closed" | "failed"; reason?: string } }

type Receipt = { generation: ReviewInputGeneration; state: "pending" | "bound" | "consumed" | "revoked"; binding?: PlanBinding; cycleId?: string };
type Operation = { id: string; generation: ReviewInputGeneration; candidatePath: string; binding?: PlanBinding; retryBinding?: PlanBinding; promise: Promise<ReviewHandoffOutcome>; settled?: ReviewHandoffOutcome };

const copyBinding = (binding: PlanBinding): PlanBinding => ({ ...binding, repositories: [...binding.repositories] });
const sameGeneration = (left: ReviewInputGeneration, right: ReviewInputGeneration): boolean => left.serial === right.serial && left.revision === right.revision && left.inputHash === right.inputHash;

export class ReviewReworkStore {
  readonly owner: ReviewReworkOwner;
  private serial = 0;
  private revision = 0;
  private inputHash = "";
  private raw = "";
  private receipt?: Receipt;
  private operation?: Operation;
  private readonly cycles = new Map<string, { operationId: string; binding: PlanBinding; started: boolean }>();
  private started = false;

  constructor(owner: ReviewReworkOwner) {
    if (!/^[A-Z][A-Z0-9]*-\d+$/.test(owner.ticket) || !owner.reviewRunId || !owner.parent.sessionId || !owner.parent.runtimeId || !owner.worker.sessionId || !owner.worker.runtimeId || !Number.isInteger(owner.worker.pid) || owner.worker.pid < 1 || !owner.worker.starttime || !owner.surface.paneId || owner.surface.surface === "tab" && !owner.surface.tabId || owner.surface.surface === "split" && owner.surface.tabId) throw new Error("invalid review rework owner");
    this.owner = { parent: { ...owner.parent }, reviewRunId: owner.reviewRunId, ticket: owner.ticket, worker: { ...owner.worker }, surface: { ...owner.surface } };
  }

  beginInput(raw: string): ReviewInputGeneration {
    this.serial++;
    this.raw = raw;
    this.inputHash = createHash("sha256").update(raw).digest("hex");
    if (this.receipt?.state !== "consumed") this.receipt = undefined;
    return this.generation();
  }

  generation(): ReviewInputGeneration { return { serial: this.serial, revision: this.revision, inputHash: this.inputHash }; }
  rawInput(generation: ReviewInputGeneration): string { this.assertGeneration(generation); return this.raw; }
  outcome(): ReviewHandoffOutcome | undefined { return this.operation?.settled ? { ...this.operation.settled, close: this.operation.settled.close && { ...this.operation.settled.close } } : undefined; }

  assertGeneration(generation: ReviewInputGeneration): void {
    if (!sameGeneration(generation, this.generation())) throw new Error("stale review verdict generation");
  }

  approveRework(generation: ReviewInputGeneration): void {
    this.assertGeneration(generation);
    if (this.started) throw new Error("review rework handoff already started");
    this.receipt = { generation: { ...generation }, state: "pending" };
  }

  bindRecorded(operationId: string, binding: PlanBinding): void {
    const operation = this.assertOperation(operationId);
    if (binding.ticket !== this.owner.ticket) throw new Error("review rework binding ticket mismatch");
    if (operation.binding) assertPlanBinding(operation.binding, binding);
    operation.binding = copyBinding(binding);
    const receipt = this.requiredReceipt(operation.generation);
    if (receipt.state === "revoked") throw new Error("review rework approval is revoked");
    receipt.binding = copyBinding(binding);
    receipt.state = "bound";
  }

  plannedRetryBinding(operationId: string): PlanBinding | undefined {
    const operation = this.assertOperation(operationId);
    return operation.retryBinding && copyBinding(operation.retryBinding);
  }

  claimHandoff(generation: ReviewInputGeneration, candidatePath: string, action: (operationId: string) => Promise<ReviewHandoffOutcome> | ReviewHandoffOutcome): Promise<ReviewHandoffOutcome> {
    this.assertGeneration(generation);
    const receipt = this.requiredReceipt(generation);
    if (receipt.state === "revoked") throw new Error("review rework approval is revoked");
    if (!candidatePath) throw new Error("review rework candidate path is missing");
    let retryBinding: PlanBinding | undefined;
    if (this.operation) {
      if (sameGeneration(this.operation.generation, generation) && this.operation.candidatePath === candidatePath) return this.operation.promise;
      if (!this.operation.settled || this.operation.settled.state === "started" || sameGeneration(this.operation.generation, generation)) throw new Error("review rework handoff binding or generation mismatch");
      if (this.operation.settled.recorded && this.operation.binding) retryBinding = copyBinding(this.operation.binding);
      this.operation = undefined;
    }
    const id = randomUUID();
    const operation: Operation = { id, generation: { ...generation }, candidatePath, ...(retryBinding ? { retryBinding } : {}), promise: undefined as unknown as Promise<ReviewHandoffOutcome> };
    operation.promise = Promise.resolve().then(async () => {
      if (!sameGeneration(operation.generation, this.generation()) || this.receipt?.state === "revoked") {
        operation.settled = { state: "cancelled", recorded: false, reason: "review verdict was superseded" };
        return operation.settled;
      }
      let outcome: ReviewHandoffOutcome;
      try { outcome = await action(id); }
      catch (error) { outcome = { state: "refused", recorded: this.receipt?.state === "bound" || this.receipt?.state === "consumed", reason: error instanceof Error ? error.message : String(error) }; }
      if (!sameGeneration(operation.generation, this.generation()) && outcome.state !== "started") outcome = { state: "cancelled", recorded: outcome.recorded, reason: "review verdict was superseded", plan: outcome.plan, contentHash: outcome.contentHash, stage: outcome.stage };
      operation.settled = outcome;
      if (outcome.state === "started") this.started = true;
      return outcome;
    });
    this.operation = operation;
    return operation.promise;
  }

  consume(operationId: string, cycleId: string, binding: PlanBinding): void {
    const operation = this.assertOperation(operationId, binding);
    const receipt = this.requiredReceipt(operation.generation);
    if (receipt.state !== "bound" || !receipt.binding) throw new Error("review rework receipt is not bound to the recorded plan");
    assertPlanBinding(receipt.binding, binding);
    receipt.state = "consumed";
    receipt.cycleId = cycleId;
    this.cycles.set(cycleId, { operationId, binding: copyBinding(binding), started: false });
  }

  startCycle(cycleId: string): void {
    const cycle = this.cycles.get(cycleId);
    if (!cycle) throw new Error("review rework cycle is not active");
    cycle.started = true;
  }

  checkCycle(cycleId: string, binding: PlanBinding): void {
    const cycle = this.cycles.get(cycleId);
    if (!cycle) throw new Error("review rework cycle is not active");
    assertPlanBinding(cycle.binding, binding);
  }

  revoke(): string[] {
    this.revision++;
    if (this.receipt && this.receipt.state !== "consumed") this.receipt.state = "revoked";
    const cycles = [...this.cycles].filter(([, cycle]) => !cycle.started).map(([id]) => id);
    for (const id of cycles) this.cycles.delete(id);
    return cycles;
  }

  finish(cycleId?: string): void {
    if (cycleId) this.cycles.delete(cycleId);
    else this.cycles.clear();
  }

  private requiredReceipt(generation: ReviewInputGeneration): Receipt {
    const receipt = this.receipt;
    if (!receipt || !sameGeneration(receipt.generation, generation)) throw new Error("review rework approval is missing or stale");
    return receipt;
  }

  private assertOperation(operationId: string, binding?: PlanBinding): Operation {
    const operation = this.operation;
    if (!operation || operation.id !== operationId) throw new Error("review rework handoff operation mismatch");
    if (binding) {
      if (!operation.binding) throw new Error("review rework handoff is not bound to a recorded plan");
      assertPlanBinding(operation.binding, binding);
    }
    if (!sameGeneration(operation.generation, this.generation())) throw new Error("stale review handoff operation");
    return operation;
  }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

export function validateReviewReworkExtraction(value: unknown, raw: string, ticket: string): ReviewReworkExtraction {
  const fail = (reason: string): never => { throw new Error(`review rework extraction: ${reason}`); };
  if (!record(value)) return fail("result must be an object");
  if (value.kind === "none") {
    if (!exactKeys(value, ["kind"])) return fail("extra fields");
    return { kind: "none" };
  }
  if (!exactKeys(value, ["kind", "evidence"]) || !["rework", "revoke"].includes(String(value.kind))) return fail("invalid fields or kind");
  const keys = [...raw.matchAll(/(?:^|[^A-Z0-9-])([A-Z][A-Z0-9]*-\d+)(?=$|[^A-Z0-9-])/g)].map((match) => match[1]!);
  if (keys.some((key) => key !== ticket)) return fail("foreign explicit ticket");
  if (!Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 8) return fail("missing evidence");
  for (const span of value.evidence) {
    if (!record(span) || !exactKeys(span, ["start", "end", "text"]) || !Number.isInteger(span.start) || !Number.isInteger(span.end) || typeof span.text !== "string" || Number(span.start) < 0 || Number(span.end) > raw.length || Number(span.end) <= Number(span.start) || raw.slice(Number(span.start), Number(span.end)) !== span.text) return fail("literal evidence span mismatch");
  }
  return value as ReviewReworkExtraction;
}

export const REVIEW_REWORK_EXTRACTION_INSTRUCTION = `Classify only the current raw interactive engineer input in an owned review conversation. Return one JSON object and no tools. "rework" means a final present-tense verdict to send this ticket back for implementation after the remarks are agreed. Questions, quotations, negations, conditions, draft remarks, discussion and agreement with one item are "none". "revoke" means stop or a changed scope before handoff. The ticket comes from the registered review identity; do not require or invent a key. Schema: {"kind":"none"} or {"kind":"rework"|"revoke","evidence":[{"start":0,"end":1,"text":"literal substring"}]}. Evidence offsets are UTF-16 indices into the unchanged raw input. No extra fields.`;

export function processIdentityMatches(pid: number, starttime: string): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    return fields[0] !== "Z" && fields[0] !== "X" && fields[19] === starttime;
  } catch { return false; }
}

export function observeProcessIdentity(pid: number, starttime: string, onExit: () => void, intervalMs = 250): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || processIdentityMatches(pid, starttime)) return;
    stopped = true;
    clearInterval(timer);
    onExit();
  }, intervalMs);
  timer.unref();
  return () => { if (!stopped) { stopped = true; clearInterval(timer); } };
}
