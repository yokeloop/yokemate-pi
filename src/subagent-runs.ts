import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { JsonlAggregateValidator } from "./jsonl-aggregate.ts";
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
  if (task.agent === "plan-scout" && !ticket) throw new Error("plan-scout requires an explicit ticket binding");
  if (task.agent === "plan-scout" && task.ticket && defaultTicket && task.ticket !== defaultTicket) throw new Error("plan-scout ticket differs from the stamped plan ticket");
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
export function resultEnvelope(identity: ChildIdentity, task: string, terminal: { processOutcome: ProcessOutcome; exitCode: number | null; signal: string | null; stopReason?: string; protocolError?: boolean; incomplete?: boolean }, text: string): ResultEnvelope {
  const clean = terminal.processOutcome === "exited" && terminal.exitCode === 0 && terminal.signal === null && terminal.stopReason === "stop" && !terminal.incomplete;
  const reviewer = identity.agent === "task-reviewer";
  const verdict = reviewer ? reviewerVerdict(text) : null;
  const overflow = reviewer && Buffer.byteLength(text) > PAYLOAD_LIMIT;
  const payloadOutcome: PayloadOutcome = terminal.protocolError ? "protocol_error" : !clean ? "incomplete" : overflow ? "output_limit" : !text.trim() ? "missing_final" : reviewer && !verdict ? "invalid_reviewer_json" : "valid";
  return { version: 1, kind: "result", identity, actualTaskHash: sha256(task), processOutcome: terminal.processOutcome, exitCode: terminal.exitCode, signal: terminal.signal, stopReason: terminal.stopReason, payloadOutcome, payload: overflow ? "" : boundedText(text), reviewVerdict: payloadOutcome === "valid" ? verdict : null };
}
export function failedEnvelope(result: ResultEnvelope): boolean { return result.payloadOutcome !== "valid"; }
export class ChildRuns {
  readonly ownerRunId: string;
  readonly ownerSessionId: string;
  readonly children = new Map<string, { identity: ChildIdentity; state: "queued" | "running"; result?: ResultEnvelope }>();
  readonly batches = new Map<string, ChildIdentity[]>();
  private defaultTicket?: string;
  constructor(ownerRunId: string, ownerSessionId: string, defaultTicket?: string) { this.ownerRunId = ownerRunId; this.ownerSessionId = ownerSessionId; this.defaultTicket = defaultTicket; }
  admit(batchId: string, tasks: ChildTask[], cwd: string): LaunchAck {
    if (this.batches.has(batchId)) throw new Error("duplicate subagent batch admission");
    const identities = tasks.map((task) => reserveIdentity(this.ownerRunId, this.ownerSessionId, batchId, task, cwd, this.defaultTicket));
    batchPayloadQuota(identities);
    this.batches.set(batchId, identities);
    for (const identity of identities) this.children.set(identity.runId, { identity, state: "queued" });
    return { version: 1, kind: "ack", terminal: false, batchId, children: identities.map((identity) => ({ identity, state: "queued" })) };
  }
  start(identity: ChildIdentity): void {
    const child = this.children.get(identity.runId);
    if (child && !child.result && sha256(JSON.stringify(child.identity)) === sha256(JSON.stringify(identity))) child.state = "running";
  }
  settle(result: ResultEnvelope): boolean {
    const child = this.children.get(result.identity.runId);
    if (!child || child.result || sha256(JSON.stringify(child.identity)) !== sha256(JSON.stringify(result.identity))) return false;
    child.result = result;
    return true;
  }
  batch(batchId: string, kind: "batch" | "chain" = "batch"): BatchEnvelope | undefined {
    const identities = this.batches.get(batchId);
    if (!identities) return;
    const results = identities.map((identity) => this.children.get(identity.runId)?.result);
    if (results.some((result) => !result)) return;
    return { version: 1, kind, ownerRunId: this.ownerRunId, ownerSessionId: this.ownerSessionId, batchId, results: results as ResultEnvelope[] };
  }
  active(): { identity: ChildIdentity; state: "queued" | "running" }[] { return [...this.children.values()].filter((child) => !child.result).map(({ identity, state }) => ({ identity, state })); }
}

