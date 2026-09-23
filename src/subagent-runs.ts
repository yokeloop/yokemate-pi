import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { assertMandatoryBoundary } from "./workflow-boundaries.ts";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import type { PlanBinding, PlanWriterArtifactReason } from "./plan-binding.ts";

export const PAYLOAD_LIMIT = 50 * 1024;
export const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export interface ReviewRevision { baseSha: string; headSha: string }
export interface ChildIdentity {
  readonly ownerRunId: string;
  readonly ownerSessionId: string;
  readonly batchId: string;
  readonly runId: string;
  readonly agent: string;
  readonly taskHash: string;
  readonly cwd: string;
  readonly ticket?: string;
  readonly review?: ReviewRevision;
  readonly acceptedInputId?: number;
  readonly writerRevisionOf?: string;
}
export interface ChildTask { agent: string; task: string; cwd?: string; ticket?: string; review?: ReviewRevision; acceptedInputId?: number; writerRevisionOf?: string }
export type ChildLifecycleState = "queued" | "preparing" | "running" | "terminal_claimed" | "finalized";
export type CancellationTargetKind = "ordinary" | "coordinator" | "list" | "unknown";
export type CancellationStatus = "cancellation_requested" | "cancelled" | "already_terminal" | "not_owned" | "unknown";
export interface CancellationResult {
  version: 1;
  kind: "cancellation";
  runId: string;
  targetKind: CancellationTargetKind;
  status: CancellationStatus;
  terminal: boolean;
  reason?: string;
  identity?: ChildIdentity;
  processOutcome?: ProcessOutcome;
  exitCode?: number | null;
  signal?: string | null;
  cancellationInitiator?: string;
  actualTaskHash?: string;
}
export interface CancellationRequest {
  result: CancellationResult;
  first: boolean;
  shouldSignal: boolean;
  waitForCleanup: boolean;
  completion: Promise<CancellationResult>;
}
export interface PublicationReference { state: "pending" | "complete"; target: string; revision: string; publicationId?: number; error?: string; path?: string; hash?: string; bytes?: number; targetHash?: string; acceptanceId?: number }
export type ArtifactReference =
  | { state: "verified"; path: string; hash: string; bytes: number }
  | { state: "accepted"; path: string; hash: string; bytes: number; acceptanceId: number }
  | { state: "blocked"; reason: string; path?: string; hash?: string; bytes?: number }
  | { state: "superseded"; path: string; hash: string; bytes: number; acceptanceId: number };
export type ProcessOutcome = "exited" | "signaled" | "spawn_error" | "cancelled" | "not_started";
export type PayloadOutcome = "pending" | "valid" | "missing_final" | "invalid_plan_result" | "invalid_reviewer_json" | "protocol_error" | "output_limit" | "incomplete";
export type PlanResult =
  | { state: "verified"; source: "final" | "reconciled"; binding: PlanBinding; artifactBytes: number }
  | { state: "rejected"; reason: PlanWriterArtifactReason | "writer_dispatch_mismatch" | "writer_draft_conflict"; candidateCount?: number };
