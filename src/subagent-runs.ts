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
  review?: ReviewRevision;
}
export interface ChildTask { agent: string; task: string; cwd?: string; review?: ReviewRevision }
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
  reviewVerdict: "approved" | "changes_required" | null;
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
export function reserveIdentity(ownerRunId: string, ownerSessionId: string, batchId: string, task: ChildTask, defaultCwd: string): ChildIdentity {
  const cwd = realpathSync(task.cwd ?? defaultCwd);
  if (task.agent === "task-reviewer" && !task.review) throw new Error("task-reviewer requires review.baseSha and review.headSha");
  if (task.review) {
    for (const sha of [task.review.baseSha, task.review.headSha]) {
      if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("review revisions must be full commit SHA values");
      execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd, stdio: "pipe" });
    }
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    if (head !== task.review.headSha) throw new Error("review.headSha does not match HEAD in cwd");
  }
  return { ownerRunId, ownerSessionId, batchId, runId: randomUUID(), agent: task.agent, taskHash: sha256(task.task), cwd, ...(task.review ? { review: { ...task.review } } : {}) };
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
  constructor(ownerRunId: string, ownerSessionId: string) { this.ownerRunId = ownerRunId; this.ownerSessionId = ownerSessionId; }
  admit(batchId: string, tasks: ChildTask[], cwd: string): LaunchAck {
    if (this.batches.has(batchId)) throw new Error("duplicate subagent batch admission");
    const identities = tasks.map((task) => reserveIdentity(this.ownerRunId, this.ownerSessionId, batchId, task, cwd));
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
