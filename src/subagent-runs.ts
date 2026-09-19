import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

export const PAYLOAD_LIMIT = 50 * 1024;
export const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export interface ReviewRevision { baseSha: string; headSha: string }
export interface ChildIdentity {
  ownerRunId: string;
  ownerSessionId: string;
  batchId: string;
  runId: string;
  agent: string;
  taskHash: string;
  cwd: string;
  ticket?: string;
  review?: ReviewRevision;
}
export interface ChildTask { agent: string; task: string; cwd?: string; ticket?: string; review?: ReviewRevision }
export interface PublicationReference { state: "pending" | "complete"; target: string; revision: string; publicationId?: number; error?: string; path?: string; hash?: string; bytes?: number; targetHash?: string; acceptanceId?: number }
export type ArtifactReference =
  | { state: "verified"; path: string; hash: string; bytes: number }
  | { state: "accepted"; path: string; hash: string; bytes: number; acceptanceId: number }
  | { state: "blocked"; reason: string; path?: string; hash?: string; bytes?: number }
  | { state: "superseded"; path: string; hash: string; bytes: number; acceptanceId: number };
export type ProcessOutcome = "exited" | "signaled" | "spawn_error" | "cancelled" | "not_started";
export type PayloadOutcome = "pending" | "valid" | "missing_final" | "invalid_reviewer_json" | "protocol_error" | "output_limit" | "incomplete";
export type ParserErrorKind = "invalid_json" | "invalid_event" | "record_limit" | "partial_record";
export interface ParserErrorFact { kind: ParserErrorKind; offset: number }
export interface StreamDiagnostics {
  stdoutBytes: number;
  stdoutHash: string;
  events: Record<string, number>;
  parserErrors: number;
  parserErrorCounters: Record<ParserErrorKind, number>;
  firstParserError?: ParserErrorFact;
  lastParserError?: ParserErrorFact;
  partialBytes: number;
  partialHash: string;
  assistantMessageSeen: boolean;
  finalTextPresent: boolean;
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
  stderr?: { bytes: number; hash: string };
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
  artifact?: ArtifactReference;
  publication?: PublicationReference;
  diagnostics?: ResultDiagnostics;
}
export interface BatchEnvelope {
  version: 1;
  kind: "batch" | "chain";
  ownerRunId: string;
  ownerSessionId: string;
  batchId: string;
  results: ResultEnvelope[];
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
  if (task.agent === "task-reviewer" && !task.review) throw new Error("task-reviewer requires review.baseSha and review.headSha");
  if (task.review) {
    for (const sha of [task.review.baseSha, task.review.headSha]) {
      if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("review revisions must be full commit SHA values");
      execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd, stdio: "pipe" });
    }
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    if (head !== task.review.headSha) throw new Error("review.headSha does not match HEAD in cwd");
  }
  return { ownerRunId, ownerSessionId, batchId, runId: randomUUID(), agent: task.agent, taskHash: sha256(task.task), cwd, ...(ticket ? { ticket } : {}), ...(task.review ? { review: { ...task.review } } : {}) };
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
export function resultEnvelope(identity: ChildIdentity, task: string, terminal: { processOutcome: ProcessOutcome; exitCode: number | null; signal: string | null; stopReason?: string; protocolError?: boolean; incomplete?: boolean; diagnostics?: ResultDiagnostics }, text: string): ResultEnvelope {
  const clean = terminal.processOutcome === "exited" && terminal.exitCode === 0 && terminal.signal === null && terminal.stopReason === "stop" && !terminal.incomplete;
  const reviewer = identity.agent === "task-reviewer";
  const verdict = reviewer ? reviewerVerdict(text) : null;
  const overflow = reviewer && Buffer.byteLength(text) > PAYLOAD_LIMIT;
  const payloadOutcome: PayloadOutcome = terminal.protocolError ? "protocol_error" : !clean ? "incomplete" : overflow ? "output_limit" : !text.trim() ? "missing_final" : reviewer && !verdict ? "invalid_reviewer_json" : "valid";
  const payload = overflow ? "" : boundedText(text);
  const supplied = copyDiagnostics(terminal.diagnostics);
  const diagnostics = supplied ? { ...supplied, final: { bytes: Buffer.byteLength(text), hash: sha256(text), previewBytes: Buffer.byteLength(payload), previewHash: sha256(payload), truncated: payload !== text } } : undefined;
  return { version: 1, kind: "result", identity: copyIdentity(identity), actualTaskHash: sha256(task), processOutcome: terminal.processOutcome, exitCode: terminal.exitCode, signal: terminal.signal, stopReason: terminal.stopReason, payloadOutcome, payload, reviewVerdict: payloadOutcome === "valid" ? verdict : null, ...(diagnostics ? { diagnostics } : {}) };
}
export function failedEnvelope(result: ResultEnvelope): boolean { return result.payloadOutcome !== "valid"; }
export class ChildRuns {
  readonly ownerRunId: string;
  readonly ownerSessionId: string;
  readonly children = new Map<string, { identity: ChildIdentity; state: "queued" | "running"; result?: ResultEnvelope }>();
  readonly batches = new Map<string, ChildIdentity[]>();
  private defaultTicket?: string;
  private currentScouts = new Map<string, { runId: string; result?: ResultEnvelope }>();
  constructor(ownerRunId: string, ownerSessionId: string, defaultTicket?: string) { this.ownerRunId = ownerRunId; this.ownerSessionId = ownerSessionId; this.defaultTicket = defaultTicket; }
  admit(batchId: string, tasks: ChildTask[], cwd: string): LaunchAck {
    if (this.batches.has(batchId)) throw new Error("duplicate subagent batch admission");
    const identities = tasks.map((task) => reserveIdentity(this.ownerRunId, this.ownerSessionId, batchId, task, cwd, this.defaultTicket));
    batchPayloadQuota(identities);
    const pendingScoutTickets = new Set(identities.filter((identity) => identity.agent === "plan-scout").map((identity) => identity.ticket).filter((ticket): ticket is string => !!ticket));
    for (const identity of identities) {
      if (identity.agent === "plan-writer") {
        if (identity.ticket && pendingScoutTickets.has(identity.ticket)) throw new Error(`plan-writer cannot share admission with an unsettled scout for ${identity.ticket}`);
        this.assertPlanWriterAdmission(identity);
      }
    }
    this.batches.set(batchId, identities);
    for (const identity of identities) {
      if (identity.agent === "plan-scout" && identity.ticket) this.currentScouts.set(identity.ticket, { runId: identity.runId });
      this.children.set(identity.runId, { identity, state: "queued" });
    }
    return { version: 1, kind: "ack", terminal: false, batchId, children: identities.map((identity) => ({ identity, state: "queued" })) };
  }
  start(identity: ChildIdentity): void {
    const child = this.children.get(identity.runId);
    if (child && !child.result && sha256(JSON.stringify(child.identity)) === sha256(JSON.stringify(identity))) child.state = "running";
  }
  settle(result: ResultEnvelope): boolean {
    const child = this.children.get(result.identity.runId);
    if (!child || child.result || sha256(JSON.stringify(child.identity)) !== sha256(JSON.stringify(result.identity))) return false;
    child.result = structuredClone(result);
    if (result.identity.agent === "plan-scout" && result.identity.ticket) {
      const current = this.currentScouts.get(result.identity.ticket);
      if (current?.runId === result.identity.runId && result.payloadOutcome === "valid" && result.actualTaskHash === result.identity.taskHash && result.artifact?.state === "accepted") current.result = structuredClone(result);
    }
    return true;
  }
  batch(batchId: string, kind: "batch" | "chain" = "batch"): BatchEnvelope | undefined {
    const identities = this.batches.get(batchId);
    if (!identities) return;
    const results = identities.map((identity) => this.children.get(identity.runId)?.result);
    if (results.some((result) => !result)) return;
    return { version: 1, kind, ownerRunId: this.ownerRunId, ownerSessionId: this.ownerSessionId, batchId, results: structuredClone(results as ResultEnvelope[]) };
  }
  active(): { identity: ChildIdentity; state: "queued" | "running" }[] { return [...this.children.values()].filter((child) => !child.result).map(({ identity, state }) => ({ identity, state })); }
  isCurrentScout(identity: ChildIdentity): boolean { return identity.agent === "plan-scout" && !!identity.ticket && this.currentScouts.get(identity.ticket)?.runId === identity.runId; }
  currentScout(ticket: string): ResultEnvelope | undefined { const result = this.currentScouts.get(ticket)?.result; return result ? structuredClone(result) : undefined; }
  assertPlanWriterAdmission(identity: ChildIdentity): ResultEnvelope {
    if (identity.agent !== "plan-writer" || !identity.ticket) throw new Error("plan-writer requires an explicit ticket binding");
    const result = this.currentScout(identity.ticket);
    if (!result || result.payloadOutcome !== "valid" || result.actualTaskHash !== result.identity.taskHash || result.artifact?.state !== "accepted") throw new Error(`plan-writer requires the current accepted scout for ${identity.ticket}`);
    return result;
  }
}