export type ParserErrorKind = "invalid_json" | "invalid_event" | "record_limit" | "partial_record";
export interface ParserErrorFact { kind: ParserErrorKind; offset: number }
export interface StreamDiagnostics {
  stdoutBytes: number;
  stdoutHash: string;
  events: Record<string, number>;
  parserErrors: number;
  parserErrorCounters: Record<ParserErrorKind, number>;
  parsedBytes: number;
  malformedBytes: number;
  ignoredBytes: number;
  framingBytes: number;
  firstParserError?: ParserErrorFact;
  lastParserError?: ParserErrorFact;
  partialBytes: number;
  partialHash: string;
  assistantMessageSeen: boolean;
  assistantMessageEndCount: number;
  assistantTextBearingCount: number;
  textDeltaEvents: number;
  textDeltaBytes: number;
  finalEventPresent: boolean;
  finalTextPresent: boolean;
  finalNonWhitespace: boolean;
  finalTextBytes: number;
  finalTextHash: string;
  activeTools: number;
  retry: boolean;
  compaction: boolean;
  summaryRetry: boolean;
  phase: "text" | "thinking" | "toolcall" | "unknown";
  firstByteAt?: string;
  lastEventAt?: string;
  finalAt?: string;
}
export interface ResultDiagnostics {
  stream: StreamDiagnostics;
  stderr?: { class?: "none" | "unknown"; bytes: number; hash: string };
  final: { bytes: number; hash: string; previewBytes: number; previewHash: string; truncated: boolean };
  snapshotStorage?: { state: "available" | "unavailable"; code?: string };
}
export interface ResultEnvelope {
  version: 1;
  kind: "result";
  identity: ChildIdentity;
  actualTaskHash: string;
  processOutcome: ProcessOutcome;
  exitCode: number | null;
  signal: string | null;
  stopReason?: string;
  payloadOutcome: PayloadOutcome;
  payload: string;
  outputLimit?: "batch_transport";
  reviewVerdict: "approved" | "changes_required" | null;
  planResult?: PlanResult;
  artifact?: ArtifactReference;
  publication?: PublicationReference;
  diagnostics?: ResultDiagnostics;
  recovery?: { sourceTransport: "failed"; state: "candidate"; candidateId: string; failureHash: string; payloadHash: string; bytes: number };
  cancellationInitiator?: string;
}
export interface BatchEnvelope {
  version: 1;
  kind: "batch" | "chain";
  ownerRunId: string;
  ownerSessionId: string;
  batchId: string;
  results: readonly ResultEnvelope[];
}
export interface LaunchAck {
  version: 1;
  kind: "ack";
  terminal: false;
  batchId: string;
  children: { identity: ChildIdentity; state: "queued" | "running" }[];
}
export function reserveIdentity(ownerRunId: string, ownerSessionId: string, batchId: string, task: ChildTask, defaultCwd: string, defaultTicket?: string): ChildIdentity {
  const cwd = realpathSync(task.cwd ?? defaultCwd);
  const ticket = task.ticket ?? defaultTicket;
  if (["plan-scout", "plan-writer"].includes(task.agent) && !ticket) throw new Error(`${task.agent} requires an explicit ticket binding`);
  if (["plan-scout", "plan-writer"].includes(task.agent) && task.ticket && defaultTicket && task.ticket !== defaultTicket) throw new Error(`${task.agent} ticket differs from the stamped plan ticket`);
  if (task.agent === "plan-writer") assertMandatoryBoundary("plan.writer.admission", Number.isSafeInteger(task.acceptedInputId) && task.acceptedInputId! > 0, "plan-writer requires an explicit ticket and acceptedInputId");
  if (task.writerRevisionOf && !/^[a-f0-9]{64}$/.test(task.writerRevisionOf)) throw new Error("writerRevisionOf must be a full draft hash");
  if (task.agent === "task-reviewer" && !task.review) throw new Error("task-reviewer requires review.baseSha and review.headSha");
  if (task.review) {
    for (const sha of [task.review.baseSha, task.review.headSha]) {
      if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("review revisions must be full commit SHA values");
      execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd, stdio: "pipe" });
    }
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    if (head !== task.review.headSha) throw new Error("review.headSha does not match HEAD in cwd");
  }
  const review = task.review ? Object.freeze({ ...task.review }) : undefined;
  return Object.freeze({ ownerRunId, ownerSessionId, batchId, runId: randomUUID(), agent: task.agent, taskHash: sha256(task.task), cwd, ...(ticket ? { ticket } : {}), ...(review ? { review } : {}), ...(task.acceptedInputId ? { acceptedInputId: task.acceptedInputId } : {}), ...(task.writerRevisionOf ? { writerRevisionOf: task.writerRevisionOf } : {}) });
}
export function reviewerVerdict(text: string): "approved" | "changes_required" | null {
  try {
    const value = JSON.parse(text);
    if (!value || !["approved", "changes_required"].includes(value.status) || !Array.isArray(value.findings)) return null;
    for (const finding of value.findings) {
      if (!finding || !["blocking", "advice"].includes(finding.severity) || !Number.isInteger(finding.lens) || finding.lens < 1 || finding.lens > 7 || !Number.isInteger(finding.line) || finding.line < 1) return null;
      if (!["file", "problem", "evidence", "fix"].every((key) => typeof finding[key] === "string" && finding[key].trim())) return null;
      if (value.status === "approved" && finding.severity === "blocking") return null;
    }
    return value.status;
  } catch { return null; }
}
export function boundedText(text: string): string {
  if (Buffer.byteLength(text) <= PAYLOAD_LIMIT) return text;
  let end = PAYLOAD_LIMIT;
  const bytes = Buffer.from(text);
  while ((bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8") + "\n[Output truncated]";
}
function copyIdentity(identity: ChildIdentity): ChildIdentity {
  return { ...identity, ...(identity.review ? { review: { ...identity.review } } : {}) };
}
function copyDiagnostics(value: ResultDiagnostics | undefined): ResultDiagnostics | undefined {
  if (!value) return;
  return {
    stream: {
      ...value.stream,
      events: { ...value.stream.events },
      parserErrorCounters: { ...value.stream.parserErrorCounters },
      ...(value.stream.firstParserError ? { firstParserError: { ...value.stream.firstParserError } } : {}),
      ...(value.stream.lastParserError ? { lastParserError: { ...value.stream.lastParserError } } : {}),
    },
    ...(value.stderr ? { stderr: { ...value.stderr } } : {}),
    final: { ...value.final },
    ...(value.snapshotStorage ? { snapshotStorage: { ...value.snapshotStorage } } : {}),
  };
}
export function resultEnvelope(identity: ChildIdentity, task: string, terminal: { processOutcome: ProcessOutcome; exitCode: number | null; signal: string | null; stopReason?: string; protocolError?: boolean; incomplete?: boolean; diagnostics?: ResultDiagnostics; cancellationInitiator?: string }, text: string): ResultEnvelope {
  const clean = terminal.processOutcome === "exited" && terminal.exitCode === 0 && terminal.signal === null && terminal.stopReason === "stop" && !terminal.incomplete;
  const reviewer = identity.agent === "task-reviewer";
  const verdict = reviewer ? reviewerVerdict(text) : null;
  const overflow = (reviewer || identity.agent === "plan-writer") && Buffer.byteLength(text) > PAYLOAD_LIMIT;
  const payloadOutcome: PayloadOutcome = terminal.protocolError ? "protocol_error" : !clean ? "incomplete" : overflow ? "output_limit" : !text.trim() ? "missing_final" : reviewer && !verdict ? "invalid_reviewer_json" : "valid";
  const payload = overflow ? "" : boundedText(text);
  const supplied = copyDiagnostics(terminal.diagnostics);
  const diagnostics = supplied ? { ...supplied, final: { bytes: Buffer.byteLength(text), hash: sha256(text), previewBytes: Buffer.byteLength(payload), previewHash: sha256(payload), truncated: payload !== text } } : undefined;
  return { version: 1, kind: "result", identity: copyIdentity(identity), actualTaskHash: sha256(task), processOutcome: terminal.processOutcome, exitCode: terminal.exitCode, signal: terminal.signal, stopReason: terminal.stopReason, payloadOutcome, payload, reviewVerdict: payloadOutcome === "valid" ? verdict : null, ...(diagnostics ? { diagnostics } : {}), ...(terminal.cancellationInitiator ? { cancellationInitiator: terminal.cancellationInitiator } : {}) };
}
export function failedEnvelope(result: ResultEnvelope): boolean { return result.payloadOutcome !== "valid"; }

interface ChildRecord {
  identity: ChildIdentity;
  templateTask?: string;
  resolvedTask?: string;
  state: ChildLifecycleState;
  intent?: { initiator: string; reason?: string };
  process?: { pid: number; starttime: string };
  claim?: ResultEnvelope;
  result?: ResultEnvelope;
  cleanupDone: boolean;
  cleanupError?: string;
  cleanupPromise?: Promise<void>;
  cleanupResolve?: () => void;
  cancellationPromise?: Promise<CancellationResult>;
  cancellationResolve?: (result: CancellationResult) => void;
  finalizationPromise?: Promise<ResultEnvelope>;
  finalizationResolve?: (result: ResultEnvelope) => void;
}

export class ChildRuns {
  readonly ownerRunId: string;
  readonly ownerSessionId: string;
  readonly children = new Map<string, ChildRecord>();
  readonly batches = new Map<string, readonly ChildIdentity[]>();
  private defaultTicket?: string;
  private currentScouts = new Map<string, { runId: string; result?: ResultEnvelope }>();
  constructor(ownerRunId: string, ownerSessionId: string, defaultTicket?: string) { this.ownerRunId = ownerRunId; this.ownerSessionId = ownerSessionId; this.defaultTicket = defaultTicket; }
  admit(batchId: string, tasks: ChildTask[], cwd: string, validate?: (identity: ChildIdentity) => void): LaunchAck {
    if (this.batches.has(batchId)) throw new Error("duplicate subagent batch admission");
    const identities = tasks.map((task) => reserveIdentity(this.ownerRunId, this.ownerSessionId, batchId, task, cwd, this.defaultTicket));
    batchPayloadQuota(identities);
    const pendingScoutTickets = new Set(identities.filter((identity) => identity.agent === "plan-scout").map((identity) => identity.ticket).filter((ticket): ticket is string => !!ticket));
    for (const identity of identities) {
      if (identity.agent === "plan-writer") {
        if (identity.ticket && pendingScoutTickets.has(identity.ticket)) throw new Error(`plan-writer cannot share admission with an unsettled scout for ${identity.ticket}`);
        if (!validate) this.assertPlanWriterAdmission(identity);
      }
      validate?.(identity);
    }
    this.batches.set(batchId, Object.freeze([...identities]));
    identities.forEach((identity, index) => {
      let cleanupResolve!: () => void;
      let cancellationResolve!: (result: CancellationResult) => void;
      let finalizationResolve!: (result: ResultEnvelope) => void;
      const cleanupPromise = new Promise<void>((resolve) => { cleanupResolve = resolve; });
      const cancellationPromise = new Promise<CancellationResult>((resolve) => { cancellationResolve = resolve; });
      const finalizationPromise = new Promise<ResultEnvelope>((resolve) => { finalizationResolve = resolve; });
      if (identity.agent === "plan-scout" && identity.ticket) this.currentScouts.set(identity.ticket, { runId: identity.runId });
      this.children.set(identity.runId, { identity, templateTask: tasks[index]!.task, resolvedTask: tasks[index]!.task, state: "queued", cleanupDone: false, cleanupPromise, cleanupResolve, cancellationPromise, cancellationResolve, finalizationPromise, finalizationResolve });
    });
    return { version: 1, kind: "ack", terminal: false, batchId, children: identities.map((identity) => ({ identity, state: "queued" })) };
  }
  defer(identity: ChildIdentity): boolean {
    const child = this.valid(identity);
    if (!child || child.state !== "queued" || child.intent) return false;
    child.resolvedTask = undefined;
    return true;
  }
  resolveTask(identity: ChildIdentity, task: string): boolean {
    const child = this.valid(identity);
    if (!child || child.state === "finalized") return false;
    child.resolvedTask = task;
    return true;
  }
  start(identity: ChildIdentity): boolean {
    const child = this.valid(identity);
    if (!child || child.state !== "queued" || child.intent) return false;
    child.state = "preparing";
    return true;
  }
  canSpawn(identity: ChildIdentity): boolean {
    const child = this.valid(identity);
    return !!child && child.state === "preparing" && !child.intent && !child.claim;
  }
  attachProcess(identity: ChildIdentity, pid: number, starttime: string): boolean {
    const child = this.valid(identity);
    if (!child || child.state !== "preparing" || child.intent || child.claim || !Number.isSafeInteger(pid) || pid < 1 || !starttime) return false;
    child.process = Object.freeze({ pid, starttime });
    child.state = "running";
    return true;
  }
  process(identity: ChildIdentity): Readonly<{ pid: number; starttime: string }> | undefined {
    const child = this.valid(identity);
    return child?.process;
  }
  requestCancel(runId: string, initiator: string): CancellationRequest {
    const child = this.children.get(runId);
    if (!child) {
      const result = cancellationResult(runId, "unknown", "unknown", false);
      return { result, first: false, shouldSignal: false, waitForCleanup: false, completion: Promise.resolve(result) };
    }
    if ((child.claim || child.result) && child.cleanupDone) {
      const result = this.cancellationResult(child, "already_terminal", true);
      return { result, first: false, shouldSignal: false, waitForCleanup: false, completion: Promise.resolve(result) };
    }
    if (child.intent?.reason || child.cleanupError) {
      const result = this.cancellationResult(child, "cancellation_requested", false, child.intent?.reason ?? child.cleanupError);
      return { result, first: false, shouldSignal: false, waitForCleanup: false, completion: Promise.resolve(result) };
    }
    if (child.claim || child.result) {
      const result = this.cancellationResult(child, "cancellation_requested", false, "terminal cleanup is still pending");
      const completion = child.cleanupPromise
        ? Promise.race([child.cleanupPromise.then(() => this.cancellationResult(child, "already_terminal", true)), child.cancellationPromise!])
        : Promise.resolve(result);
      return { result, first: false, shouldSignal: false, waitForCleanup: true, completion };
    }
    const first = !child.intent;
    child.intent ??= Object.freeze({ initiator });
    if (child.state === "queued" && child.resolvedTask !== undefined) this.claimNoSpawn(child.identity);
    const immediate = child.claim && child.cleanupDone ? this.cancellationResult(child, "cancelled", true) : this.cancellationResult(child, "cancellation_requested", false);
    const completion = Promise.race([
      child.cleanupPromise!.then(() => child.claim ? this.cancellationResult(child, "cancelled", true) : this.cancellationResult(child, "cancellation_requested", false)),
      child.cancellationPromise!,
    ]);
    return { result: immediate, first, shouldSignal: first && child.state === "running", waitForCleanup: child.resolvedTask !== undefined, completion };
  }
  markCancellationUnconfirmed(runId: string, reason: string): CancellationResult {
    const child = this.children.get(runId);
    if (!child) return cancellationResult(runId, "unknown", "unknown", false);
    if (!child.intent) child.cleanupError = reason;
    else child.intent = Object.freeze({ initiator: child.intent.initiator, reason });
    const result = this.cancellationResult(child, "cancellation_requested", false, reason);
    child.cancellationResolve?.(result);
    return result;
  }
  claimNoSpawn(identity: ChildIdentity): ResultEnvelope | undefined {
    const child = this.valid(identity);
    if (!child || child.claim || child.resolvedTask === undefined) return child?.claim;
    const result = resultEnvelope(child.identity, child.resolvedTask, { processOutcome: child.intent ? "cancelled" : "not_started", exitCode: null, signal: null, ...(child.intent ? { cancellationInitiator: child.intent.initiator } : {}) }, "");
    child.claim = result;
    child.state = "terminal_claimed";
    return result;
  }
  claimTerminal(identity: ChildIdentity, task: string, terminal: { processOutcome: Exclude<ProcessOutcome, "not_started">; exitCode: number | null; signal: string | null; stopReason?: string; protocolError?: boolean; incomplete?: boolean; diagnostics?: ResultDiagnostics }, text: string): { claimed: boolean; result: ResultEnvelope } | undefined {
    const child = this.valid(identity);
    if (!child) return;
    if (child.claim) return { claimed: false, result: child.claim };
    child.resolvedTask = task;
    const result = resultEnvelope(child.identity, task, { ...terminal, processOutcome: child.intent ? "cancelled" : terminal.processOutcome, ...(child.intent ? { cancellationInitiator: child.intent.initiator } : {}) }, text);
    child.claim = result;
    child.state = "terminal_claimed";
    return { claimed: true, result };
  }
  claimed(identity: ChildIdentity): ResultEnvelope | undefined { return this.valid(identity)?.claim; }
  completeCleanup(identity: ChildIdentity): boolean {
    const child = this.valid(identity);
    if (!child || child.cleanupDone) return false;
    child.cleanupDone = true;
    child.process = undefined;
    child.cleanupResolve?.();
    return true;
  }
  cleanup(identity: ChildIdentity): Promise<void> { return this.valid(identity)?.cleanupPromise ?? Promise.resolve(); }
  settle(result: ResultEnvelope): boolean {
    const child = this.valid(result.identity);
    if (!child || child.result) return false;
    if (child.claim && ["identity", "actualTaskHash", "processOutcome", "exitCode", "signal", "cancellationInitiator"].some((key) => JSON.stringify((child.claim as any)[key]) !== JSON.stringify((result as any)[key]))) return false;
    child.claim ??= result;
    child.result = Object.freeze(structuredClone(result));
    if (result.identity.agent === "plan-scout" && result.identity.ticket) {
      const current = this.currentScouts.get(result.identity.ticket);
      if (current?.runId === result.identity.runId && result.payloadOutcome === "valid" && result.actualTaskHash === result.identity.taskHash && result.artifact?.state === "accepted") current.result = structuredClone(result);
    }
    child.state = "finalized";
    child.finalizationResolve?.(child.result);
    return true;
  }
  finalized(identity: ChildIdentity): Promise<ResultEnvelope> | undefined {
    const child = this.valid(identity);
    return child?.result ? Promise.resolve(child.result) : child?.finalizationPromise;
  }
  compactBatch(batchId: string): boolean {
    const identities = this.batches.get(batchId);
    if (!identities || identities.some((identity) => !this.children.get(identity.runId)?.result)) return false;
    this.batches.delete(batchId);
    for (const identity of identities) {
      const child = this.children.get(identity.runId)!;
      this.children.set(identity.runId, { identity: child.identity, state: "finalized", intent: child.intent, claim: child.result, result: child.result, cleanupDone: child.cleanupDone, cleanupError: child.cleanupError });
    }
    return true;
  }
  batch(batchId: string, kind: "batch" | "chain" = "batch"): BatchEnvelope | undefined {
    const identities = this.batches.get(batchId);
    if (!identities) return;
    const results = identities.map((identity) => this.children.get(identity.runId)?.result);
    if (results.some((result) => !result)) return;
    return Object.freeze({ version: 1, kind, ownerRunId: this.ownerRunId, ownerSessionId: this.ownerSessionId, batchId, results: Object.freeze(structuredClone(results as ResultEnvelope[])) });
  }
  active(): { identity: ChildIdentity; state: "queued" | "running" }[] {
    return [...this.children.values()].filter((child) => child.state !== "finalized").map(({ identity, state }) => ({ identity, state: state === "queued" ? "queued" : "running" }));
  }
  isCurrentScout(identity: ChildIdentity): boolean { return identity.agent === "plan-scout" && !!identity.ticket && this.currentScouts.get(identity.ticket)?.runId === identity.runId; }
  currentScout(ticket: string): ResultEnvelope | undefined { const result = this.currentScouts.get(ticket)?.result; return result ? structuredClone(result) : undefined; }
  result(runId: string): ResultEnvelope | undefined { const result = this.children.get(runId)?.result; return result ? structuredClone(result) : undefined; }
  terminalReviewers(scope: Pick<ChildIdentity, "ownerRunId" | "ownerSessionId" | "cwd" | "review">): ChildIdentity[] {
    if (!scope.review) return [];
    return [...this.children.values()]
      .filter((child) => child.identity.agent === "task-reviewer" && !!(child.claim || child.result) && child.identity.ownerRunId === scope.ownerRunId && child.identity.ownerSessionId === scope.ownerSessionId && child.identity.cwd === scope.cwd && child.identity.review?.baseSha === scope.review!.baseSha && child.identity.review?.headSha === scope.review!.headSha)
      .map((child) => copyIdentity(child.identity));
  }
  assertPlanWriterAdmission(identity: ChildIdentity): ResultEnvelope {
    if (identity.agent !== "plan-writer" || !identity.ticket) throw new Error("plan-writer requires an explicit ticket binding");
    const result = this.currentScout(identity.ticket);
    if (!result || result.payloadOutcome !== "valid" || result.actualTaskHash !== result.identity.taskHash || result.artifact?.state !== "accepted" || result.artifact.acceptanceId !== identity.acceptedInputId) throw new Error(`plan-writer requires the current accepted scout for ${identity.ticket}`);
    return result;
  }
  shutdownActive(): { identity: ChildIdentity; state: "queued" | "running" }[] {
    return [...this.children.values()].filter((child) => child.state !== "finalized" && child.resolvedTask !== undefined).map(({ identity, state }) => ({ identity, state: state === "queued" ? "queued" : "running" }));
  }
  owns(runId: string, ownerRunId: string, ownerSessionId: string): boolean {
    const child = this.children.get(runId);
    return !!child && child.identity.ownerRunId === ownerRunId && child.identity.ownerSessionId === ownerSessionId;
  }
  private valid(identity: ChildIdentity): ChildRecord | undefined {
    const child = this.children.get(identity.runId);
    return child && JSON.stringify(child.identity) === JSON.stringify(identity) ? child : undefined;
  }
  private cancellationResult(child: ChildRecord, status: CancellationStatus, terminal: boolean, reason?: string): CancellationResult {
    const result = child.claim ?? child.result;
    return cancellationResult(child.identity.runId, "ordinary", status, terminal, reason, child.identity, result, child.intent?.initiator);
  }
}

export function cancellationResult(runId: string, targetKind: CancellationTargetKind, status: CancellationStatus, terminal: boolean, reason?: string, identity?: ChildIdentity, result?: ResultEnvelope, initiator?: string): CancellationResult {
  return Object.freeze({ version: 1, kind: "cancellation", runId, targetKind, status, terminal, ...(reason ? { reason } : {}), ...(identity ? { identity } : {}), ...(result ? { processOutcome: result.processOutcome, exitCode: result.exitCode, signal: result.signal, actualTaskHash: result.actualTaskHash } : {}), ...(initiator ? { cancellationInitiator: initiator } : {}) });
}

const RECORD_LIMIT = 1024 * 1024;
export type ScoutEvidenceErrorKind = "invalid_json" | "invalid_event" | "record_limit" | "partial_record" | "invalid_utf8" | "lost_source" | "exhausted_evidence";
export interface ScoutEvidenceHistory {
  kind: ScoutEvidenceErrorKind;
  offset: number;
  count: number;
  hash: string;
  eventSequence: number;
}
export interface ScoutCompletenessEvidence {
  stdoutBytes: number;
  eventCount: number;
  finalSequence?: number;
  finalBytes: number;
  finalHash: string;
  sessionId?: string;
  stopReason?: string;
  errors: readonly ScoutEvidenceHistory[];
  recordLimit: boolean;
  partialRecord: boolean;
  invalidUtf8: boolean;
  lostSource: boolean;
  exhaustedEvidence: boolean;
  activeTools: number;
  retry: boolean;
  compaction: boolean;
  summaryRetry: boolean;
  agentSettled: boolean;
  settledSequence?: number;
  queueKnown: boolean;
  queueEmpty: boolean;
}
const eventNames = new Set(["session", "entry_appended", "agent_start", "agent_end", "agent_settled", "turn_start", "turn_end", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "auto_retry_start", "auto_retry_end", "compaction_start", "compaction_end", "summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished", "queue_update", "extension_error", "response", "extension_ui_request"]);
const parserCounter = (): Record<ParserErrorKind, number> => ({ invalid_json: 0, invalid_event: 0, record_limit: 0, partial_record: 0 });

export class JsonlObservation {
  private record: Buffer[] = [];
  private recordBytes = 0;
  private recordHash = createHash("sha256");
  private recordLimited = false;
  private offset = 0;
  private ended = false;
  private errors = 0;
  private firstError?: ParserErrorFact;
  private lastError?: ParserErrorFact;
  private errorCounters = parserCounter();
  private errorHistory: ScoutEvidenceHistory[] = [];
  private eventSequence = 0;
  private finalSequence?: number;
  private recordLimit = false;
  private partialRecord = false;
  private invalidUtf8 = false;
  private lostSource = false;
  private exhaustedEvidence = false;
  private tools = new Set<string>();
  private retry = false;
  private compaction = false;
  private summaryRetry = false;
  private agentSettled = false;
  private settledSequence?: number;
  private queueKnown = false;
  private queueEmpty = false;
  private counts: Record<string, number> = {};
  private stdoutHash = createHash("sha256");
  private assistantSeen = false;
  private parsedBytes = 0;
  private malformedBytes = 0;
  private ignoredBytes = 0;
  private framingBytes = 0;
  private assistantMessageEndCount = 0;
  private assistantTextBearingCount = 0;
  private textDeltaEvents = 0;
  private textDeltaBytes = 0;
  stdoutBytes = 0;
  sessionId?: string;
  finalText = "";
  stopReason?: string;
  model?: string;
  provider?: string;
  phase: "text" | "thinking" | "toolcall" | "unknown" = "unknown";
  firstByteAt?: string;
  lastEventAt?: string;
  finalAt?: string;
  private onEvent?: (event: Record<string, any>) => void;
  constructor(onEvent?: (event: Record<string, any>) => void) { this.onEvent = onEvent; }
  get protocolError(): boolean { return this.errors > 0; }
  get incomplete(): boolean { return this.tools.size > 0 || this.retry || this.compaction || this.summaryRetry; }
  markLostSource(): void { this.error("lost_source"); }
  markExhaustedEvidence(): void { this.error("exhausted_evidence"); }
  private error(kind: ScoutEvidenceErrorKind): void {
    if (kind === "record_limit" && this.recordLimited) return;
    const parserKind: ParserErrorKind = kind === "invalid_utf8" ? "invalid_json" : kind === "lost_source" || kind === "exhausted_evidence" ? "invalid_event" : kind;
    const fact = { kind: parserKind, offset: this.offset };
    this.errors++;
    this.errorCounters[parserKind]++;
    this.firstError ??= fact;
    this.lastError = fact;
    if (kind === "record_limit") this.recordLimited = true;
    const hash = this.recordHash.copy().digest("hex");
    const prior = this.errorHistory.at(-1);
    if (prior?.kind === kind && prior.offset === this.offset && prior.hash === hash) prior.count++;
    else this.errorHistory.push({ kind, offset: this.offset, count: 1, hash, eventSequence: this.eventSequence });
    if (kind === "record_limit") this.recordLimit = true;
    if (kind === "partial_record") this.partialRecord = true;
    if (kind === "invalid_utf8") this.invalidUtf8 = true;
    if (kind === "lost_source" || kind === "record_limit" || kind === "partial_record" || kind === "invalid_utf8") this.lostSource = true;
    if (kind === "exhausted_evidence") this.exhaustedEvidence = true;
  }
  write(chunk: Buffer): void {
    if (this.ended || !chunk.length) return;
    this.firstByteAt ??= new Date().toISOString();
    this.stdoutBytes += chunk.length;
    this.stdoutHash.update(chunk);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      this.consumeRecordBytes(chunk.subarray(start, end));
      if (newline < 0) break;
      this.finishRecord();
      this.framingBytes++;
      this.offset += this.recordBytes + 1;
      this.resetRecord();
      start = newline + 1;
    }
  }
  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.recordBytes) {
      const trailingCr = this.record.length > 0 && this.record[this.record.length - 1]!.at(-1) === 13;
      if (this.recordBytes - (trailingCr ? 1 : 0) > RECORD_LIMIT) this.error("record_limit");
      this.error("partial_record");
    }
  }
  private consumeRecordBytes(bytes: Buffer): void {
    if (!bytes.length) return;
    this.recordBytes += bytes.length;
    this.recordHash.update(bytes);
    if (!this.recordLimited && this.recordBytes <= RECORD_LIMIT + 1) this.record.push(Buffer.from(bytes));
    if (this.recordBytes > RECORD_LIMIT + 1) {
      this.record = [];
      this.error("record_limit");
    }
  }
  private finishRecord(): void {
    const joined = this.record.length ? Buffer.concat(this.record) : Buffer.alloc(0);
    const line = joined.length && joined[joined.length - 1] === 13 ? joined.subarray(0, -1) : joined;
    if (this.recordBytes - (joined.length !== line.length ? 1 : 0) > RECORD_LIMIT) this.error("record_limit");
    if (this.recordLimited) { this.malformedBytes += this.recordBytes; return; }
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(line); }
    catch { this.error("invalid_utf8"); this.malformedBytes += this.recordBytes; return; }
    const outcome = this.parse(text);
    if (outcome === "parsed") this.parsedBytes += this.recordBytes;
    else if (outcome === "ignored") this.ignoredBytes += this.recordBytes;
    else this.malformedBytes += this.recordBytes;
  }
  private resetRecord(): void {
    this.record = [];
    this.recordBytes = 0;
    this.recordHash = createHash("sha256");
    this.recordLimited = false;
  }
  private validAgentEndSummary(event: Record<string, any>): boolean {
    if (event.type !== "agent_end" || event.messagesSummary === undefined) return true;
    if ("messages" in event || !["type", "messagesSummary", "willRetry"].every((key) => key in event || key === "willRetry") || Object.keys(event).some((key) => !["type", "messagesSummary", "willRetry"].includes(key))) return false;
    if (event.willRetry !== undefined && typeof event.willRetry !== "boolean") return false;
    const summary = event.messagesSummary;
    return !!summary && typeof summary === "object" && !Array.isArray(summary)
      && Object.keys(summary).sort().join(",") === "bytes,count,sha256,version"
      && summary.version === 1
      && Number.isSafeInteger(summary.count) && summary.count >= 0
      && Number.isSafeInteger(summary.bytes) && summary.bytes >= 0
      && typeof summary.sha256 === "string" && /^[a-f0-9]{64}$/.test(summary.sha256);
  }
  private parse(line: string): "parsed" | "malformed" | "ignored" {
    if (!line.trim()) return "ignored";
    let event: any;
    try { event = JSON.parse(line); } catch { this.error("invalid_json"); return "malformed"; }
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string" || !this.validAgentEndSummary(event)) { this.error("invalid_event"); return "malformed"; }
    const name = eventNames.has(event.type) ? event.type : "other";
    this.eventSequence++;
    if (this.agentSettled && event.type !== "agent_settled") {
      this.agentSettled = false;
      this.settledSequence = undefined;
    }
    this.counts[name] = (this.counts[name] ?? 0) + 1;
    this.lastEventAt = new Date().toISOString();
    if (event.type === "session" && typeof event.id === "string" && /^[a-f0-9-]{36}$/.test(event.id)) this.sessionId = event.id;
    if (event.type === "message_update") {
      const phase = String(event.assistantMessageEvent?.type).split("_")[0];
      if (phase === "text" || phase === "thinking" || phase === "toolcall") this.phase = phase;
      if (event.assistantMessageEvent?.type === "text_delta" && typeof event.assistantMessageEvent.delta === "string") {
        this.textDeltaEvents++;
        this.textDeltaBytes += Buffer.byteLength(event.assistantMessageEvent.delta);
      }
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      this.assistantSeen = true;
      this.assistantMessageEndCount++;
      const message = event.message;
      this.finalText = Array.isArray(message.content) ? message.content.filter((block: any) => block?.type === "text" && typeof block.text === "string").map((block: any) => block.text).join("") : "";
      if (Buffer.byteLength(this.finalText) > 0) this.assistantTextBearingCount++;
      this.stopReason = ["stop", "length", "toolUse", "error", "aborted", "pending", "deferred"].includes(message.stopReason) ? message.stopReason : undefined;
      this.model = typeof message.model === "string" && /^[a-zA-Z0-9_.:/+-]{1,200}$/.test(message.model) ? message.model : undefined;
      this.provider = typeof message.provider === "string" && /^[a-zA-Z0-9_.:/+-]{1,200}$/.test(message.provider) ? message.provider : undefined;
      this.finalAt = this.lastEventAt;
      this.finalSequence = this.eventSequence;
    }
    if (event.type === "tool_execution_start" && typeof event.toolCallId === "string") this.tools.add(sha256(event.toolCallId));
    if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") this.tools.delete(sha256(event.toolCallId));
    if (event.type === "auto_retry_start") this.retry = true;
    if (event.type === "auto_retry_end") this.retry = false;
    if (event.type === "compaction_start") this.compaction = true;
    if (event.type === "compaction_end") this.compaction = false;
    if (event.type === "summarization_retry_scheduled" || event.type === "summarization_retry_attempt_start") this.summaryRetry = true;
    if (event.type === "summarization_retry_finished") this.summaryRetry = false;
    if (event.type === "queue_update") {
      this.queueKnown = true;
      this.queueEmpty = !(Array.isArray(event.steering) && event.steering.length) && !(Array.isArray(event.followUp) && event.followUp.length);
    }
    if (event.type === "agent_settled") {
      this.agentSettled = true;
      this.settledSequence = this.eventSequence;
      if (!this.queueKnown) {
        this.queueKnown = true;
        this.queueEmpty = true;
      }
    }
    this.onEvent?.(event);
    return "parsed";
  }
  evidence(): ScoutCompletenessEvidence {
    return Object.freeze({ stdoutBytes: this.stdoutBytes, eventCount: this.eventSequence, finalSequence: this.finalSequence, finalBytes: Buffer.byteLength(this.finalText), finalHash: sha256(this.finalText), sessionId: this.sessionId, stopReason: this.stopReason, errors: Object.freeze(this.errorHistory.map((entry) => Object.freeze({ ...entry }))), recordLimit: this.recordLimit, partialRecord: this.partialRecord, invalidUtf8: this.invalidUtf8, lostSource: this.lostSource, exhaustedEvidence: this.exhaustedEvidence, activeTools: this.tools.size, retry: this.retry, compaction: this.compaction, summaryRetry: this.summaryRetry, agentSettled: this.agentSettled, settledSequence: this.settledSequence, queueKnown: this.queueKnown, queueEmpty: this.queueEmpty });
  }
  metadata(): StreamDiagnostics {
    return {
      stdoutBytes: this.stdoutBytes,
      stdoutHash: this.stdoutHash.copy().digest("hex"),
      events: { ...this.counts },
      parserErrors: this.errors,
      parserErrorCounters: { ...this.errorCounters },
      parsedBytes: this.parsedBytes,
      malformedBytes: this.malformedBytes,
      ignoredBytes: this.ignoredBytes,
      framingBytes: this.framingBytes,
      ...(this.firstError ? { firstParserError: { ...this.firstError } } : {}),
      ...(this.lastError ? { lastParserError: { ...this.lastError } } : {}),
      partialBytes: this.recordBytes,
      partialHash: this.recordHash.copy().digest("hex"),
      assistantMessageSeen: this.assistantSeen,
      assistantMessageEndCount: this.assistantMessageEndCount,
      assistantTextBearingCount: this.assistantTextBearingCount,
      textDeltaEvents: this.textDeltaEvents,
      textDeltaBytes: this.textDeltaBytes,
      finalEventPresent: this.assistantMessageEndCount > 0,
      finalTextPresent: Buffer.byteLength(this.finalText) > 0,
      finalNonWhitespace: this.finalText.trim().length > 0,
      finalTextBytes: Buffer.byteLength(this.finalText),
      finalTextHash: sha256(this.finalText),
      activeTools: this.tools.size,
      retry: this.retry,
      compaction: this.compaction,
      summaryRetry: this.summaryRetry,
      phase: this.phase,
      firstByteAt: this.firstByteAt,
      lastEventAt: this.lastEventAt,
      finalAt: this.finalAt,
    };
  }
}

