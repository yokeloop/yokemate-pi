import fs from "node:fs";
import path from "node:path";
import { keyHint, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { failedEnvelope, reviewerVerdict, sha256, type BatchEnvelope, type ReportEnvelope, type ResultEnvelope } from "./subagent-runs.ts";
import { formatElapsed, taskExcerpt } from "./subagent-widget.ts";

export interface ReportArchiveDisplay {
  state: "available" | "unavailable" | "expired";
  reportPath?: string;
  diagnosticsPath?: string;
  reportBytes?: number;
  reportHash?: string;
  retentionDays?: number;
  code?: string;
}

export interface ReportDisplayMemberV1 {
  taskExcerpt: string;
  durationMs?: number;
}

export interface SubagentReportDisplayV1 {
  version: 1;
  kind: "result" | "batch" | "chain" | "coordinator";
  durationMs?: number;
  ordinal?: number;
  taskExcerpt?: string;
  brief?: string;
  failureReason?: string;
  diagnosticCode?: string;
  members?: ReportDisplayMemberV1[];
  archive: ReportArchiveDisplay;
}

export interface ReportAdmissionDisplay {
  startedAt: number;
  taskExcerpt: string;
  ordinal?: number;
}

export interface ReportDiagnosticFacts {
  cancellationInitiator?: string;
  spawnError?: { class?: string };
  stream?: { parserErrors?: number; lastParserError?: { kind?: string; offset?: number } };
}

const DISPLAY_BASE_BUDGET = 2048;
const DISPLAY_MEMBER_BUDGET = 256;
const BRIEF_SCALARS = 160;
const BRIEF_BYTES = 512;

function normalizeDisplay(value: unknown): string {
  return String(value ?? "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, " ")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function boundedScalars(value: string, scalarLimit: number, byteLimit: number): string {
  const scalars = Array.from(normalizeDisplay(value));
  let result = "";
  for (const scalar of scalars.slice(0, scalarLimit)) {
    if (Buffer.byteLength(result + scalar) > byteLimit) break;
    result += scalar;
  }
  return result;
}

export function reportTaskExcerpt(value: string): string {
  return taskExcerpt(normalizeDisplay(value));
}

export function reportBrief(payload: string): string | undefined {
  const normalized = normalizeDisplay(payload);
  if (!normalized) return;
  try {
    const parsed = JSON.parse(payload) as { status?: unknown; findings?: unknown };
    if (reviewerVerdict(payload) && Array.isArray(parsed.findings)) {
      const blocking = parsed.findings.filter((finding) => finding && typeof finding === "object" && (finding as { severity?: unknown }).severity === "blocking").length;
      return `${parsed.findings.length} finding${parsed.findings.length === 1 ? "" : "s"}, ${blocking} blocking`;
    }
  } catch {}
  const first = payload.split(/\r\n|\r|\n|\u2028|\u2029/).map(normalizeDisplay).find(Boolean);
  return first ? boundedScalars(first, BRIEF_SCALARS, BRIEF_BYTES) : boundedScalars(normalized, BRIEF_SCALARS, BRIEF_BYTES);
}

export function reportFailureReason(result: ResultEnvelope, facts: ReportDiagnosticFacts = {}): string | undefined {
  if (!failedEnvelope(result)) return;
  if (result.processOutcome === "cancelled") return boundedScalars(`cancelled${facts.cancellationInitiator && facts.cancellationInitiator !== "unknown" ? ` by ${facts.cancellationInitiator}` : ""}`, 160, 512);
  if (result.processOutcome === "signaled") return boundedScalars(`signal ${result.signal ?? "unknown"}`, 160, 512);
  if (result.processOutcome === "spawn_error") return boundedScalars(`spawn ${facts.spawnError?.class ?? "error"}`, 160, 512);
  if (result.processOutcome === "not_started") return "not started";
  if (result.exitCode !== null && result.exitCode !== 0) return `exit ${result.exitCode}`;
  const parser = facts.stream?.lastParserError;
  if (parser?.kind) return boundedScalars(`parser ${parser.kind}${Number.isSafeInteger(parser.offset) ? ` at ${parser.offset}` : ""}${facts.stream?.parserErrors ? ` (${facts.stream.parserErrors})` : ""}`, 160, 512);
  if (result.payloadOutcome === "output_limit") return result.outputLimit ? `output limit: ${result.outputLimit}` : "output limit";
  if (result.payloadOutcome === "missing_final") return "missing final";
  if (result.payloadOutcome === "invalid_reviewer_json") return "invalid reviewer JSON";
  if (result.payloadOutcome === "protocol_error") return "protocol error";
  if (result.stopReason && result.stopReason !== "stop") return boundedScalars(`stop ${result.stopReason}`, 160, 512);
  return result.payloadOutcome === "incomplete" ? "incomplete" : undefined;
}

function fitMember(member: ReportDisplayMemberV1): ReportDisplayMemberV1 {
  const fitted = { ...member, taskExcerpt: reportTaskExcerpt(member.taskExcerpt) };
  if (Buffer.byteLength(JSON.stringify(fitted)) <= DISPLAY_MEMBER_BUDGET) return fitted;
  return { ...fitted, taskExcerpt: "" };
}

function fitDisplay(display: SubagentReportDisplayV1): SubagentReportDisplayV1 {
  const fitted: SubagentReportDisplayV1 = {
    ...display,
    taskExcerpt: display.taskExcerpt === undefined ? undefined : reportTaskExcerpt(display.taskExcerpt),
    brief: display.brief === undefined ? undefined : boundedScalars(display.brief, BRIEF_SCALARS, BRIEF_BYTES),
    failureReason: display.failureReason === undefined ? undefined : boundedScalars(display.failureReason, BRIEF_SCALARS, BRIEF_BYTES),
    members: display.members?.map(fitMember),
  };
  const baseBytes = () => Buffer.byteLength(JSON.stringify({ display: { ...fitted, members: [] } }));
  if (baseBytes() > DISPLAY_BASE_BUDGET) fitted.brief = undefined;
  if (baseBytes() > DISPLAY_BASE_BUDGET) fitted.failureReason = boundedScalars(fitted.failureReason ?? "", 64, 192) || undefined;
  if (baseBytes() > DISPLAY_BASE_BUDGET && fitted.archive.state === "available") fitted.archive = { state: "unavailable", code: "storage_limit" };
  if (baseBytes() > DISPLAY_BASE_BUDGET) {
    fitted.taskExcerpt = undefined;
    fitted.diagnosticCode = undefined;
  }
  return fitted;
}

export function buildCoordinatorDisplay(admission: ReportAdmissionDisplay | undefined, terminalAt: number, outcome: "done" | "blocked", summary: string, reason: string | undefined, archive: ReportArchiveDisplay): SubagentReportDisplayV1 {
  return fitDisplay({
    version: 1,
    kind: "coordinator",
    ...(admission ? { durationMs: Math.max(0, terminalAt - admission.startedAt), taskExcerpt: admission.taskExcerpt } : {}),
    ...(outcome === "blocked" ? { failureReason: reportBrief(reason ?? summary) } : { brief: reportBrief(summary) }),
    archive,
  });
}

export function buildReportDisplay(
  envelope: ReportEnvelope,
  admissions: ReadonlyMap<string, ReportAdmissionDisplay>,
  settlements: number | ReadonlyMap<string, number>,
  archive: ReportArchiveDisplay = { state: "unavailable", code: "unknown" },
  diagnostics: ReadonlyMap<string, ReportDiagnosticFacts> = new Map(),
  diagnosticCode?: string,
): SubagentReportDisplayV1 {
  const results = envelope.kind === "result" ? [envelope] : envelope.results;
  const settledAt = (runId: string): number | undefined => typeof settlements === "number" ? settlements : settlements.get(runId);
  const terminalTimes = results.map((result) => settledAt(result.identity.runId)).filter((value): value is number => value !== undefined);
  const terminalAt = terminalTimes.length ? Math.max(...terminalTimes) : undefined;
  const members = results.map((result) => {
    const admission = admissions.get(result.identity.runId);
    const terminal = settledAt(result.identity.runId);
    return { taskExcerpt: admission?.taskExcerpt ?? "", ...(admission && terminal !== undefined ? { durationMs: Math.max(0, terminal - admission.startedAt) } : {}) };
  });
  const firstFailure = results.find(failedEnvelope);
  const firstAdmission = admissions.get(results[0]?.identity.runId ?? "");
  const starts = results.map((result) => admissions.get(result.identity.runId)?.startedAt).filter((value): value is number => value !== undefined);
  return fitDisplay({
    version: 1,
    kind: envelope.kind,
    ...(starts.length && terminalAt !== undefined ? { durationMs: Math.max(0, terminalAt - Math.min(...starts)) } : {}),
    ...(envelope.kind === "result" && firstAdmission ? { taskExcerpt: firstAdmission.taskExcerpt, ordinal: firstAdmission.ordinal } : {}),
    ...(envelope.kind === "result" ? { brief: reportBrief(envelope.payload) } : {}),
    ...(firstFailure ? { failureReason: reportFailureReason(firstFailure, diagnostics.get(firstFailure.identity.runId)) } : {}),
    ...(diagnosticCode ? { diagnosticCode } : {}),
    ...(envelope.kind === "result" ? {} : { members }),
    archive,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isReportDisplay(value: unknown): value is SubagentReportDisplayV1 {
  if (!isRecord(value) || value.version !== 1 || !["result", "batch", "chain", "coordinator"].includes(String(value.kind)) || !isRecord(value.archive)) return false;
  if (!["available", "unavailable", "expired"].includes(String(value.archive.state))) return false;
  return value.members === undefined || (Array.isArray(value.members) && value.members.every((member) => isRecord(member) && typeof member.taskExcerpt === "string"));
}

function short(value: unknown): string {
  return boundedScalars(String(value ?? "—"), 12, 48).slice(0, 8) || "—";
}

function safeAgent(value: unknown): string {
  return boundedScalars(String(value ?? "subagent"), 32, 128) || "subagent";
}

function statusOf(result: ResultEnvelope): string {
  if (result.processOutcome === "not_started") return "not_started";
  return failedEnvelope(result) ? "failed" : result.reviewVerdict ?? "done";
}

function isResultEnvelope(value: unknown): value is ResultEnvelope {
  if (!isRecord(value) || value.version !== 1 || value.kind !== "result" || !isRecord(value.identity)) return false;
  if (typeof value.identity.agent !== "string" || typeof value.identity.runId !== "string") return false;
  if (!["exited", "signaled", "spawn_error", "cancelled", "not_started"].includes(String(value.processOutcome))) return false;
  if (value.exitCode !== null && typeof value.exitCode !== "number") return false;
  if (value.signal !== null && typeof value.signal !== "string") return false;
  if (!["pending", "valid", "missing_final", "invalid_reviewer_json", "protocol_error", "output_limit", "incomplete"].includes(String(value.payloadOutcome))) return false;
  return typeof value.payload === "string" && (value.reviewVerdict === null || value.reviewVerdict === "approved" || value.reviewVerdict === "changes_required");
}

function envelopeFrom(details: unknown): ReportEnvelope | undefined {
  if (!isRecord(details) || !isRecord(details.envelope)) return;
  const envelope = details.envelope;
  if (isResultEnvelope(envelope)) return envelope;
  if (envelope.version !== 1 || !["batch", "chain"].includes(String(envelope.kind)) || typeof envelope.batchId !== "string" || !Array.isArray(envelope.results)) return;
  if (!envelope.results.every(isResultEnvelope)) return;
  return envelope as unknown as ReportEnvelope;
}

function legacyLabel(content: string): string {
  const prefix = content.match(/^\[(subagent(?: batch complete| chain| [^\]]+)|coordinator [^\]]+)\]/)?.[1];
  return normalizeDisplay(prefix ?? "subagent report");
}

function archivePairIsValid(archive: ReportArchiveDisplay): boolean {
  try {
    if (!archive.reportPath || !archive.diagnosticsPath) return false;
    if (path.basename(archive.reportPath) !== "report.txt" || path.basename(archive.diagnosticsPath) !== "diagnostics.json" || path.dirname(archive.reportPath) !== path.dirname(archive.diagnosticsPath)) return false;
    for (const file of [archive.reportPath, archive.diagnosticsPath]) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== path.resolve(file)) return false;
    }
    const reportStat = fs.statSync(archive.reportPath);
    const diagnosticsStat = fs.statSync(archive.diagnosticsPath);
    if (reportStat.size > 1024 * 1024 || diagnosticsStat.size > 2 * 1024 * 1024) return false;
    const report = fs.readFileSync(archive.reportPath);
    const diagnostics = JSON.parse(fs.readFileSync(archive.diagnosticsPath, "utf8"));
    if (!isRecord(diagnostics) || diagnostics.customType !== "yokemate-subagent-report" || diagnostics.version !== 1 || !isRecord(diagnostics.canonical)) return false;
    const hash = sha256(report);
    if (diagnostics.canonical.bytes !== report.length || diagnostics.canonical.hash !== hash) return false;
    if (archive.reportBytes !== undefined && archive.reportBytes !== report.length) return false;
    return archive.reportHash === undefined || archive.reportHash === hash;
  } catch { return false; }
}

function archiveLines(archive: ReportArchiveDisplay | undefined): string[] {
  if (!archive) return ["diagnostics unavailable: unknown"];
  if (archive.state === "available" && !archivePairIsValid(archive)) return ["diagnostics expired/unavailable"];
  if (archive.state !== "available") return [`diagnostics ${archive.state === "expired" ? "expired/unavailable" : `unavailable: ${archive.code ?? "unknown"}`}`];
  return [
    `report.txt: ${archive.reportPath ?? "unavailable"}${archive.reportBytes === undefined ? "" : ` (${archive.reportBytes} bytes, ${archive.reportHash ?? "hash unavailable"})`}`,
    `diagnostics.json: ${archive.diagnosticsPath ?? "unavailable"}`,
    `retention: ${archive.retentionDays ?? 7} days`,
  ];
}

function messageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string").map((part) => String(part.text)).join("");
  return "";
}