const RECORD_LIMIT = 1024 * 1024;
const eventNames = new Set(["session", "entry_appended", "agent_start", "agent_end", "agent_settled", "turn_start", "turn_end", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "auto_retry_start", "auto_retry_end", "compaction_start", "compaction_end", "summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished", "queue_update", "extension_error", "response", "extension_ui_request"]);
export class JsonlObservation {
  private prefix?: Buffer;
  private prefixLength = 0;
  private aggregate?: JsonlAggregateValidator;
  private recordBytes = 0;
  private recordHash = createHash("sha256");
  private dropping = false;
  private offset = 0;
  private errors = 0;
  private lastError?: { kind: "invalid_json" | "invalid_event" | "record_limit" | "partial_record"; offset: number };
  private tools = new Set<string>();
  private retry = false;
  private compaction = false;
  private summaryRetry = false;
  private counts: Record<string, number> = {};
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
  private error(kind: NonNullable<JsonlObservation["lastError"]>["kind"]): void { this.errors++; this.lastError = { kind, offset: this.offset }; }
  write(chunk: Buffer): void {
    this.firstByteAt ??= new Date().toISOString();
    this.stdoutBytes += chunk.length;
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const bytes = chunk.subarray(start, end);
      this.recordBytes += bytes.length;
      this.recordHash.update(bytes);
      this.consumeRecordBytes(bytes);
      if (newline < 0) break;
      if (this.aggregate) {
        if (this.aggregate.finish()) {
          this.counts.agent_end = (this.counts.agent_end ?? 0) + 1;
          this.lastEventAt = new Date().toISOString();
        } else if (!this.dropping) this.error("record_limit");
      } else if (!this.dropping) {
        const line = (this.prefix ?? Buffer.alloc(0)).subarray(0, this.prefixLength).toString("utf8");
        this.parse(line.endsWith("\r") ? line.slice(0, -1) : line);
      }
      this.offset += this.recordBytes + 1;
      this.resetRecord();
      start = newline + 1;
    }
  }
  end(): void {
    if (this.recordBytes) this.error("partial_record");
    this.prefix = undefined;
    this.prefixLength = 0;
    this.aggregate = undefined;
    this.dropping = false;
  }
  private consumeRecordBytes(bytes: Buffer): void {
    if (!bytes.length || this.dropping) return;
    if (this.aggregate) {
      this.aggregate.write(bytes);
      if (this.aggregate.rejected) { this.error("record_limit"); this.dropping = true; this.aggregate = undefined; }
      return;
    }
    this.prefix ??= Buffer.allocUnsafe(RECORD_LIMIT);
    const retained = Math.min(bytes.length, RECORD_LIMIT - this.prefixLength);
    if (retained > 0) {
      bytes.copy(this.prefix, this.prefixLength, 0, retained);
      this.prefixLength += retained;
    }
    if (retained === bytes.length) return;
    const validator = new JsonlAggregateValidator();
    validator.write(this.prefix.subarray(0, this.prefixLength));
    validator.write(bytes.subarray(retained));
    this.prefix = undefined;
    this.prefixLength = 0;
    if (validator.rejected) { this.error("record_limit"); this.dropping = true; }
    else this.aggregate = validator;
  }
  private resetRecord(): void {
    this.recordBytes = 0;
    this.recordHash = createHash("sha256");
    this.prefix = undefined;
    this.prefixLength = 0;
    this.aggregate = undefined;
    this.dropping = false;
  }
  private parse(line: string): void {
    if (!line.trim()) return;
    let event: any;
    try { event = JSON.parse(line); } catch { this.error("invalid_json"); return; }
    if (!event || typeof event !== "object" || typeof event.type !== "string") { this.error("invalid_event"); return; }
    const name = eventNames.has(event.type) ? event.type : "other";
    this.counts[name] = (this.counts[name] ?? 0) + 1;
    this.lastEventAt = new Date().toISOString();
    if (event.type === "session" && typeof event.id === "string" && /^[a-f0-9-]{36}$/.test(event.id)) this.sessionId = event.id;
    if (event.type === "message_update") {
      const phase = String(event.assistantMessageEvent?.type).split("_")[0];
      if (phase === "text" || phase === "thinking" || phase === "toolcall") this.phase = phase;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
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
  metadata() {
    return { stdoutBytes: this.stdoutBytes, events: { ...this.counts }, parserErrors: this.errors, lastParserError: this.lastError, partialBytes: this.recordBytes, partialHash: this.recordHash.copy().digest("hex"), activeTools: this.tools.size, retry: this.retry, compaction: this.compaction, summaryRetry: this.summaryRetry, phase: this.phase, firstByteAt: this.firstByteAt, lastEventAt: this.lastEventAt, finalAt: this.finalAt };
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
export class RunSnapshots {
  private directory: string;
  private stopped = false;
  constructor(root: string, plan: string) {
    let engine = root;
    while (!fs.existsSync(path.join(engine, "home/knowledge")) && path.dirname(engine) !== engine) engine = path.dirname(engine);
    const knowledge = fs.realpathSync(path.join(engine, "home/knowledge"));
    const folder = fs.realpathSync(path.dirname(plan));
    const relative = path.relative(knowledge, folder).split(path.sep);
    if (relative.length !== 4 || relative[2] !== "ai" || relative.some((part) => part === "..")) throw new Error("invalid reviewer diagnostic task path");
    this.directory = path.join(folder, "reviewer-runs");
    fs.mkdirSync(this.directory, { recursive: true });
    if (fs.realpathSync(this.directory) !== this.directory) throw new Error("reviewer diagnostic directory must not be a symlink");
  }
  write(ownerRunId: string, runId: string, metadata: Record<string, unknown>, completed: boolean): boolean {
    if (this.stopped) return false;
    let temporary: string | undefined;
    try {
      if (![ownerRunId, runId].every((id) => /^[a-zA-Z0-9-]{1,80}$/.test(id))) throw new Error("invalid diagnostic identity");
      const target = path.join(this.directory, `${ownerRunId}-${runId}.json`);
      const data = JSON.stringify({ customType: "yokemate-run-snapshot", version: 1, ownerRunId, runId, completed, updatedAt: new Date().toISOString(), ...metadata });
      if (Buffer.byteLength(data) > PAYLOAD_LIMIT) throw new Error("snapshot limit");
      const files = fs.readdirSync(this.directory).map((name) => {
        const file = path.join(this.directory, name);
        const stat = fs.lstatSync(file);
        let own = false;
        let terminal = false;
        if (stat.isFile() && /^[a-zA-Z0-9-]+\.json$/.test(name) && stat.size <= PAYLOAD_LIMIT) {
          try {
            const value = JSON.parse(fs.readFileSync(file, "utf8"));
            own = value.customType === "yokemate-run-snapshot" && value.version === 1 && name === `${value.ownerRunId}-${value.runId}.json`;
            terminal = own && value.completed === true;
          } catch {}
        }
        return { file, size: stat.size, updated: stat.mtimeMs, own, terminal };
      });
      const completedFiles = files.filter((file) => file.terminal && file.file !== target).sort((a, b) => a.updated - b.updated);
      let total = files.reduce((sum, file) => sum + (file.file === target ? 0 : file.size), 0) + Buffer.byteLength(data);
      while (completedFiles.length > (completed ? 19 : 20) || total > 2 * 1024 * 1024) {
        const oldest = completedFiles.shift();
        if (!oldest) throw new Error("diagnostic disk budget");
        fs.unlinkSync(oldest.file);
        total -= oldest.size;
      }
      temporary = `${target}.${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, target);
      return true;
    } catch {
      this.stopped = true;
      console.error("[subagent] diagnostic writes stopped; primary outcome unchanged");
      return false;
    } finally {
      if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
    }
  }
}

export type ReportEnvelope = ResultEnvelope | BatchEnvelope;
export interface ReportDelivery {
  deliveryId: string;
  batchId: string;
  runIds: string[];
  envelopeHash: string;
  state: "pending" | "enqueued" | "observed" | "delivery_failed" | "delivery_unknown";
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
  return { deliveryId: sha256(JSON.stringify([identity.ownerRunId, identity.ownerSessionId, identity.batchId, envelope.kind, runIds])), batchId: identity.batchId, runIds, envelopeHash: sha256(JSON.stringify(envelope)), state: "pending" };
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
  const quota = Math.floor((RECORD_LIMIT - overhead - 4096 - identities.length * 256) / identities.length);
  if (quota < 0) throw new Error("subagent batch identity exceeds JSONL transport budget");
  return quota;
}
export function boundBatchResult(result: ResultEnvelope, identities: ChildIdentity[]): ResultEnvelope {
  const budget = resultWireCost(emptyBatchResult(result.identity)) + batchPayloadQuota(identities);
  if (resultWireCost(result) <= budget) return result;
  if (result.identity.agent === "task-reviewer") return { ...result, payloadOutcome: "output_limit", payload: "", reviewVerdict: null, outputLimit: "batch_transport" };
  const characters = Array.from(result.payload);
  let low = 0;
  let high = characters.length;
  const limited = (end: number) => ({ ...result, payload: characters.slice(0, end).join("") + "\n[Output truncated: batch transport budget]" });
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (resultWireCost(limited(middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  return limited(low);
}