const RECORD_LIMIT = 1024 * 1024;
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
  private tools = new Set<string>();
  private retry = false;
  private compaction = false;
  private summaryRetry = false;
  private counts: Record<string, number> = {};
  private stdoutHash = createHash("sha256");
  private assistantSeen = false;
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
  private error(kind: ParserErrorKind): void {
    if (kind === "record_limit" && this.recordLimited) return;
    const fact = { kind, offset: this.offset };
    this.errors++;
    this.errorCounters[kind]++;
    this.firstError ??= fact;
    this.lastError = fact;
    if (kind === "record_limit") this.recordLimited = true;
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
    if (this.recordLimited) return;
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(line); }
    catch { this.error("invalid_json"); return; }
    this.parse(text);
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
  private parse(line: string): void {
    if (!line.trim()) return;
    let event: any;
    try { event = JSON.parse(line); } catch { this.error("invalid_json"); return; }
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string" || !this.validAgentEndSummary(event)) { this.error("invalid_event"); return; }
    const name = eventNames.has(event.type) ? event.type : "other";
    this.counts[name] = (this.counts[name] ?? 0) + 1;
    this.lastEventAt = new Date().toISOString();
    if (event.type === "session" && typeof event.id === "string" && /^[a-f0-9-]{36}$/.test(event.id)) this.sessionId = event.id;
    if (event.type === "message_update") {
      const phase = String(event.assistantMessageEvent?.type).split("_")[0];
      if (phase === "text" || phase === "thinking" || phase === "toolcall") this.phase = phase;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      this.assistantSeen = true;
      const message = event.message;
      this.finalText = Array.isArray(message.content) ? message.content.filter((block: any) => block?.type === "text" && typeof block.text === "string").map((block: any) => block.text).join("") : "";
      this.stopReason = ["stop", "length", "toolUse", "error", "aborted", "pending", "deferred"].includes(message.stopReason) ? message.stopReason : undefined;
      this.model = typeof message.model === "string" && /^[a-zA-Z0-9_.:/+-]{1,200}$/.test(message.model) ? message.model : undefined;
      this.provider = typeof message.provider === "string" && /^[a-zA-Z0-9_.:/+-]{1,200}$/.test(message.provider) ? message.provider : undefined;
      this.finalAt = this.lastEventAt;
    }
    if (event.type === "tool_execution_start" && typeof event.toolCallId === "string") this.tools.add(sha256(event.toolCallId));
    if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") this.tools.delete(sha256(event.toolCallId));
    if (event.type === "auto_retry_start") this.retry = true;
    if (event.type === "auto_retry_end") this.retry = false;
    if (event.type === "compaction_start") this.compaction = true;
    if (event.type === "compaction_end") this.compaction = false;
    if (event.type === "summarization_retry_scheduled" || event.type === "summarization_retry_attempt_start") this.summaryRetry = true;
    if (event.type === "summarization_retry_finished") this.summaryRetry = false;
    this.onEvent?.(event);
  }
  metadata(): StreamDiagnostics {
    return {
      stdoutBytes: this.stdoutBytes,
      stdoutHash: this.stdoutHash.copy().digest("hex"),
      events: { ...this.counts },
      parserErrors: this.errors,
      parserErrorCounters: { ...this.errorCounters },
      ...(this.firstError ? { firstParserError: { ...this.firstError } } : {}),
      ...(this.lastError ? { lastParserError: { ...this.lastError } } : {}),
      partialBytes: this.recordBytes,
      partialHash: this.recordHash.copy().digest("hex"),
      assistantMessageSeen: this.assistantSeen,
      finalTextPresent: Buffer.byteLength(this.finalText) > 0,
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
  process?: { pid?: number; starttime?: string; outcome?: string; exitCode?: number | null; signal?: string | null; stopReason?: string; cancellationInitiator?: string };
  resources?: Record<string, { path: string; hash: string }>;
  stream?: StreamDiagnostics;
  stderr?: { bytes: number; hash: string };
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
    return {
      customType: "yokemate-run-snapshot", version: 1, ownerRunId,
      ...(safeString(identity.ownerSessionId) ? { ownerSessionId: identity.ownerSessionId as string } : {}),
      ...(safeString(identity.batchId) ? { batchId: identity.batchId as string } : {}), runId,
      ...(safeString(identity.agent) ? { agent: identity.agent as string } : {}),
      ...(safeString(identity.ticket, /^[A-Z][A-Z0-9]*-\d+$/) ? { ticket: identity.ticket as string } : {}),
      ...(safeString(identity.taskHash, /^[a-f0-9]{64}$/) ? { taskHash: identity.taskHash as string } : {}),
      ...(safeString(metadata.actualTaskHash, /^[a-f0-9]{64}$/) ? { actualTaskHash: metadata.actualTaskHash as string } : {}),
      lifecycle: { admittedAt: safeString(metadata.admissionAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/), spawnAt: safeString(metadata.spawnAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/), closeAt: safeString(metadata.closeAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/), settledAt: safeString(metadata.settledAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/), processClosed, deliveriesTerminal },
      process: { pid: safeNumber(metadata.pid), starttime: safeString(metadata.starttime, /^\d{1,30}$/), outcome: safeString(terminal.processOutcome, /^[a-z_]{1,40}$/), exitCode: terminal.exitCode === null || Number.isInteger(terminal.exitCode) ? terminal.exitCode as number | null : undefined, signal: safeString(terminal.signal, /^[A-Z0-9]+$/), stopReason: safeString(terminal.stopReason, /^[a-zA-Z0-9_ -]{1,80}$/), cancellationInitiator: safeString(metadata.cancellationInitiator, /^[a-z_]{1,80}$/) },
      ...(Object.keys(resources).length ? { resources } : {}),
      ...(metadata.stream && typeof metadata.stream === "object" ? { stream: structuredClone(metadata.stream) as StreamDiagnostics } : {}),
      ...(metadata.stderr && typeof metadata.stderr === "object" ? { stderr: { bytes: safeNumber((metadata.stderr as any).bytes) ?? 0, hash: safeString((metadata.stderr as any).hash, /^[a-f0-9]{64}$/) ?? sha256("") } } : {}),
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
  recordDeliveryError(): void { for (const id of this.pendingIds()) this.deliveryErrors.add(id); }
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
      return task.agent === identity.agent && sha256(task.task) === identity.taskHash && cwd === identity.cwd && (task.ticket ?? (task.agent === "plan-scout" ? identity.ticket : undefined)) === identity.ticket && JSON.stringify(task.review) === JSON.stringify(identity.review);
    });
  }
  accept(value: unknown): boolean {
    const next = value as ChildStateSnapshot;
    if (!next || next.version !== 1 || next.ownerRunId !== this.runId || next.pid !== this.pid || next.starttime !== this.starttime || !Number.isSafeInteger(next.sequence) || next.sequence < 1 || !Array.isArray(next.children) || !Array.isArray(next.deliveries)) { this.invalid = true; return false; }
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
  busyCount(): number { return !this.snapshot || this.invalid || !this.sessionId ? 1 : this.snapshot.children.length + this.inFlight.size + this.pendingIds().length; }
  canFinish(outcome: "done" | "blocked", reason?: string): boolean {
    if (!this.snapshot || this.invalid || this.snapshot.children.length || this.inFlight.size) return false;
    if (!this.pendingIds().length) return true;
    return outcome === "blocked" && (this.deliveryError || this.snapshot.deliveries.some((delivery) => delivery.state === "delivery_failed")) && this.pendingIds().every((id) => reason?.includes(id));
  }
  verificationCount(outcome: "done" | "blocked", reason?: string): number { return this.canFinish(outcome, reason) ? 0 : Math.max(1, this.busyCount()); }
  deliveryFailureReason(): string | undefined {
    if (!this.deliveryError && !this.snapshot?.deliveries.some((delivery) => delivery.state === "delivery_failed")) return;
    const reason = `report delivery failure; unobserved IDs: ${this.pendingIds().join(", ")}`;
    return this.pendingIds().length && this.canFinish("blocked", reason) ? reason : undefined;
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
function batchPayloadQuota(identities: ChildIdentity[]): number {
  const first = identities[0]!;
  const envelope: BatchEnvelope = { version: 1, kind: "batch", ownerRunId: first.ownerRunId, ownerSessionId: first.ownerSessionId, batchId: first.batchId, results: identities.map(emptyBatchResult) };
  const delivery = deliveryFor(envelope);
  const message = { role: "custom", customType: "subagent-report", content: reportContent(envelope, delivery), display: true, timestamp: Date.now(), details: { version: 1, deliveryId: delivery.deliveryId, envelopeHash: delivery.envelopeHash, envelope } };
  const overhead = Buffer.byteLength(JSON.stringify({ type: "message_end", message }));
  const quota = Math.floor((RECORD_LIMIT - overhead - 4096 - identities.length * 4096) / identities.length);
  if (quota < 0) throw new Error("subagent batch identity exceeds JSONL transport budget");
  return identities.length >= 16 ? Math.min(quota, 8192) : quota;
}
export function boundBatchResult(result: ResultEnvelope, identities: ChildIdentity[]): ResultEnvelope {
  const budget = resultWireCost(emptyBatchResult(result.identity)) + batchPayloadQuota(identities);
  if (resultWireCost(result) <= budget) return structuredClone(result);
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
  return resultWireCost(bounded) <= budget ? bounded : limited(0);
}