function processLine(result: ResultEnvelope): string {
  return `process: ${result.processOutcome} · exit ${result.exitCode ?? "—"} · signal ${result.signal ?? "—"}`;
}

function payloadLine(result: ResultEnvelope): string {
  return `payload: ${result.payloadOutcome}${result.reviewVerdict ? ` · review: ${result.reviewVerdict}` : ""}`;
}

function addResultBody(container: Container, result: ResultEnvelope, padding: number, theme: Parameters<MessageRenderer>[2]): void {
  container.addChild(new Text(theme.fg("dim", processLine(result)), padding, 0));
  container.addChild(new Text(theme.fg("dim", payloadLine(result)), padding, 0));
  if (result.processOutcome !== "not_started" && result.payload) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(result.payload, padding, 0));
  }
}

function addChainBody(container: Container, envelope: BatchEnvelope, padding: number, theme: Parameters<MessageRenderer>[2]): void {
  for (const [index, result] of envelope.results.entries()) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", `step #${index + 1} · ${safeAgent(result.identity.agent)} · ${result.identity.runId} · ${statusOf(result)}`), padding, 0));
    addResultBody(container, result, padding, theme);
  }
}

function aggregateStatus(envelope: BatchEnvelope): string {
  const failed = envelope.results.filter(failedEnvelope).length;
  const skipped = envelope.results.filter((result) => result.processOutcome === "not_started").length;
  return failed ? `${envelope.results.length - failed}/${envelope.results.length} done${skipped ? `, ${skipped} skipped` : ""}` : `${envelope.results.length}/${envelope.results.length} done`;
}

