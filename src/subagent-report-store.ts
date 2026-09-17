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

function sanitized(value: unknown, parent = ""): unknown {
  if (Array.isArray(value)) return value.map((entry) => sanitized(entry, parent));
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (["messages", "finaltext", "rawstderr", "parserbuffer", "thinking", "toolarguments", "rpcevents"].includes(lower)) continue;
    if (lower === "events" && parent !== "stream") continue;
    result[key] = sanitized(entry, key);
  }
  return result;
}

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
      diagnostics: sanitized(facts),
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
