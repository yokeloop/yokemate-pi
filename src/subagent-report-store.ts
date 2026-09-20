import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { processStarttime } from "./coordinator-control.ts";
import { sha256 } from "./subagent-runs.ts";
import type { ReportArchiveDisplay } from "./subagent-report.ts";

export const REPORT_FILE_LIMIT = 1024 * 1024;
export const DIAGNOSTICS_FILE_LIMIT = 2 * 1024 * 1024;
export const REPORT_DIRECTORY_LIMIT = 20;
export const REPORT_TOTAL_LIMIT = 32 * 1024 * 1024;
export const REPORT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type ReportStoreCode = "storage_busy" | "storage_limit" | "artifact_conflict" | "artifact_invalid" | "ENOENT" | "EACCES" | "EPERM" | "ENOSPC" | "EIO" | "unknown";

export interface ReportStoreResult {
  ok: boolean;
  code?: ReportStoreCode;
  archive: ReportArchiveDisplay;
}

export interface StoredReport {
  report: Buffer;
  diagnostics: Record<string, unknown>;
  archive: ReportArchiveDisplay;
}

interface ArtifactInfo {
  id: string;
  directory: string;
  reportPath: string;
  diagnosticsPath: string;
  bytes: number;
  createdAt: number;
}

interface StoreOptions {
  now?: () => number;
  pid?: number;
  processStarttime?: (pid: number) => string | undefined;
}

