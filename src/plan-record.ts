import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { dataRoot } from "./data-root.ts";
import { openDb } from "./db.ts";
import { commitExact, gitMutationLockPath, pushWithRetryAsync, type ExactSyncResult } from "./git-sync.ts";
import { readRuntimeSettings } from "./guard-policy.ts";
import { logMoveDetailed } from "./move-log.ts";
import { ticketUrl } from "./ticket-url.ts";
import { applyMove, type MoveEnv } from "./transitions.ts";
import { assertPlanBinding, readCandidatePlanSnapshot, readRecordedPlanBinding, toPlanBinding, type PlanBinding } from "./plan-binding.ts";
import { assertPublishable } from "./plan-publication.ts";
import { markSideEffectsStarted, markSuccessfulRecord, planRecordById, publicationAcceptanceById, readPublicationArtifact } from "./plan-publication-state.ts";
import { appendIncidentEvent, incidentById, writerDraftFor } from "./workflow-incident-state.ts";
import { resolvePublicationTarget } from "./plan-publication-target.ts";
import { sha256 } from "./subagent-runs.ts";
import { assertMandatoryBoundary } from "./workflow-boundaries.ts";

export interface PlanRecordResult { ticket: string; plan: string; repeat: boolean; recorded: true; journal?: string; localSync: ExactSyncResult; push?: ExactSyncResult }
export interface RecordPlanOptions { expectedBinding: PlanBinding; recordId: number; signal?: AbortSignal; onLocked?(): void }

export function recordLockPath(root: string): string { return gitMutationLockPath(root); }