export function fileProvenance(file: string): { path: string; hash: string } | undefined {
  try { const canonical = fs.realpathSync(file); return { path: canonical, hash: sha256(fs.readFileSync(canonical)) }; } catch { return undefined; }
}
export function errorMetadata(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException)?.code;
  return { class: ["ENOENT", "EACCES", "EPERM", "ENOSPC", "EIO", "EPIPE"].includes(code ?? "") ? code : "unknown", bytes: Buffer.byteLength(message), hash: sha256(message) };
}
export type SnapshotStorageCode = "storage_busy" | "storage_limit" | "artifact_invalid" | "ENOENT" | "EACCES" | "EPERM" | "ENOSPC" | "EIO" | "unknown";
export interface SnapshotStorageStatus { state: "available" | "unavailable"; code?: SnapshotStorageCode }
export interface RunSnapshotV1 {
  customType: "yokemate-run-snapshot";
  version: 1;
  ownerRunId: string;
  ownerSessionId?: string;
  batchId?: string;
  runId: string;
  agent?: string;
  ticket?: string;
  taskHash?: string;
  actualTaskHash?: string;
  lifecycle: { admittedAt?: string; spawnAt?: string; closeAt?: string; settledAt?: string; processClosed: boolean; deliveriesTerminal: boolean };
  owner?: { pid?: number; starttime?: string };
  process?: { pid?: number; starttime?: string; outcome?: string; exitCode?: number | null; signal?: string | null; stopReason?: string; cancellationInitiator?: string };
  runtime?: { node?: string; pi?: string; contract?: number };
  hashes?: { task?: string; actualTask?: string; appendedPrompt?: string };
  resources?: Record<string, { path: string; hash: string }>;
  stream?: StreamDiagnostics;
  stderr?: { class?: "none" | "unknown"; bytes: number; hash: string };
  payload?: { outcome?: string; originalBytes?: number; originalHash?: string; deliveredBytes?: number; deliveredHash?: string; truncated?: boolean; outputLimit?: string };
  writerResult?: { state?: string; source?: string; reason?: string; candidateCount?: number; path?: string; contentHash?: string; scopeHash?: string; artifactBytes?: number };
  artifact?: { state?: string; hash?: string; bytes?: number; acceptanceId?: number };
  publication?: { state?: string; revision?: string; publicationId?: number; error?: string };
  deliveries: Array<{ id: string; state: string; envelopeHash?: string; at?: string }>;
  snapshotStorage: SnapshotStorageStatus;
  updatedAt: string;
}
interface SnapshotFile { path: string; name: string; size: number; updated: number; own: boolean; terminal: boolean }
const snapshotCode = (error: unknown): SnapshotStorageCode => {
  const explicit = (error as { code?: string })?.code;
  return ["storage_busy", "storage_limit", "artifact_invalid", "ENOENT", "EACCES", "EPERM", "ENOSPC", "EIO"].includes(explicit ?? "") ? explicit as SnapshotStorageCode : "unknown";
};
const safeString = (value: unknown, pattern = /^[a-zA-Z0-9_.:/+-]{1,240}$/): string | undefined => typeof value === "string" && pattern.test(value) ? value : undefined;
const safeNumber = (value: unknown): number | undefined => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
const allowlistedStream = (source: unknown): StreamDiagnostics | undefined => {
  if (!source || typeof source !== "object") return;
  const value = source as Record<string, unknown>;
  const counters = value.parserErrorCounters && typeof value.parserErrorCounters === "object" ? value.parserErrorCounters as Record<string, unknown> : {};
  const error = (raw: unknown): ParserErrorFact | undefined => {
    if (!raw || typeof raw !== "object") return;
    const item = raw as Record<string, unknown>;
    if (!["invalid_json", "invalid_event", "record_limit", "partial_record"].includes(String(item.kind))) return;
    const offset = safeNumber(item.offset);
    return offset === undefined ? undefined : { kind: item.kind as ParserErrorKind, offset };
  };
  const eventsSource = value.events && typeof value.events === "object" ? value.events as Record<string, unknown> : {};
  const events: Record<string, number> = {};
  for (const kind of ["session", "agent_start", "turn_start", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "turn_end", "agent_end", "agent_settled", "other"]) {
    const count = safeNumber(eventsSource[kind]);
    if (count !== undefined) events[kind] = count;
  }
  const stdoutBytes = safeNumber(value.stdoutBytes);
  const stdoutHash = safeString(value.stdoutHash, /^[a-f0-9]{64}$/);
  const parserErrors = safeNumber(value.parserErrors);
  const partialBytes = safeNumber(value.partialBytes);
  const partialHash = safeString(value.partialHash, /^[a-f0-9]{64}$/);
  const parsedBytes = safeNumber(value.parsedBytes);
  const malformedBytes = safeNumber(value.malformedBytes);
  const ignoredBytes = safeNumber(value.ignoredBytes);
  const framingBytes = safeNumber(value.framingBytes);
  const finalTextBytes = safeNumber(value.finalTextBytes);
  const finalTextHash = safeString(value.finalTextHash, /^[a-f0-9]{64}$/);
  if ([stdoutBytes, parserErrors, partialBytes, parsedBytes, malformedBytes, ignoredBytes, framingBytes, finalTextBytes].some((item) => item === undefined) || !stdoutHash || !partialHash || !finalTextHash) return;
  const phase = ["text", "thinking", "toolcall", "unknown"].includes(String(value.phase)) ? value.phase as StreamDiagnostics["phase"] : "unknown";
  return {
    stdoutBytes: stdoutBytes!, stdoutHash, events, parserErrors: parserErrors!,
    parserErrorCounters: {
      invalid_json: safeNumber(counters.invalid_json) ?? 0,
      invalid_event: safeNumber(counters.invalid_event) ?? 0,
      record_limit: safeNumber(counters.record_limit) ?? 0,
      partial_record: safeNumber(counters.partial_record) ?? 0,
    },
    ...(error(value.firstParserError) ? { firstParserError: error(value.firstParserError) } : {}),
    ...(error(value.lastParserError) ? { lastParserError: error(value.lastParserError) } : {}),
    parsedBytes: parsedBytes!, malformedBytes: malformedBytes!, ignoredBytes: ignoredBytes!, framingBytes: framingBytes!,
    partialBytes: partialBytes!, partialHash,
    assistantMessageSeen: value.assistantMessageSeen === true,
    assistantMessageEndCount: safeNumber(value.assistantMessageEndCount) ?? 0,
    assistantTextBearingCount: safeNumber(value.assistantTextBearingCount) ?? 0,
    textDeltaEvents: safeNumber(value.textDeltaEvents) ?? 0,
    textDeltaBytes: safeNumber(value.textDeltaBytes) ?? 0,
    finalEventPresent: value.finalEventPresent === true,
    finalTextPresent: value.finalTextPresent === true,
    finalNonWhitespace: value.finalNonWhitespace === true,
    finalTextBytes: finalTextBytes!,
    finalTextHash,
    activeTools: safeNumber(value.activeTools) ?? 0,
    retry: value.retry === true,
    compaction: value.compaction === true,
    summaryRetry: value.summaryRetry === true,
    phase,
    ...(safeString(value.firstByteAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/) ? { firstByteAt: value.firstByteAt as string } : {}),
    ...(safeString(value.lastEventAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/) ? { lastEventAt: value.lastEventAt as string } : {}),
    ...(safeString(value.finalAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/) ? { finalAt: value.finalAt as string } : {}),
  };
};