function addBatchBody(container: Container, envelope: BatchEnvelope, display: SubagentReportDisplayV1 | undefined, padding: number, theme: Parameters<MessageRenderer>[2]): void {
  for (const [index, result] of envelope.results.entries()) {
    const member = display?.members?.[index];
    const duration = member?.durationMs === undefined ? "—" : formatElapsed(member.durationMs);
    const line = [
      `member #${index + 1}`,
      safeAgent(result.identity.agent),
      result.identity.runId,
      statusOf(result),
      duration,
      member?.taskExcerpt,
      reportBrief(result.payload),
    ].filter(Boolean).join(" · ");
    container.addChild(new Text(theme.fg("dim", line), padding, 0));
  }
}

function compactText(message: { content: unknown; details?: unknown }, display: SubagentReportDisplayV1 | undefined, envelope: ReportEnvelope | undefined): string {
  const duration = display?.durationMs === undefined ? "—" : formatElapsed(display.durationMs);
  const hint = keyHint("app.tools.expand", "to expand");
  if (envelope?.kind === "result") {
    const ordinal = display?.ordinal === undefined ? "#—" : `#${display.ordinal}`;
    const reason = display?.diagnosticCode === "unknown_agent" ? "unknown agent" : display?.failureReason;
    return [safeAgent(envelope.identity.agent), `result ${short(envelope.identity.runId)} ${ordinal}`, statusOf(envelope), duration, display?.taskExcerpt, reason ?? display?.brief, hint].filter(Boolean).join(" · ");
  }
  if (envelope) {
    const failed = envelope.results.filter(failedEnvelope).length;
    const skipped = envelope.results.filter((result) => result.processOutcome === "not_started").length;
    const status = failed ? `${envelope.results.length - failed}/${envelope.results.length} done${skipped ? `, ${skipped} skipped` : ""}` : `${envelope.results.length}/${envelope.results.length} done`;
    return [`subagent ${envelope.kind}`, `${short(envelope.batchId)} (${envelope.results.length})`, status, duration, display?.failureReason, hint].filter(Boolean).join(" · ");
  }
  if (display?.kind === "coordinator") {
    const details = isRecord(message.details) ? message.details : {};
    return [`coordinator ${safeAgent(details.mode)}`, short(details.runId), safeAgent(details.outcome), duration, display.taskExcerpt, display.failureReason ?? display.brief, hint].filter(Boolean).join(" · ");
  }
  return [legacyLabel(messageContent(message.content)), duration, display?.failureReason ?? display?.brief, hint].filter(Boolean).join(" · ");
}