function codeFor(error: unknown): ReportStoreCode {
  const code = (error as NodeJS.ErrnoException)?.code;
  return ["ENOENT", "EACCES", "EPERM", "ENOSPC", "EIO"].includes(code ?? "") ? code as ReportStoreCode : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type FactProjection = (value: unknown) => unknown;
const textFact = (pattern: RegExp): FactProjection => (value) => typeof value === "string" && pattern.test(value) ? value : undefined;
const identifierFact = textFact(/^[a-zA-Z0-9_.:/+-]{1,240}$/);
const hashFact = textFact(/^[a-f0-9]{64}$/);
const revisionFact = textFact(/^[a-f0-9]{40}$/);
const timeFact = textFact(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
const pathFact = textFact(/^[^\x00-\x1f\x7f]{1,4096}$/);
const countFact: FactProjection = (value) => Number.isSafeInteger(value) && (value as number) >= 0 ? value : undefined;
const booleanFact: FactProjection = (value) => typeof value === "boolean" ? value : undefined;
const exitFact: FactProjection = (value) => value === null || Number.isSafeInteger(value) ? value : undefined;
const enumFact = (...values: (string | null)[]): FactProjection => (value) => values.includes(value as string) ? value : undefined;
const contentFact: FactProjection = (value) => typeof value === "string" ? { bytes: Buffer.byteLength(value), hash: sha256(value) } : undefined;
const listFact = (project: FactProjection): FactProjection => (value) => Array.isArray(value) ? value.map(project).filter((entry) => entry !== undefined) : undefined;
const objectFact = (fields: Record<string, FactProjection>): FactProjection => (value) => {
  if (!isRecord(value)) return;
  const result: Record<string, unknown> = {};
  for (const [key, project] of Object.entries(fields)) {
    const fact = project(value[key]);
    if (fact !== undefined) result[key] = fact;
  }
  return result;
};
const bytesFact = objectFact({ bytes: countFact, hash: hashFact });
const errorFact = objectFact({ class: enumFact("ENOENT", "EACCES", "EPERM", "ENOSPC", "EIO", "EPIPE", "unknown"), bytes: countFact, hash: hashFact });
const resourceFact = objectFact({ path: pathFact, hash: hashFact });
const identityFact = objectFact({ ownerRunId: identifierFact, ownerSessionId: identifierFact, batchId: identifierFact, runId: identifierFact, runIds: listFact(identifierFact), agent: identifierFact, taskHash: hashFact, cwd: pathFact, ticket: identifierFact, review: objectFact({ baseSha: revisionFact, headSha: revisionFact }), acceptedInputId: countFact, writerRevisionOf: hashFact, parentRunId: identifierFact, parentSessionId: identifierFact, mode: enumFact("do", "ship"), role: enumFact("coordinator", "executor"), model: identifierFact });
const processOutcomeFact = enumFact("exited", "signaled", "spawn_error", "cancelled", "not_started");
const signalFact = enumFact(null, "SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGABRT", "SIGSEGV", "SIGPIPE", "SIGQUIT", "SIGBUS", "SIGILL", "SIGFPE");
const stopFact = enumFact("stop", "length", "toolUse", "error", "aborted", "unexpected_exit");
const verdictFact = enumFact(null, "approved", "changes_required");
const payloadOutcomeFact = enumFact("pending", "valid", "missing_final", "invalid_reviewer_json", "protocol_error", "output_limit", "incomplete");
const outputLimitFact = enumFact("batch_transport");
const terminalFact = objectFact({ processOutcome: processOutcomeFact, exitCode: exitFact, signal: signalFact, stopReason: stopFact });
const deliveryFact = objectFact({ deliveryId: hashFact, batchId: identifierFact, runIds: listFact(identifierFact), envelopeHash: hashFact, state: enumFact("pending", "enqueued", "observed", "delivery_failed", "delivery_unknown"), enqueuedAt: timeFact, observedAt: timeFact, failedAt: timeFact });
const parserErrorFact = objectFact({ kind: enumFact("invalid_json", "invalid_event", "record_limit", "partial_record"), offset: countFact });
const streamFact = objectFact({
  stdoutBytes: countFact, stdoutHash: hashFact, parserErrors: countFact, partialBytes: countFact, partialHash: hashFact,
  events: objectFact(Object.fromEntries(["session", "agent_start", "turn_start", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "turn_end", "agent_end", "agent_settled", "other"].map((key) => [key, countFact]))),
  parserErrorCounters: objectFact({ invalid_json: countFact, invalid_event: countFact, record_limit: countFact, partial_record: countFact }),
  firstParserError: parserErrorFact, lastParserError: parserErrorFact, assistantMessageSeen: booleanFact, finalTextPresent: booleanFact,
  activeTools: countFact, retry: booleanFact, compaction: booleanFact, summaryRetry: booleanFact, phase: enumFact("text", "thinking", "toolcall", "unknown"), firstByteAt: timeFact, lastEventAt: timeFact, finalAt: timeFact,
});
const modelFact = objectFact({ model: identifierFact, provider: identifierFact, thinking: enumFact("off", "minimal", "low", "medium", "high", "xhigh", "max", "unknown") });
const metadataFact = objectFact({
  identity: identityFact, admissionAt: timeFact, spawnAt: timeFact, closeAt: timeFact, settledAt: timeFact,
  ownerPid: countFact, ownerStarttime: textFact(/^\d{1,30}$/), pid: countFact, starttime: textFact(/^\d{1,30}$/), sessionId: identifierFact,
  runtime: objectFact({ node: textFact(/^v?\d+(?:\.\d+){2}$/), pi: textFact(/^\d+(?:\.\d+){2}$/), contract: countFact }),
  extension: resourceFact, guard: resourceFact, launch: resourceFact, agentDefinition: resourceFact,
  taskHash: hashFact, actualTaskHash: hashFact, appendedPromptHash: hashFact, requested: modelFact, effective: modelFact,
  cancellationInitiator: identifierFact, descendantCancellationInitiator: identifierFact, terminal: terminalFact, exitCode: exitFact, signal: signalFact,
  spawnError: errorFact, stream: streamFact, stderr: bytesFact,
  usage: objectFact({ input: countFact, output: countFact, cacheRead: countFact, cacheWrite: countFact, totalTokens: countFact, contextTokens: countFact, turns: countFact, cost: (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined }),
  payload: objectFact({ outcome: payloadOutcomeFact, bytes: countFact, hash: hashFact, retainedBytes: countFact, retainedHash: hashFact, truncated: booleanFact, verdict: verdictFact, outputLimit: outputLimitFact }),
  artifact: objectFact({ state: enumFact("verified", "accepted", "blocked", "superseded"), path: pathFact, hash: hashFact, bytes: countFact, acceptanceId: countFact, reason: identifierFact }),
  publication: objectFact({ state: enumFact("pending", "complete"), revision: hashFact, publicationId: countFact, error: identifierFact, path: pathFact, hash: hashFact, bytes: countFact, targetHash: hashFact, acceptanceId: countFact }),
  scoutCandidate: objectFact({ id: identifierFact, hash: hashFact, bytes: countFact, failureHash: hashFact, refusal: identifierFact, error: errorFact }),
  writerDraft: objectFact({ refusal: identifierFact, error: errorFact }),
  cleanupError: objectFact({ reason: contentFact, path: pathFact, cleanupFailure: errorFact }),
  deliveries: (value) => isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => hashFact(key) !== undefined).map(([key, entry]) => [key, deliveryFact(entry)])) : undefined,
  snapshotStorage: objectFact({ state: enumFact("available", "unavailable"), code: identifierFact }), noDeliveriesExpected: booleanFact,
  processDiagnostics: enumFact("unavailable"), state: enumFact("unavailable"), displayDiagnostic: enumFact("unknown_agent"), deliveryError: enumFact("send_message"),
});
const diagnosticFacts = objectFact({
  identity: identityFact, delivery: deliveryFact, stream: streamFact, stderr: bytesFact, process: metadataFact,
  children: listFact(objectFact({ identity: identityFact, actualTaskHash: hashFact, processOutcome: processOutcomeFact, exitCode: exitFact, signal: signalFact, stopReason: stopFact, payloadOutcome: payloadOutcomeFact, reviewVerdict: verdictFact, outputLimit: outputLimitFact, metadata: metadataFact })),
  terminal: objectFact({ outcome: enumFact("done", "blocked"), summary: contentFact, reason: contentFact, verification: objectFact({ ok: booleanFact, reason: contentFact, parts: listFact(identifierFact), merged: listFact(identifierFact), remaining: listFact(identifierFact), partFacts: listFact(objectFact({ repo: identifierFact, pr: identifierFact, head: revisionFact, state: enumFact("merged", "remaining", "unknown"), reason: contentFact })) }) }),
});

function ownId(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

export function coordinatorArtifactId(parentSessionId: string, runId: string): string {
  return sha256(JSON.stringify([parentSessionId, runId]));
}

export class SubagentReportStore {
  readonly root: string;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly starttime: (pid: number) => string | undefined;
  private initialized = false;

  constructor(root: string, options: StoreOptions = {}) {
    this.root = path.resolve(root);
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
    this.starttime = options.processStarttime ?? processStarttime;
  }

  writeReport(id: string, canonical: string | Buffer, facts: Record<string, unknown>): ReportStoreResult {
    const report = Buffer.isBuffer(canonical) ? Buffer.from(canonical) : Buffer.from(canonical, "utf8");
    if (!ownId(id)) return this.failure("artifact_invalid");
    if (report.length > REPORT_FILE_LIMIT) return this.failure("storage_limit");
    return this.locked(() => {
      this.pruneUnlocked();
      const target = path.join(this.root, id);
      if (fs.existsSync(target)) {
        const current = this.readUnlocked(id);
        if (!current) return this.failure("artifact_invalid");
        if (!current.report.equals(report)) return this.failure("artifact_conflict");
        return { ok: true, archive: current.archive };
      }
      const createdAt = this.now();
      const manifest = this.manifest(id, report, facts, createdAt, createdAt);
      const diagnostics = Buffer.from(JSON.stringify(manifest), "utf8");
      if (diagnostics.length > DIAGNOSTICS_FILE_LIMIT) return this.failure("storage_limit");
      const artifacts = this.inspectArtifacts();
      this.evictFor(artifacts, report.length + diagnostics.length, 1);
      const temporary = path.join(this.root, `.tmp-${id}-${randomUUID()}`);
      try {
        fs.mkdirSync(temporary, { mode: 0o700 });
        fs.writeFileSync(path.join(temporary, "report.txt"), report, { mode: 0o600, flag: "wx" });
        fs.writeFileSync(path.join(temporary, "diagnostics.json"), diagnostics, { mode: 0o600, flag: "wx" });
        fs.renameSync(temporary, target);
      } finally {
        this.removeOwnTemp(temporary);
      }
      return { ok: true, archive: this.archive(id, report) };
    });
  }

  updateDiagnostics(id: string, facts: Record<string, unknown>): ReportStoreResult {
    if (!ownId(id)) return this.failure("artifact_invalid");
    return this.locked(() => {
      this.pruneUnlocked();
      const current = this.readUnlocked(id);
      if (!current) return this.failure("ENOENT", "expired");
      const prior = current.diagnostics;
      const createdAt = typeof prior.createdAt === "string" ? Date.parse(prior.createdAt) : Number.NaN;
      if (!Number.isFinite(createdAt)) return this.failure("artifact_invalid");
      const manifest = this.manifest(id, current.report, facts, createdAt, this.now());
      const data = Buffer.from(JSON.stringify(manifest), "utf8");
      if (data.length > DIAGNOSTICS_FILE_LIMIT) return this.failure("storage_limit");
      const artifacts = this.inspectArtifacts();
      this.evictForUpdate(artifacts, id, data.length);
      const target = path.join(this.root, id, "diagnostics.json");
      const temporary = path.join(this.root, id, `.diagnostics-${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
        fs.renameSync(temporary, target);
      } finally {
        try { fs.unlinkSync(temporary); } catch {}
      }
      return { ok: true, archive: this.archive(id, current.report) };
    });
  }

  readReport(id: string): StoredReport | undefined {
    if (!ownId(id)) return;
    try {
      this.initialize();
      return this.readUnlocked(id);
    } catch {
      return;
    }
  }

  prune(): ReportStoreResult {
    return this.locked(() => {
      this.pruneUnlocked();
      return { ok: true, archive: { state: "unavailable", code: "unknown" } };
    });
  }

  private initialize(): void {
    if (this.initialized) return;
    const parsed = path.parse(this.root);
    let current = parsed.root;
    for (const part of this.root.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current) throw Object.assign(new Error("invalid root component"), { code: "artifact_invalid" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try { fs.mkdirSync(current, { mode: 0o700 }); }
        catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError; }
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current) throw Object.assign(new Error("invalid root component"), { code: "artifact_invalid" });
      }
    }
    fs.chmodSync(this.root, 0o700);
    this.initialized = true;
  }

  private locked(run: () => ReportStoreResult): ReportStoreResult {
    let lock: string | undefined;
    try {
      this.initialize();
      lock = path.join(this.root, ".lock");
      try {
        fs.writeFileSync(lock, JSON.stringify({ pid: this.pid, starttime: this.starttime(this.pid) }), { mode: 0o600, flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!this.clearStaleLock(lock)) return this.failure("storage_busy");
        fs.writeFileSync(lock, JSON.stringify({ pid: this.pid, starttime: this.starttime(this.pid) }), { mode: 0o600, flag: "wx" });
      }
      this.cleanTemps();
      return run();
    } catch (error) {
      const explicit = (error as { code?: string }).code;
      if (["artifact_invalid", "storage_limit"].includes(explicit ?? "")) return this.failure(explicit as ReportStoreCode);
      return this.failure(codeFor(error));
    } finally {
      if (lock) {
        try {
          const owner = JSON.parse(fs.readFileSync(lock, "utf8"));
          if (owner.pid === this.pid && owner.starttime === this.starttime(this.pid)) fs.unlinkSync(lock);
        } catch {}
      }
    }
  }

  private clearStaleLock(lock: string): boolean {
    try {
      const stat = fs.lstatSync(lock);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      const owner = JSON.parse(fs.readFileSync(lock, "utf8")) as { pid?: unknown; starttime?: unknown };
      if (!Number.isInteger(owner.pid) || typeof owner.starttime !== "string") return false;
      const actual = this.starttime(owner.pid as number);
      if (actual === owner.starttime) return false;
      if (actual === undefined && fs.existsSync(`/proc/${owner.pid}`)) return false;
      fs.unlinkSync(lock);
      return true;
    } catch {
      return false;
    }
  }

  private cleanTemps(): void {
    for (const name of fs.readdirSync(this.root)) {
      if (/^\.tmp-[a-f0-9]{64}-[a-f0-9-]{36}$/.test(name)) {
        this.removeOwnTemp(path.join(this.root, name));
        continue;
      }
      if (!ownId(name)) continue;
      const directory = path.join(this.root, name);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(directory); } catch { continue; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      for (const file of fs.readdirSync(directory)) {
        if (!/^\.diagnostics-[a-f0-9-]{36}\.tmp$/.test(file)) continue;
        const temporary = path.join(directory, file);
        try {
          const child = fs.lstatSync(temporary);
          if (child.isFile() && !child.isSymbolicLink()) fs.unlinkSync(temporary);
        } catch {}
      }
    }
  }

  private removeOwnTemp(directory: string): void {
    try {
      const name = path.basename(directory);
      if (!/^\.tmp-[a-f0-9]{64}-[a-f0-9-]{36}$/.test(name)) return;
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      for (const file of fs.readdirSync(directory)) {
        if (!["report.txt", "diagnostics.json"].includes(file)) return;
        const child = fs.lstatSync(path.join(directory, file));
        if (!child.isFile() || child.isSymbolicLink()) return;
      }
      fs.rmSync(directory, { recursive: true });
    } catch {}
  }

  private manifest(id: string, report: Buffer, facts: Record<string, unknown>, createdAt: number, updatedAt: number): Record<string, unknown> {
    return {
      customType: "yokemate-subagent-report",
      version: 1,
      artifactId: id,
      createdAt: new Date(createdAt).toISOString(),
      updatedAt: new Date(updatedAt).toISOString(),
      canonical: { bytes: report.length, hash: sha256(report) },
      retention: { days: 7, maxArtifacts: REPORT_DIRECTORY_LIMIT, maxBytes: REPORT_TOTAL_LIMIT },
      diagnostics: diagnosticFacts(facts),
    };
  }

  private inspectArtifacts(): ArtifactInfo[] {
    const artifacts: ArtifactInfo[] = [];
    for (const name of fs.readdirSync(this.root)) {
      if (name === ".lock" || /^\.tmp-[a-f0-9]{64}-[a-f0-9-]{36}$/.test(name)) continue;
      if (!ownId(name)) throw Object.assign(new Error("unknown artifact"), { code: "artifact_invalid" });
      const artifact = this.inspectArtifact(name);
      if (!artifact) throw Object.assign(new Error("invalid artifact"), { code: "artifact_invalid" });
      artifacts.push(artifact);
    }
    return artifacts;
  }

  private inspectArtifact(id: string): ArtifactInfo | undefined {
    const directory = path.join(this.root, id);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) return;
    const names = fs.readdirSync(directory);
    if (names.some((name) => !["report.txt", "diagnostics.json"].includes(name) && !/^\.diagnostics-[a-f0-9-]{36}\.tmp$/.test(name))) return;
    const reportPath = path.join(directory, "report.txt");
    const diagnosticsPath = path.join(directory, "diagnostics.json");
    for (const file of [reportPath, diagnosticsPath]) {
      const child = fs.lstatSync(file);
      if (!child.isFile() || child.isSymbolicLink()) return;
    }
    const diagnostics = JSON.parse(fs.readFileSync(diagnosticsPath, "utf8"));
    if (!isRecord(diagnostics) || diagnostics.customType !== "yokemate-subagent-report" || diagnostics.version !== 1 || diagnostics.artifactId !== id || !isRecord(diagnostics.canonical)) return;
    const createdAt = Date.parse(String(diagnostics.createdAt));
    if (!Number.isFinite(createdAt)) return;
    return { id, directory, reportPath, diagnosticsPath, bytes: fs.statSync(reportPath).size + fs.statSync(diagnosticsPath).size, createdAt };
  }

  private pruneUnlocked(): void {
    const artifacts = this.inspectArtifacts().sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const cutoff = this.now() - REPORT_RETENTION_MS;
    for (const artifact of artifacts.filter((entry) => entry.createdAt < cutoff)) this.removeArtifact(artifact);
    const retained = artifacts.filter((entry) => entry.createdAt >= cutoff);
    while (retained.length > REPORT_DIRECTORY_LIMIT || retained.reduce((sum, entry) => sum + entry.bytes, 0) > REPORT_TOTAL_LIMIT) this.removeArtifact(retained.shift()!);
  }

  private evictFor(artifacts: ArtifactInfo[], incomingBytes: number, incomingCount: number): void {
    const retained = artifacts.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    let total = retained.reduce((sum, artifact) => sum + artifact.bytes, 0);
    while (retained.length + incomingCount > REPORT_DIRECTORY_LIMIT || total + incomingBytes > REPORT_TOTAL_LIMIT) {
      const oldest = retained.shift();
      if (!oldest) throw Object.assign(new Error("storage limit"), { code: "storage_limit" });
      this.removeArtifact(oldest);
      total -= oldest.bytes;
    }
    if (incomingBytes > REPORT_TOTAL_LIMIT) throw Object.assign(new Error("storage limit"), { code: "storage_limit" });
  }

  private evictForUpdate(artifacts: ArtifactInfo[], updatingId: string, temporaryBytes: number): void {
    const retained = artifacts.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    let total = retained.reduce((sum, artifact) => sum + artifact.bytes, 0);
    while (total + temporaryBytes > REPORT_TOTAL_LIMIT) {
      const index = retained.findIndex((artifact) => artifact.id !== updatingId);
      if (index < 0) throw Object.assign(new Error("storage limit"), { code: "storage_limit" });
      const [oldest] = retained.splice(index, 1);
      this.removeArtifact(oldest!);
      total -= oldest!.bytes;
    }
  }

  private removeArtifact(artifact: ArtifactInfo): void {
    if (!ownId(artifact.id)) throw Object.assign(new Error("invalid artifact"), { code: "artifact_invalid" });
    const checked = this.inspectArtifact(artifact.id);
    if (!checked) throw Object.assign(new Error("invalid artifact"), { code: "artifact_invalid" });
    fs.rmSync(checked.directory, { recursive: true });
  }

  private readUnlocked(id: string): StoredReport | undefined {
    let artifact: ArtifactInfo;
    try {
      const inspected = this.inspectArtifact(id);
      if (!inspected) return;
      artifact = inspected;
    } catch {
      return;
    }
    const report = fs.readFileSync(artifact.reportPath);
    const diagnostics = JSON.parse(fs.readFileSync(artifact.diagnosticsPath, "utf8")) as Record<string, unknown>;
    const canonical = diagnostics.canonical as { bytes?: unknown; hash?: unknown };
    if (canonical.bytes !== report.length || canonical.hash !== sha256(report)) return;
    return { report, diagnostics, archive: this.archive(id, report) };
  }

  private archive(id: string, report: Buffer): ReportArchiveDisplay {
    return {
      state: "available",
      reportPath: path.join(this.root, id, "report.txt"),
      diagnosticsPath: path.join(this.root, id, "diagnostics.json"),
      reportBytes: report.length,
      reportHash: sha256(report),
      retentionDays: 7,
    };
  }

  private failure(code: ReportStoreCode, state: "unavailable" | "expired" = "unavailable"): ReportStoreResult {
    return { ok: false, code, archive: { state, code } };
  }
}