export class RunSnapshots {
  readonly directory: string;
  private pid: number;
  private starttime: (pid: number) => string | undefined;
  constructor(root: string, _legacyPlanOrOptions?: string | { pid?: number; processStarttime?: (pid: number) => string | undefined }) {
    const options = typeof _legacyPlanOrOptions === "object" ? _legacyPlanOrOptions : {};
    this.directory = path.join(path.resolve(root), "sessions", "subagent-runs");
    this.pid = options.pid ?? process.pid;
    this.starttime = options.processStarttime ?? ((pid) => {
      try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8").trim().split(/\s+/)[21]; } catch { return undefined; }
    });
  }
  write(ownerRunId: string, runId: string, metadata: Record<string, unknown>, completed: boolean): SnapshotStorageStatus {
    let lockOwned = false;
    let temporary: string | undefined;
    try {
      if (![ownerRunId, runId].every((id) => /^[a-zA-Z0-9-]{1,80}$/.test(id))) throw Object.assign(new Error("invalid diagnostic identity"), { code: "artifact_invalid" });
      this.initialize();
      const lock = path.join(this.directory, ".lock");
      try { this.createLock(lock); lockOwned = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !this.clearStaleLock(lock)) throw Object.assign(error as Error, { code: (error as NodeJS.ErrnoException).code === "EEXIST" ? "storage_busy" : (error as NodeJS.ErrnoException).code });
        this.createLock(lock);
        lockOwned = true;
      }
      this.cleanOwnTemps();
      const targetName = `${ownerRunId}-${runId}.json`;
      const target = path.join(this.directory, targetName);
      const snapshot = this.allowlisted(ownerRunId, runId, metadata, completed);
      const data = Buffer.from(JSON.stringify(snapshot));
      if (data.length > PAYLOAD_LIMIT) throw Object.assign(new Error("snapshot limit"), { code: "storage_limit" });
      let entries = this.inspect();
      const targetEntry = entries.find((entry) => entry.path === target);
      const incomingTerminal = snapshot.lifecycle.processClosed && snapshot.lifecycle.deliveriesTerminal;
      const removable = () => entries.filter((entry) => entry.own && entry.terminal && entry.path !== target).sort((a, b) => a.updated - b.updated || a.name.localeCompare(b.name));
      const ownCount = () => entries.filter((entry) => entry.own && entry.path !== target).length + 1;
      const terminalCount = () => entries.filter((entry) => entry.own && entry.terminal && entry.path !== target).length + (incomingTerminal ? 1 : 0);
      const temporaryBudget = () => entries.reduce((sum, entry) => sum + entry.size, 0) + data.length + 512;
      while (ownCount() > 40 || terminalCount() > 20 || temporaryBudget() > 2 * 1024 * 1024) {
        const oldest = removable()[0];
        if (!oldest) throw Object.assign(new Error("snapshot disk budget"), { code: "storage_limit" });
        const checked = fs.lstatSync(oldest.path);
        if (!checked.isFile() || checked.isSymbolicLink()) throw Object.assign(new Error("snapshot changed"), { code: "artifact_invalid" });
        fs.unlinkSync(oldest.path);
        entries = entries.filter((entry) => entry.path !== oldest.path);
      }
      temporary = path.join(this.directory, `.tmp-${ownerRunId}-${runId}-${randomUUID()}`);
      const descriptor = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(descriptor, data); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, target);
      temporary = undefined;
      try { const directoryFd = fs.openSync(this.directory, "r"); try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); } } catch {}
      return { state: "available" };
    } catch (error) {
      const code = snapshotCode(error);
      console.error(`[subagent] diagnostic snapshot unavailable: ${code}`);
      return { state: "unavailable", code };
    } finally {
      if (temporary) try { fs.unlinkSync(temporary); } catch {}
      if (lockOwned) {
        const lock = path.join(this.directory, ".lock");
        try {
          const owner = JSON.parse(fs.readFileSync(lock, "utf8"));
          if (owner.pid === this.pid && owner.starttime === this.starttime(this.pid)) fs.unlinkSync(lock);
        } catch {}
      }
    }
  }
  private initialize(): void {
    const parsed = path.parse(this.directory);
    let current = parsed.root;
    for (const component of this.directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      try {
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current) throw Object.assign(new Error("invalid snapshot path"), { code: "artifact_invalid" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        fs.mkdirSync(current, { mode: 0o700 });
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current) throw Object.assign(new Error("invalid snapshot path"), { code: "artifact_invalid" });
      }
    }
    fs.chmodSync(this.directory, 0o700);
  }
  private createLock(lock: string): void {
    fs.writeFileSync(lock, JSON.stringify({ pid: this.pid, starttime: this.starttime(this.pid) }), { mode: 0o600, flag: "wx" });
  }
  private clearStaleLock(lock: string): boolean {
    try {
      const stat = fs.lstatSync(lock);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512) return false;
      const owner = JSON.parse(fs.readFileSync(lock, "utf8"));
      if (!Number.isInteger(owner.pid) || typeof owner.starttime !== "string") return false;
      const actual = this.starttime(owner.pid);
      if (actual === owner.starttime || (actual === undefined && fs.existsSync(`/proc/${owner.pid}`))) return false;
      fs.unlinkSync(lock);
      return true;
    } catch { return false; }
  }
  private cleanOwnTemps(): void {
    for (const name of fs.readdirSync(this.directory)) {
      if (!/^\.tmp-[a-zA-Z0-9-]{1,80}-[a-zA-Z0-9-]{1,80}-[a-f0-9-]{36}$/.test(name)) continue;
      const file = path.join(this.directory, name);
      try { const stat = fs.lstatSync(file); if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(file); } catch {}
    }
  }
  private inspect(): SnapshotFile[] {
    return fs.readdirSync(this.directory).filter((name) => name !== ".lock").map((name) => {
      const file = path.join(this.directory, name);
      const stat = fs.lstatSync(file);
      let own = false;
      let terminal = false;
      if (stat.isFile() && !stat.isSymbolicLink() && /^[a-zA-Z0-9-]{1,80}-[a-zA-Z0-9-]{1,80}\.json$/.test(name) && stat.size <= PAYLOAD_LIMIT) try {
        const value = JSON.parse(fs.readFileSync(file, "utf8"));
        own = value.customType === "yokemate-run-snapshot" && value.version === 1 && name === `${value.ownerRunId}-${value.runId}.json`;
        terminal = own && value.lifecycle?.processClosed === true && value.lifecycle?.deliveriesTerminal === true;
      } catch {}
      return { path: file, name, size: stat.size, updated: stat.mtimeMs, own, terminal };
    });
  }
  private allowlisted(ownerRunId: string, runId: string, metadata: Record<string, unknown>, completed: boolean): RunSnapshotV1 {
    const identity = metadata.identity && typeof metadata.identity === "object" ? metadata.identity as Record<string, unknown> : {};
    const terminal = metadata.terminal && typeof metadata.terminal === "object" ? metadata.terminal as Record<string, unknown> : {};
    const deliveriesObject = metadata.deliveries && typeof metadata.deliveries === "object" ? metadata.deliveries as Record<string, unknown> : {};
    const deliveries = Object.entries(deliveriesObject).slice(0, 3).map(([id, raw]) => {
      const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const envelopeHash = safeString(value.envelopeHash, /^[a-f0-9]{64}$/);
      const at = safeString(value.observedAt ?? value.failedAt ?? value.enqueuedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
      return { id: safeString(id, /^[a-f0-9]{64}$/) ?? sha256(id), state: safeString(value.state, /^[a-z_]{1,40}$/) ?? "unknown", ...(envelopeHash ? { envelopeHash } : {}), ...(at ? { at } : {}) };
    });
    const processClosed = completed && typeof metadata.closeAt === "string";
    const deliveriesTerminal = deliveries.length > 0 ? deliveries.every((delivery) => ["observed", "delivery_failed", "delivery_unknown"].includes(delivery.state)) : processClosed && metadata.noDeliveriesExpected === true;
    const resources: Record<string, { path: string; hash: string }> = {};
    for (const [role, source] of [["extension", metadata.extension], ["guard", metadata.guard], ["launch", metadata.launch], ["agentDefinition", metadata.agentDefinition]] as const) {
      if (!source || typeof source !== "object") continue;
      const record = source as Record<string, unknown>;
      if (typeof record.path === "string" && typeof record.hash === "string" && /^[a-f0-9]{64}$/.test(record.hash)) resources[role] = { path: record.path, hash: record.hash };
    }
    const runtime = metadata.runtime && typeof metadata.runtime === "object" ? metadata.runtime as Record<string, unknown> : {};
    const artifact = metadata.artifact && typeof metadata.artifact === "object" ? metadata.artifact as Record<string, unknown> : {};
    const publication = metadata.publication && typeof metadata.publication === "object" ? metadata.publication as Record<string, unknown> : {};
    const payload = metadata.payload && typeof metadata.payload === "object" ? metadata.payload as Record<string, unknown> : {};
    const writer = metadata.writerResult && typeof metadata.writerResult === "object" ? metadata.writerResult as Record<string, unknown> : {};
    const writerBinding = writer.binding && typeof writer.binding === "object" ? writer.binding as Record<string, unknown> : {};
    const stream = allowlistedStream(metadata.stream);
    const artifactState = safeString(artifact.state, /^[a-z_]{1,40}$/);
    const artifactHash = safeString(artifact.hash, /^[a-f0-9]{64}$/);
    const publicationState = safeString(publication.state, /^[a-z_]{1,40}$/);
    const publicationRevision = safeString(publication.revision, /^[a-f0-9]{64}$/);
    const publicationError = safeString(publication.error, /^[a-z_]{1,80}$/);
    return {
      customType: "yokemate-run-snapshot", version: 1, ownerRunId,
      ...(safeString(identity.ownerSessionId) ? { ownerSessionId: identity.ownerSessionId as string } : {}),
      ...(safeString(identity.batchId) ? { batchId: identity.batchId as string } : {}), runId,
      ...(safeString(identity.agent) ? { agent: identity.agent as string } : {}),
      ...(safeString(identity.ticket, /^[A-Z][A-Z0-9]*-\d+$/) ? { ticket: identity.ticket as string } : {}),
      ...(safeString(identity.taskHash, /^[a-f0-9]{64}$/) ? { taskHash: identity.taskHash as string } : {}),
      ...(safeString(metadata.actualTaskHash, /^[a-f0-9]{64}$/) ? { actualTaskHash: metadata.actualTaskHash as string } : {}),
      lifecycle: { admittedAt: safeString(metadata.admissionAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/), spawnAt: safeString(metadata.spawnAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/), closeAt: safeString(metadata.closeAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/), settledAt: safeString(metadata.settledAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/), processClosed, deliveriesTerminal },
      owner: { pid: safeNumber(metadata.ownerPid), starttime: safeString(metadata.ownerStarttime, /^\d{1,30}$/) },
      process: { pid: safeNumber(metadata.pid), starttime: safeString(metadata.starttime, /^\d{1,30}$/), outcome: safeString(terminal.processOutcome, /^[a-z_]{1,40}$/), exitCode: terminal.exitCode === null || Number.isInteger(terminal.exitCode) ? terminal.exitCode as number | null : undefined, signal: safeString(terminal.signal, /^[A-Z0-9]+$/), stopReason: safeString(terminal.stopReason, /^[a-zA-Z0-9_ -]{1,80}$/), cancellationInitiator: safeString(metadata.cancellationInitiator, /^[a-z_]{1,80}$/) },
      runtime: { node: safeString(runtime.node, /^v?\d+(?:\.\d+){2}$/), pi: safeString(runtime.pi, /^\d+(?:\.\d+){2}$/), contract: safeNumber(runtime.contract) },
      hashes: { task: safeString(metadata.taskHash, /^[a-f0-9]{64}$/), actualTask: safeString(metadata.actualTaskHash, /^[a-f0-9]{64}$/), appendedPrompt: safeString(metadata.appendedPromptHash, /^[a-f0-9]{64}$/) },
      ...(Object.keys(resources).length ? { resources } : {}),
      ...(stream ? { stream } : {}),
      ...(metadata.stderr && typeof metadata.stderr === "object" ? { stderr: { class: ["none", "unknown"].includes(String((metadata.stderr as any).class)) ? (metadata.stderr as any).class : "unknown", bytes: safeNumber((metadata.stderr as any).bytes) ?? 0, hash: safeString((metadata.stderr as any).hash, /^[a-f0-9]{64}$/) ?? sha256("") } } : {}),
      ...(safeString(payload.outcome, /^[a-z_]{1,40}$/) ? { payload: { outcome: payload.outcome as string, originalBytes: safeNumber(payload.bytes), originalHash: safeString(payload.hash, /^[a-f0-9]{64}$/), deliveredBytes: safeNumber(payload.retainedBytes), deliveredHash: safeString(payload.retainedHash, /^[a-f0-9]{64}$/), truncated: payload.truncated === true, outputLimit: safeString(payload.outputLimit, /^[a-z_]{1,40}$/) } } : {}),
      ...(["verified", "rejected"].includes(String(writer.state)) ? { writerResult: { state: writer.state as string, source: safeString(writer.source, /^(final|reconciled)$/), reason: safeString(writer.reason, /^[a-z_]{1,80}$/), candidateCount: safeNumber(writer.candidateCount), path: safeString(writerBinding.path, /^[^\x00-\x1f\x7f]{1,4096}$/), contentHash: safeString(writerBinding.contentHash, /^[a-f0-9]{64}$/), scopeHash: safeString(writerBinding.scopeHash, /^[a-f0-9]{64}$/), artifactBytes: safeNumber(writer.artifactBytes) } } : {}),
      ...(artifactState || artifactHash ? { artifact: { state: artifactState, hash: artifactHash, bytes: safeNumber(artifact.bytes), acceptanceId: safeNumber(artifact.acceptanceId) } } : {}),
      ...(publicationState || publicationRevision || publicationError ? { publication: { state: publicationState, revision: publicationRevision, publicationId: safeNumber(publication.publicationId), error: publicationError } } : {}),
      deliveries,
      snapshotStorage: { state: "available" },
      updatedAt: new Date().toISOString(),
    };
  }
}