export class SubagentReportLine {
  private readonly text: string;
  private readonly outputPad: number;
  constructor(text: string, outputPad: number) {
    this.text = text;
    this.outputPad = outputPad;
  }
  invalidate(): void {}
  render(width: number): string[] {
    if (width <= 0) return [""];
    const padding = Math.max(0, Math.min(this.outputPad, Math.floor((width - 1) / 2)));
    const available = Math.max(0, width - 2 * padding);
    const value = truncateToWidth(this.text, available, "…");
    return new Text(value, padding, 0).render(width);
  }
}

export const subagentReportRenderer: MessageRenderer = (message, options, theme) => {
  const details = isRecord(message.details) ? message.details : undefined;
  const display = isReportDisplay(details?.display) ? details.display : undefined;
  const envelope = envelopeFrom(details);
  const canonical = messageContent(message.content);
  if (!options.expanded) return new SubagentReportLine(compactText(message, display, envelope), options.outputPad);
  const padding = Math.max(0, options.outputPad);
  const container = new Container();
  const identity = envelope?.kind === "result"
    ? `${safeAgent(envelope.identity.agent)} ${envelope.identity.runId} ${statusOf(envelope)}`
    : envelope
      ? [`subagent ${envelope.kind} ${envelope.batchId} (${envelope.results.length})`, aggregateStatus(envelope), display?.durationMs === undefined ? "—" : formatElapsed(display.durationMs)].join(" · ")
      : display?.kind === "coordinator" && details
        ? `coordinator ${safeAgent(details.mode)} ${String(details.runId ?? "—")} ${safeAgent(details.outcome)}`
        : legacyLabel(canonical);
  container.addChild(new Text(theme.fg("muted", identity), padding, 0));
  for (const line of archiveLines(display?.archive)) container.addChild(new Text(theme.fg("dim", line), padding, 0));
  container.addChild(new Spacer(1));
  if (envelope?.kind === "result") addResultBody(container, envelope, padding, theme);
  else if (envelope?.kind === "chain") addChainBody(container, envelope, padding, theme);
  else if (envelope?.kind === "batch") addBatchBody(container, envelope, display, padding, theme);
  else container.addChild(new Text(canonical, padding, 0));
  return container;
};

export const reportDisplayBudgets = { base: DISPLAY_BASE_BUDGET, member: DISPLAY_MEMBER_BUDGET } as const;