function verifyLocalRecord(root: string, ticket: string, expectedBinding: PlanBinding, recordId: number) {
  const candidate = readCandidatePlanSnapshot(root, ticket, expectedBinding.path);
  assertPlanBinding(expectedBinding, candidate);
  assertPublishable(candidate.bytes);
  const db = openDb(join(root, "yokemate.db"));
  try {
    const record = planRecordById(db, recordId);
    if (!record || record.ticket !== ticket || record.plan_path !== candidate.path || record.content_hash !== candidate.contentHash || record.scope_hash !== candidate.scopeHash || record.scout_acceptance === null) throw new Error("binding_changed");
    const snapshot = readPublicationArtifact(root, record);
    if (!snapshot.equals(candidate.bytes)) throw new Error("binding_changed");
    assertPublishable(snapshot);
    const scout = publicationAcceptanceById(db, record.scout_acceptance);
    if (!scout || scout.ticket !== ticket || record.source_kind !== scout.source_kind || record.incident_id !== scout.incident_id || record.candidate_id !== scout.candidate_id) throw new Error("artifact_invalid");
    assertPublishable(readPublicationArtifact(root, scout));
    let incident;
    if (scout.source_kind === "engineer-accepted-input") {
      if (!scout.incident_id || !scout.candidate_id || !record.writer_run_id || !record.writer_task_hash || !record.writer_actual_task_hash) throw new Error("artifact_invalid");
      incident = incidentById(db, scout.incident_id);
      const draft = writerDraftFor(db, candidate.contentHash);
      if (!incident || !draft || draft.accepted_input_id !== scout.id || draft.planning_identity !== scout.continuation_id || draft.writer_run_id !== record.writer_run_id || draft.writer_task_hash !== record.writer_task_hash || draft.writer_actual_task_hash !== record.writer_actual_task_hash || draft.plan_path !== candidate.path || draft.bytes !== candidate.bytes.length) throw new Error("binding_changed");
      const target = resolvePublicationTarget(db, ticket);
      const current = db.prepare("SELECT plan FROM work WHERE ticket=?").get(ticket) as { plan?: string | null } | undefined;
      const plan = current?.plan ? (() => { const binding = readRecordedPlanBinding(root, ticket); return { state: "recorded", hash: binding.contentHash, scopeHash: binding.scopeHash, pathHash: sha256(binding.path) }; })() : (() => { const scopeHash = sha256(JSON.stringify([ticket, target.targetHash, scout.content_hash, "plan-absent"])); return { state: "absent", hash: sha256("absent"), scopeHash, pathHash: sha256("absent") }; })();
      if (incident.target_hash !== target.targetHash || incident.scope_hash !== plan.scopeHash || incident.plan_state !== plan.state || incident.plan_hash !== plan.hash || incident.plan_scope_hash !== plan.scopeHash || incident.plan_path_hash !== plan.pathHash) throw new Error("binding_changed");
      const markers = ["BREAK-GLASS: engineer-accepted-input", `incident: ${scout.incident_id}`, `source-run: ${scout.source_run_id}`, `source-hash: ${scout.content_hash}`, `reason: ${scout.incident_reason}`, "skipped: failed-transport-envelope"];
      if (markers.some((marker) => !candidate.text.includes(marker))) throw new Error("binding_changed");
    }
    return { db, candidate, record, scout, incident };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function recordPlanCore(root: string, ticket: string, expectedBinding: PlanBinding, recordId: number, env: MoveEnv = process.env as MoveEnv): PlanRecordResult {
  const data = dataRoot(root);
  const { db, candidate, record, scout, incident } = verifyLocalRecord(root, ticket, expectedBinding, recordId);
  const plan = candidate.path;
  const dataRelative = relative(data, plan);
  if (dataRelative.startsWith("..") || isAbsolute(dataRelative)) { db.close(); throw new Error(`plan is outside the data root: ${plan}`); }
  const settings = readRuntimeSettings(root);
  let out;
  let sideEffects = false;
  try {
    out = applyMove(db, "plan", env, ticket, () => {
      if (incident) {
        assertMandatoryBoundary("workflow.audit", !!scout.continuation_id && !!record.writer_run_id, "recovered record audit lineage is incomplete");
        appendIncidentEvent(db, incident, { kind: "effect-start", code: "record-plan", continuationId: scout.continuation_id ?? undefined, writerId: record.writer_run_id ?? undefined, payloadHash: record.writer_actual_task_hash ?? undefined, planHash: candidate.contentHash, effect: "record-plan", outcome: "started" });
      }
      db.prepare(`INSERT INTO work (ticket, url, stage, plan) VALUES (?, ?, 'planned', ?) ON CONFLICT (ticket) DO UPDATE SET stage = 'planned', plan = excluded.plan, updated_at = datetime('now')`).run(ticket, ticketUrl(db, ticket), plan);
      markSuccessfulRecord(db, record.id);
      if (incident) appendIncidentEvent(db, incident, { kind: "outcome", code: "local-record", continuationId: scout.continuation_id ?? undefined, writerId: record.writer_run_id ?? undefined, payloadHash: record.writer_actual_task_hash ?? undefined, planHash: candidate.contentHash, effect: "record-plan", outcome: "planned" });
    }, { settings });
    if (out.ok) sideEffects = markSideEffectsStarted(db, record.id);
  } finally { db.close(); }
  if (!out.ok) throw new Error(out.refuse);
  const logged = sideEffects ? logMoveDetailed(data, ticket, "запланировано", `план ${basename(plan, ".md")}`) : null;
  const targets = [dataRelative, ...(logged ? [relative(data, logged.path)] : [])];
  const localSync = sideEffects ? commitExact(data, `${ticket} план`, targets) : { state: "unchanged" as const };
  assertMandatoryBoundary("workflow.truthful-outcome", existsSync(plan), "local plan record outcome cannot be verified");
  return { ticket, plan, repeat: !sideEffects, recorded: true, journal: logged?.path, localSync };
}

const LOCKED_MARKER = "YOKEMATE_RECORD_LOCKED\n";

function runRecorder(root: string, lock: string, payload: string, env: NodeJS.ProcessEnv, options: RecordPlanOptions): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("flock", ["--exclusive", "--no-fork", lock, process.execPath, "--experimental-strip-types", "--no-warnings", new URL(import.meta.url).pathname, "--locked", payload], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let locked = false;
    const abort = () => { if (!locked) child.kill("SIGTERM"); };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (!locked && stdout.startsWith(LOCKED_MARKER)) { locked = true; stdout = stdout.slice(LOCKED_MARKER.length); options.onLocked?.(); }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      options.signal?.removeEventListener("abort", abort);
      if (!locked && options.signal?.aborted) { reject(new Error("plan recorder cancelled before lock acquisition")); return; }
      if (code !== 0 || signal) { reject(new Error(stderr.trim() || `plan recorder exited ${signal ?? code}`)); return; }
      resolvePromise(stdout);
    });
  });
}

export async function recordPlan(root: string, ticket: string, planPath: string, env: NodeJS.ProcessEnv = process.env, options: RecordPlanOptions): Promise<PlanRecordResult> {
  if (resolve(planPath) !== resolve(options.expectedBinding.path) || options.expectedBinding.ticket !== ticket) throw new Error("binding_changed");
  const payload = Buffer.from(JSON.stringify({ root, ticket, expectedBinding: toPlanBinding(options.expectedBinding), recordId: options.recordId })).toString("base64");
  const lock = recordLockPath(dataRoot(root));
  mkdirSync(dirname(lock), { recursive: true });
  const output = await runRecorder(root, lock, payload, env, options);
  const recorded = JSON.parse(output) as PlanRecordResult;
  if (recorded.localSync.state === "committed") recorded.push = await pushWithRetryAsync(dataRoot(root));
  return recorded;
}

if (import.meta.filename === process.argv[1] && process.argv[2] === "--locked") {
  try {
    const payload = JSON.parse(Buffer.from(process.argv[3] ?? "", "base64").toString("utf8")) as { root: string; ticket: string; expectedBinding: PlanBinding; recordId: number };
    process.on("SIGTERM", () => {});
    process.stdout.write(LOCKED_MARKER);
    process.stdout.write(JSON.stringify(recordPlanCore(payload.root, payload.ticket, payload.expectedBinding, payload.recordId)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