export type ReportEnvelope = ResultEnvelope | BatchEnvelope;
export interface ReportDelivery {
  deliveryId: string;
  batchId: string;
  runIds: string[];
  envelopeHash: string;
  state: "pending" | "enqueued" | "observed" | "delivery_failed" | "delivery_unknown";
  code?: string;
  failedAt?: string;
  observedAt?: string;
}
export interface ChildStateSnapshot {
  version: 1;
  ownerRunId: string;
  ownerSessionId: string;
  pid: number;
  starttime: string;
  sequence: number;
  children: LaunchAck["children"];
  deliveries: ReportDelivery[];
  producerObligations?: number;
  batchDispatches?: number;
}
export function deliveryFor(envelope: ReportEnvelope): ReportDelivery {
  const identity = envelope.kind === "result" ? envelope.identity : envelope;
  const runIds = envelope.kind === "result" ? [envelope.identity.runId] : envelope.results.map((result) => result.identity.runId);
  const envelopeHash = sha256(JSON.stringify(envelope));
  return { deliveryId: sha256(JSON.stringify([identity.ownerRunId, identity.ownerSessionId, identity.batchId, envelope.kind, runIds, envelopeHash])), batchId: identity.batchId, runIds, envelopeHash, state: "pending" };
}
export function reportContent(envelope: ReportEnvelope, delivery: ReportDelivery): string {
  const prefix = envelope.kind === "result" ? `[subagent ${envelope.identity.agent}${failedEnvelope(envelope) ? " failed" : ""}]` : envelope.kind === "batch" ? "[subagent batch complete]" : "[subagent chain]";
  return `${prefix} ${JSON.stringify({ version: 1, deliveryId: delivery.deliveryId, envelopeHash: delivery.envelopeHash, envelope })}`;
}
export interface ObservedReviewScope { ownerRunId: string; ownerSessionId: string; cwd: string; baseSha: string; headSha: string }
export function matchingObservedReview(runs: ChildRuns, identity: ChildIdentity, scope: ObservedReviewScope, entries: Iterable<{ delivery: ReportDelivery; envelope: ReportEnvelope }>): ResultEnvelope | undefined {
  let canonicalCwd: string;
  try { canonicalCwd = realpathSync(scope.cwd); } catch { return; }
  if (identity.agent !== "task-reviewer" || !identity.review || identity.ownerRunId !== scope.ownerRunId || identity.ownerSessionId !== scope.ownerSessionId || identity.cwd !== canonicalCwd || identity.review.baseSha !== scope.baseSha || identity.review.headSha !== scope.headSha) return;
  const stored = runs.result(identity.runId);
  if (!stored || JSON.stringify(stored.identity) !== JSON.stringify(identity)) return;
  for (const entry of entries) {
    if (entry.delivery.state !== "observed" || !entry.delivery.runIds.includes(identity.runId)) continue;
    const canonical = deliveryFor(entry.envelope);
    if (canonical.deliveryId !== entry.delivery.deliveryId || canonical.envelopeHash !== entry.delivery.envelopeHash || canonical.batchId !== entry.delivery.batchId || JSON.stringify(canonical.runIds) !== JSON.stringify(entry.delivery.runIds)) continue;
    const candidate = entry.envelope.kind === "result" ? entry.envelope : entry.envelope.results.find((result) => result.identity.runId === identity.runId);
    if (!candidate || JSON.stringify(candidate) !== JSON.stringify(stored) || JSON.stringify(candidate.identity) !== JSON.stringify(identity)) continue;
    return structuredClone(stored);
  }
}
export class OwnedChildState {
  private runId: string;
  private pid: number;
  private starttime: string;
  private sessionId?: string;
  private snapshot?: ChildStateSnapshot;
  private provisional?: ChildStateSnapshot;
  private invalid = false;
  private launches = new Map<string, ChildTask[]>();
  private admitted = new Map<string, ChildIdentity>();
  private inFlight = new Set<string>();
  private progress = 0;
  private lastNudgeProgress = -1;
  private deliveryErrors = new Set<string>();
  recordDeliveryError(): void {
    for (const delivery of this.snapshot?.deliveries ?? []) if (delivery.state === "delivery_failed") this.deliveryErrors.add(delivery.deliveryId);
  }
  uncertainDeliveryIds(): string[] { return [...this.deliveryErrors]; }
  get deliveryError(): boolean { return this.deliveryErrors.size > 0; }
  retry = false;
  compaction = false;
  queue = false;
  constructor(runId: string, pid: number, starttime: string) { this.runId = runId; this.pid = pid; this.starttime = starttime; }
  ownerRunId(): string { return this.runId; }
  bindSession(sessionId: string): void {
    if (this.sessionId && this.sessionId !== sessionId) { this.invalid = true; return; }
    this.sessionId = sessionId;
    if (this.provisional) { const snapshot = this.provisional; this.provisional = undefined; this.accept(snapshot); }
  }
  toolStart(batchId: string, args: any): void {
    this.inFlight.add(batchId);
    const tasks = args?.chain ?? args?.tasks ?? (args?.agent && args?.task ? [args] : []);
    this.launches.set(batchId, tasks);
  }
  toolEnd(batchId: string, ack: unknown, error: boolean): void {
    this.inFlight.delete(batchId);
    if (error) return;
    const value = ack as LaunchAck;
    if (!value || value.kind !== "ack" || value.batchId !== batchId || !Array.isArray(value.children)) {
      if ((this.launches.get(batchId)?.length ?? 0) > 0) this.invalid = true;
      return;
    }
    if (value.version !== 1 || value.terminal !== false || value.children.length !== this.launches.get(batchId)?.length || new Set(value.children.map((child) => child.identity?.runId)).size !== value.children.length) { this.invalid = true; return; }
    for (const child of value.children) {
      if (!this.validIdentity(child.identity)) { this.invalid = true; return; }
      const prior = this.admitted.get(child.identity.runId);
      if (prior && JSON.stringify(prior) !== JSON.stringify(child.identity)) { this.invalid = true; return; }
      this.admitted.set(child.identity.runId, child.identity);
    }
    this.progress++;
  }
  private validIdentity(identity: ChildIdentity): boolean {
    if (!identity || identity.ownerRunId !== this.runId || identity.ownerSessionId !== this.sessionId || typeof identity.runId !== "string" || !/^[a-f0-9-]{36}$/.test(identity.runId)) return false;
    const tasks = this.launches.get(identity.batchId);
    return !!tasks?.some((task) => {
      let cwd: string;
      try { cwd = realpathSync(task.cwd ?? identity.cwd); } catch { return false; }
      return task.agent === identity.agent && sha256(task.task) === identity.taskHash && cwd === identity.cwd && (task.ticket ?? (["plan-scout", "plan-writer"].includes(task.agent) ? identity.ticket : undefined)) === identity.ticket && JSON.stringify(task.review) === JSON.stringify(identity.review) && task.acceptedInputId === identity.acceptedInputId && task.writerRevisionOf === identity.writerRevisionOf;
    });
  }
  accept(value: unknown): boolean {
    const next = value as ChildStateSnapshot;
    if (!next || next.version !== 1 || next.ownerRunId !== this.runId || next.pid !== this.pid || next.starttime !== this.starttime || !Number.isSafeInteger(next.sequence) || next.sequence < 1 || !Array.isArray(next.children) || !Array.isArray(next.deliveries) || !Number.isSafeInteger(next.producerObligations ?? 0) || (next.producerObligations ?? 0) < 0 || !Number.isSafeInteger(next.batchDispatches ?? 0) || (next.batchDispatches ?? 0) < 0) { this.invalid = true; return false; }
    if (!this.sessionId) { this.provisional = next; return false; }
    if (next.ownerSessionId !== this.sessionId) { this.invalid = true; return false; }
    if (next.sequence <= (this.snapshot?.sequence ?? 0)) return false;
    for (const child of next.children) {
      if (!this.validIdentity(child.identity) || !["queued", "running"].includes(child.state)) { this.invalid = true; return false; }
      const known = this.admitted.get(child.identity.runId);
      if (!known && !this.inFlight.has(child.identity.batchId)) { this.invalid = true; return false; }
      if (this.snapshot?.deliveries.some((delivery) => delivery.runIds.includes(child.identity.runId))) { this.invalid = true; return false; }
      if (known && JSON.stringify(known) !== JSON.stringify(child.identity)) { this.invalid = true; return false; }
      this.admitted.set(child.identity.runId, child.identity);
    }
    if (new Set(next.children.map((child) => child.identity.runId)).size !== next.children.length || new Set(next.deliveries.map((delivery) => delivery.deliveryId)).size !== next.deliveries.length) { this.invalid = true; return false; }
    for (const delivery of next.deliveries) {
      if (!/^[a-f0-9]{64}$/.test(delivery.deliveryId) || !/^[a-f0-9]{64}$/.test(delivery.envelopeHash) || !Array.isArray(delivery.runIds) || !delivery.runIds.length || !delivery.runIds.every((id) => this.admitted.get(id)?.batchId === delivery.batchId) || !["pending", "enqueued", "observed", "delivery_failed", "delivery_unknown"].includes(delivery.state)) { this.invalid = true; return false; }
      const prior = this.snapshot?.deliveries.find((item) => item.deliveryId === delivery.deliveryId);
      if (!prior && delivery.state === "observed") { this.invalid = true; return false; }
      if (prior && (prior.envelopeHash !== delivery.envelopeHash || JSON.stringify(prior.runIds) !== JSON.stringify(delivery.runIds) || (prior.state === "observed" && delivery.state !== "observed"))) { this.invalid = true; return false; }
      if (prior && prior.state !== "observed" && delivery.state === "observed") this.progress++;
    }
    for (const child of this.snapshot?.children ?? []) {
      if (!next.children.some((item) => item.identity.runId === child.identity.runId) && !next.deliveries.some((item) => item.runIds.includes(child.identity.runId)) && !next.children.some((item) => item.identity.batchId === child.identity.batchId)) { this.invalid = true; return false; }
      const newer = next.children.find((item) => item.identity.runId === child.identity.runId);
      if (child.state === "running" && newer?.state === "queued") { this.invalid = true; return false; }
    }
    for (const prior of this.snapshot?.deliveries ?? []) if (!next.deliveries.some((item) => item.deliveryId === prior.deliveryId)) { this.invalid = true; return false; }
    this.snapshot = structuredClone(next);
    const pending = new Set(this.pendingIds());
    for (const id of this.deliveryErrors) if (!pending.has(id)) this.deliveryErrors.delete(id);
    return true;
  }
  pendingIds(): string[] { return this.snapshot?.deliveries.filter((delivery) => delivery.state !== "observed").map((delivery) => delivery.deliveryId) ?? []; }
  busyCount(): number { return !this.snapshot || this.invalid || !this.sessionId ? 1 : this.snapshot.children.length + this.inFlight.size + (this.snapshot.producerObligations ?? 0) + (this.snapshot.batchDispatches ?? 0) + this.pendingIds().length; }
  canFinish(outcome: "done" | "blocked", reason?: string): boolean {
    if (!this.snapshot || this.invalid || this.snapshot.children.length || this.inFlight.size || (this.snapshot.producerObligations ?? 0) || (this.snapshot.batchDispatches ?? 0) || this.retry || this.compaction || this.queue) return false;
    const pending = this.snapshot.deliveries.filter((delivery) => delivery.state !== "observed");
    if (!pending.length) return true;
    return outcome === "blocked" && pending.every((delivery) => ["delivery_failed", "delivery_unknown"].includes(delivery.state) && reason?.includes(delivery.deliveryId));
  }
  verificationCount(outcome: "done" | "blocked", reason?: string): number { return this.canFinish(outcome, reason) ? 0 : Math.max(1, this.busyCount()); }
  deliveryFailureReason(): string | undefined {
    if (!this.snapshot || this.invalid || this.snapshot.children.length || this.inFlight.size || (this.snapshot.producerObligations ?? 0) || (this.snapshot.batchDispatches ?? 0) || this.retry || this.compaction || this.queue) return;
    const pending = this.snapshot.deliveries.filter((delivery) => delivery.state !== "observed");
    if (!pending.length || !pending.every((delivery) => ["delivery_failed", "delivery_unknown"].includes(delivery.state))) return;
    const reason = `report delivery failure; unobserved IDs: ${pending.map((delivery) => delivery.deliveryId).join(", ")}`;
    return this.canFinish("blocked", reason) ? reason : undefined;
  }
  settled(): "wait" | "nudge" | "blocked" {
    if (this.busyCount() || this.retry || this.compaction || this.queue) return "wait";
    if (this.lastNudgeProgress === this.progress) return "blocked";
    this.lastNudgeProgress = this.progress;
    return "nudge";
  }
}

function emptyBatchResult(identity: ChildIdentity): ResultEnvelope {
  return resultEnvelope(identity, "", { processOutcome: "not_started", exitCode: null, signal: null }, "");
}
function resultWireCost(result: ResultEnvelope): number {
  const json = JSON.stringify(result);
  return Buffer.byteLength(json) + Buffer.byteLength(JSON.stringify(json));
}
function batchPayloadQuota(identities: readonly ChildIdentity[]): number {
  const first = identities[0]!;
  const envelope: BatchEnvelope = { version: 1, kind: "batch", ownerRunId: first.ownerRunId, ownerSessionId: first.ownerSessionId, batchId: first.batchId, results: identities.map(emptyBatchResult) };
  const delivery = deliveryFor(envelope);
  const message = { role: "custom", customType: "subagent-report", content: reportContent(envelope, delivery), display: true, timestamp: Date.now(), details: { version: 1, deliveryId: delivery.deliveryId, envelopeHash: delivery.envelopeHash, envelope } };
  const overhead = Buffer.byteLength(JSON.stringify({ type: "message_end", message }));
  const quota = Math.floor((RECORD_LIMIT - overhead - 4096 - identities.length * 4096) / identities.length);
  if (quota < 0) throw new Error("subagent batch identity exceeds JSONL transport budget");
  return identities.length >= 16 ? Math.min(quota, 8192) : quota;
}
export function boundBatchResult(result: ResultEnvelope, identities: readonly ChildIdentity[]): ResultEnvelope {
  const budget = resultWireCost(emptyBatchResult(result.identity)) + batchPayloadQuota(identities);
  if (resultWireCost(result) <= budget) return structuredClone(result);
  if (result.identity.agent === "plan-writer") {
    const limited: ResultEnvelope = {
      ...result,
      identity: copyIdentity(result.identity),
      payloadOutcome: "output_limit",
      payload: "",
      outputLimit: "batch_transport",
      reviewVerdict: null,
      planResult: undefined,
      ...(result.diagnostics ? { diagnostics: { ...copyDiagnostics(result.diagnostics)!, final: { ...result.diagnostics.final, previewBytes: 0, previewHash: sha256(""), truncated: true } } } : {}),
    };
    if (resultWireCost(limited) <= budget) return limited;
    throw new Error("immutable required writer result exceeds JSONL transport budget");
  }
  const characters = Array.from(result.payload);
  let low = 0;
  let high = characters.length;
  const limited = (end: number): ResultEnvelope => {
    const payload = end > 0 ? characters.slice(0, end).join("") + "\n[Output truncated: batch transport budget]" : "";
    return {
      ...result,
      identity: copyIdentity(result.identity),
      payload,
      ...(result.diagnostics ? { diagnostics: { ...copyDiagnostics(result.diagnostics)!, final: { ...result.diagnostics.final, previewBytes: Buffer.byteLength(payload), previewHash: sha256(payload), truncated: Buffer.byteLength(payload) !== result.diagnostics.final.bytes || sha256(payload) !== result.diagnostics.final.hash } } } : {}),
    };
  };
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (resultWireCost(limited(middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  const bounded = limited(low);
  if (resultWireCost(bounded) <= budget) return bounded;
  const empty = limited(0);
  if (resultWireCost(empty) <= budget) return empty;
  throw new Error("immutable subagent result exceeds JSONL transport budget");
}
