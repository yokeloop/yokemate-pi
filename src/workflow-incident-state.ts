import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ScoutCandidate } from "./plan-scout-recovery.ts";
import { readPublicationArtifact } from "./plan-publication-state.ts";
import { errorMetadata, sha256 } from "./subagent-runs.ts";
import { assertMandatoryBoundary, assertRecoveryBoundary, RECOVERY_ACTION } from "./workflow-boundaries.ts";

export type WorkflowIncidentEventKind = "grant" | "refusal" | "revoke" | "expiry" | "consume" | "dispatch" | "effect-start" | "outcome";
export interface ScoutCandidateRow {
  id: string;
  ticket: string;
  planning_identity: string;
  generation: number;
  parent_runtime_id: string;
  parent_session_id: string;
  owner_run_id: string;
  owner_session_id: string;
  batch_id: string;
  run_id: string;
  task_hash: string;
  actual_task_hash: string;
  cwd: string;
  child_session_id: string;
  artifact_path: string;
  content_hash: string;
  bytes: number;
  failed_envelope_hash: string;
  terminal_json: string;
  evidence_json: string;
}
export interface WorkflowIncidentRow {
  id: string;
  candidate_id: string;
  ticket: string;
  action: string;
  planning_identity: string;
  input_generation: number;
  input_hash: string;
  scope_hash: string;
  target_hash: string;
  plan_state: "absent" | "recorded";
  plan_hash: string;
  plan_scope_hash: string;
  plan_path_hash: string;
  reason: string;
  source_uid: number;
  source_session_id: string;
  source_runtime_id: string;
}
export interface WorkflowIncidentEventRow {
  id: number;
  incident_id: string;
  kind: WorkflowIncidentEventKind;
  code: string;
  actor_uid: number;
  source_session_id: string;
  source_runtime_id: string;
  candidate_id: string;
  input_generation: number;
  input_hash: string;
  ticket: string;
  action: string;
  scope_hash: string;
  target_hash: string;
  continuation_id: string | null;
  writer_id: string | null;
  payload_hash: string | null;
  failure_hash: string | null;
  plan_hash: string | null;
  reason: string | null;
  bypassed_json: string | null;
  preserved_json: string | null;
  blockers_json: string | null;
  effect: string | null;
  outcome: string | null;
  error_json: string | null;
  created_at: string;
}

const HASH = /^[a-f0-9]{64}$/;
const CODE = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const ID = /^[a-zA-Z0-9._:-]{1,200}$/;

export function safeIncidentReason(reason: string): string {
  const value = reason.trim();
  if (!value || Buffer.byteLength(value) > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error("incident reason is unsafe");
  if (/\b(?:authorization|cookie|token|password|secret|api[_-]?key)\s*[:=]/i.test(value) || /-----BEGIN .*PRIVATE KEY-----/.test(value)) throw new Error("incident reason is unsafe");
  return value;
}

function safeCode(value: string, label: string): string {
  if (!CODE.test(value)) throw new Error(`invalid incident ${label}`);
  return value;
}
function safeId(value: string, label: string): string {
  if (!ID.test(value)) throw new Error(`invalid incident ${label}`);
  return value;
}
function safeHash(value: string, label: string): string {
  if (!HASH.test(value)) throw new Error(`invalid incident ${label}`);
  return value;
}
function safeCodes(values: readonly string[] | undefined, label: string): string | null {
  if (!values) return null;
  if (values.length > 32 || new Set(values).size !== values.length) throw new Error(`invalid incident ${label}`);
  for (const value of values) safeCode(value, label);
  return JSON.stringify(values);
}

export function persistScoutCandidate(db: DatabaseSync, root: string, candidate: ScoutCandidate): ScoutCandidateRow {
  if (!candidate.ticket || candidate.child.ticket !== candidate.ticket || candidate.child.agent !== "plan-scout" || candidate.actualTaskHash !== candidate.child.taskHash) throw new Error("invalid scout candidate identity");
  if (!HASH.test(candidate.contentHash) || !HASH.test(candidate.failedEnvelopeHash) || candidate.evidence.finalHash !== candidate.contentHash || candidate.evidence.finalBytes !== candidate.bytes) throw new Error("invalid scout candidate hashes");
  const artifact = readPublicationArtifact(root, { artifact_path: candidate.artifactPath, content_hash: candidate.contentHash, bytes: candidate.bytes });
  if (sha256(artifact) !== candidate.contentHash) throw new Error("invalid scout candidate artifact");
  db.prepare(`INSERT INTO plan_scout_candidate
    (id,ticket,planning_identity,generation,parent_runtime_id,parent_session_id,owner_run_id,owner_session_id,batch_id,run_id,task_hash,actual_task_hash,cwd,child_session_id,artifact_path,content_hash,bytes,failed_envelope_hash,terminal_json,evidence_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(owner_run_id,owner_session_id,batch_id,run_id,task_hash,failed_envelope_hash) DO NOTHING`).run(
    candidate.id, candidate.ticket, safeId(candidate.planningIdentity, "planning identity"), candidate.generation,
    safeId(candidate.parentRuntimeId, "runtime"), safeId(candidate.parentSessionId, "session"), candidate.child.ownerRunId,
    candidate.child.ownerSessionId, candidate.child.batchId, candidate.child.runId, candidate.child.taskHash,
    candidate.actualTaskHash, candidate.child.cwd, candidate.childSessionId, candidate.artifactPath, candidate.contentHash,
    candidate.bytes, candidate.failedEnvelopeHash, JSON.stringify(candidate.terminal), JSON.stringify(candidate.evidence),
  );
  const row = db.prepare(`SELECT * FROM plan_scout_candidate
    WHERE owner_run_id=? AND owner_session_id=? AND batch_id=? AND run_id=? AND task_hash=? AND failed_envelope_hash=?`).get(
    candidate.child.ownerRunId, candidate.child.ownerSessionId, candidate.child.batchId, candidate.child.runId,
    candidate.child.taskHash, candidate.failedEnvelopeHash,
  ) as unknown as ScoutCandidateRow | undefined;
  if (!row || row.artifact_path !== candidate.artifactPath || row.content_hash !== candidate.contentHash || row.bytes !== candidate.bytes) throw new Error("invalid scout candidate persistence");
  return row;
}

export function scoutCandidateById(db: DatabaseSync, id: string): ScoutCandidateRow | undefined {
  return db.prepare("SELECT * FROM plan_scout_candidate WHERE id=?").get(id) as unknown as ScoutCandidateRow | undefined;
}

export interface IncidentEventInput {
  kind: WorkflowIncidentEventKind;
  code: string;
  continuationId?: string;
  writerId?: string;
  payloadHash?: string;
  failureHash?: string;
  planHash?: string;
  reason?: string;
  bypassed?: readonly string[];
  preserved?: readonly string[];
  blockers?: readonly string[];
  effect?: string;
  outcome?: string;
  error?: unknown;
}

export function appendIncidentEvent(db: DatabaseSync, incident: WorkflowIncidentRow, input: IncidentEventInput): WorkflowIncidentEventRow {
  const code = safeCode(input.code, "event code");
  const reason = input.reason === undefined ? null : safeIncidentReason(input.reason);
  const hash = (value: string | undefined, label: string) => value === undefined ? null : safeHash(value, label);
  const continuation = input.continuationId === undefined ? null : safeId(input.continuationId, "continuation");
  const writer = input.writerId === undefined ? null : safeId(input.writerId, "writer");
  const effect = input.effect === undefined ? null : safeCode(input.effect, "effect");
  const outcome = input.outcome === undefined ? null : safeCode(input.outcome, "outcome");
  const error = input.error === undefined ? null : JSON.stringify(errorMetadata(input.error));
  const result = db.prepare(`INSERT INTO workflow_incident_event
    (incident_id,kind,code,actor_uid,source_session_id,source_runtime_id,candidate_id,input_generation,input_hash,ticket,action,scope_hash,target_hash,continuation_id,writer_id,payload_hash,failure_hash,plan_hash,reason,bypassed_json,preserved_json,blockers_json,effect,outcome,error_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    incident.id, input.kind, code, incident.source_uid, incident.source_session_id, incident.source_runtime_id,
    incident.candidate_id, incident.input_generation, incident.input_hash, incident.ticket, incident.action,
    incident.scope_hash, incident.target_hash, continuation, writer, hash(input.payloadHash, "payload hash"),
    hash(input.failureHash, "failure hash"), hash(input.planHash, "plan hash"), reason,
    safeCodes(input.bypassed, "bypassed"), safeCodes(input.preserved, "preserved"), safeCodes(input.blockers, "blockers"),
    effect, outcome, error,
  );
  return db.prepare("SELECT * FROM workflow_incident_event WHERE id=?").get(Number(result.lastInsertRowid)) as unknown as WorkflowIncidentEventRow;
}

export interface RecoveryDecisionInput {
  candidateId?: string;
  ticket: string;
  action: string;
  inputHash: string;
  sourceUid: number;
  sourceSessionId: string;
  sourceRuntimeId: string;
  code: string;
  blockers?: readonly string[];
  reason: string;
  outcome: "refusal" | "revoke" | "expiry";
}

export function appendRecoveryDecision(db: DatabaseSync, input: RecoveryDecisionInput): string {
  assertRecoveryBoundary("plan.scout.transport-input", input.action);
  safeHash(input.inputHash, "input hash");
  if (!Number.isSafeInteger(input.sourceUid) || input.sourceUid < 0) throw new Error("invalid recovery decision source");
  const id = randomUUID();
  db.prepare(`INSERT INTO workflow_recovery_decision
    (id,candidate_id,ticket,action,input_hash,source_uid,source_session_id,source_runtime_id,code,blockers_json,reason,outcome)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, input.candidateId ?? null, input.ticket, RECOVERY_ACTION, input.inputHash, input.sourceUid,
    safeId(input.sourceSessionId, "source session"), safeId(input.sourceRuntimeId, "source runtime"), safeCode(input.code, "decision code"),
    safeCodes(input.blockers, "blockers"), safeIncidentReason(input.reason), input.outcome,
  );
  return id;
}

export interface RecoveryAttemptInput {
  candidateId: string;
  ticket: string;
  action: string;
  inputGeneration: number;
  inputHash: string;
  scopeHash: string;
  targetHash: string;
  sourceUid: number;
  sourceSessionId: string;
  sourceRuntimeId: string;
  payloadHash: string;
  failureHash: string;
  reason: string;
  outcome: "refusal" | "revoke" | "expiry";
}

export function appendRecoveryAttempt(db: DatabaseSync, input: RecoveryAttemptInput): string {
  assertRecoveryBoundary("plan.scout.transport-input", input.action);
  for (const [value, label] of [[input.inputHash, "input hash"], [input.scopeHash, "scope hash"], [input.targetHash, "target hash"], [input.payloadHash, "payload hash"], [input.failureHash, "failure hash"]] as const) safeHash(value, label);
  if (!Number.isSafeInteger(input.inputGeneration) || input.inputGeneration < 1 || !Number.isSafeInteger(input.sourceUid) || input.sourceUid < 0) throw new Error("invalid recovery attempt source");
  const id = randomUUID();
  db.prepare(`INSERT INTO workflow_recovery_attempt
    (id,candidate_id,ticket,action,input_generation,input_hash,scope_hash,target_hash,source_uid,source_session_id,source_runtime_id,payload_hash,failure_hash,reason,outcome)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, input.candidateId, input.ticket, RECOVERY_ACTION, input.inputGeneration, input.inputHash, input.scopeHash, input.targetHash,
    input.sourceUid, safeId(input.sourceSessionId, "source session"), safeId(input.sourceRuntimeId, "source runtime"), input.payloadHash,
    input.failureHash, safeIncidentReason(input.reason), input.outcome,
  );
  return id;
}

export interface ConsumeScoutIncidentInput {
  candidateId: string;
  ticket: string;
  planningIdentity: string;
  inputGeneration: number;
  inputHash: string;
  scopeHash: string;
  targetHash: string;
  plan: { state: "absent" | "recorded"; hash: string; scopeHash: string; pathHash: string };
  reason: string;
  sourceUid: number;
  sourceSessionId: string;
  sourceRuntimeId: string;
  payloadHash: string;
  bypassed: readonly string[];
  preserved: readonly string[];
}

export function consumeScoutIncident<T>(db: DatabaseSync, input: ConsumeScoutIncidentInput, accept: (incident: WorkflowIncidentRow, candidate: ScoutCandidateRow) => T): { incident: WorkflowIncidentRow; value: T } {
  assertRecoveryBoundary("plan.scout.transport-input", RECOVERY_ACTION);
  const reason = safeIncidentReason(input.reason);
  for (const [value, label] of [[input.inputHash, "input hash"], [input.scopeHash, "scope hash"], [input.targetHash, "target hash"], [input.plan.hash, "plan hash"], [input.plan.scopeHash, "plan scope hash"], [input.plan.pathHash, "plan path hash"], [input.payloadHash, "payload hash"]] as const) safeHash(value, label);
  if (!Number.isSafeInteger(input.inputGeneration) || input.inputGeneration < 1 || !Number.isSafeInteger(input.sourceUid) || input.sourceUid < 0) throw new Error("invalid incident source");
  db.exec("BEGIN IMMEDIATE");
  try {
    const candidate = scoutCandidateById(db, input.candidateId);
    if (!candidate || candidate.ticket !== input.ticket || candidate.planning_identity !== input.planningIdentity) throw new Error("candidate identity changed");
    const priorClaim = db.prepare("SELECT incident_id FROM workflow_incident_claim WHERE candidate_id=? AND action=?").get(candidate.id, RECOVERY_ACTION);
    assertMandatoryBoundary("workflow.single-use", !priorClaim, "recovery candidate was already consumed");
    const id = randomUUID();
    db.prepare(`INSERT INTO workflow_incident
      (id,candidate_id,ticket,action,planning_identity,input_generation,input_hash,scope_hash,target_hash,plan_state,plan_hash,plan_scope_hash,plan_path_hash,reason,source_uid,source_session_id,source_runtime_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, candidate.id, input.ticket, RECOVERY_ACTION, safeId(input.planningIdentity, "planning identity"), input.inputGeneration,
      input.inputHash, input.scopeHash, input.targetHash, input.plan.state, input.plan.hash, input.plan.scopeHash, input.plan.pathHash, reason, input.sourceUid,
      safeId(input.sourceSessionId, "source session"), safeId(input.sourceRuntimeId, "source runtime"),
    );
    db.prepare("INSERT INTO workflow_incident_claim(candidate_id,action,incident_id) VALUES (?,?,?)").run(candidate.id, RECOVERY_ACTION, id);
    const incident = db.prepare("SELECT * FROM workflow_incident WHERE id=?").get(id) as unknown as WorkflowIncidentRow;
    appendIncidentEvent(db, incident, { kind: "grant", code: "engineer-confirmed", reason, failureHash: candidate.failed_envelope_hash, payloadHash: input.payloadHash, bypassed: input.bypassed, preserved: input.preserved });
    const value = accept(incident, candidate);
    appendIncidentEvent(db, incident, { kind: "consume", code: "accepted-input", reason, failureHash: candidate.failed_envelope_hash, payloadHash: input.payloadHash, bypassed: input.bypassed, preserved: input.preserved, effect: "plan-writer-admission", outcome: "consumed" });
    db.exec("COMMIT");
    return { incident, value };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export interface WriterDispatchInput {
  acceptedInputId: string;
  planningIdentity: string;
  kind: "initial" | "revision";
  revisionOf?: string;
  writerRunId: string;
  taskHash: string;
  actualTaskHash: string;
}

export function claimWriterDispatch(db: DatabaseSync, incident: WorkflowIncidentRow | undefined, input: WriterDispatchInput): string {
  const id = randomUUID();
  const revisionOf = input.revisionOf ?? "";
  if (input.kind === "revision" && !revisionOf || input.kind === "initial" && revisionOf) throw new Error("invalid writer dispatch revision");
  for (const [value, label] of [[input.acceptedInputId, "accepted input"], [input.planningIdentity, "planning identity"], [input.writerRunId, "writer run"]] as const) safeId(value, label);
  safeHash(input.taskHash, "writer task hash");
  safeHash(input.actualTaskHash, "writer actual task hash");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO workflow_writer_dispatch
      (id,accepted_input_id,planning_identity,dispatch_kind,revision_of,writer_run_id,task_hash,actual_task_hash)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, input.acceptedInputId, input.planningIdentity, input.kind, revisionOf, input.writerRunId, input.taskHash, input.actualTaskHash);
    if (incident) {
      const candidate = scoutCandidateById(db, incident.candidate_id);
      assertMandatoryBoundary("workflow.audit", !!candidate, "writer dispatch incident candidate is missing");
      appendIncidentEvent(db, incident, { kind: "dispatch", code: input.kind, continuationId: input.planningIdentity, writerId: input.writerRunId, payloadHash: input.actualTaskHash, failureHash: candidate!.failed_envelope_hash, effect: "plan-writer", outcome: "claimed" });
    }
    db.exec("COMMIT");
    return id;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export interface WriterDraftRow {
  content_hash: string;
  accepted_input_id: number;
  planning_identity: string;
  writer_run_id: string;
  writer_task_hash: string;
  writer_actual_task_hash: string;
  plan_path: string;
  bytes: number;
  result_hash: string;
}

export function recordWriterDraft(db: DatabaseSync, input: WriterDraftRow): WriterDraftRow {
  for (const [value, label] of [[input.content_hash, "draft hash"], [input.writer_task_hash, "writer task hash"], [input.writer_actual_task_hash, "writer actual task hash"], [input.result_hash, "writer result hash"]] as const) safeHash(value, label);
  if (!Number.isSafeInteger(input.accepted_input_id) || input.accepted_input_id < 1 || !Number.isSafeInteger(input.bytes) || input.bytes < 1) throw new Error("invalid writer draft size or input");
  safeId(input.planning_identity, "planning identity");
  safeId(input.writer_run_id, "writer run");
  db.prepare(`INSERT INTO workflow_writer_draft
    (content_hash,accepted_input_id,planning_identity,writer_run_id,writer_task_hash,writer_actual_task_hash,plan_path,bytes,result_hash)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(content_hash) DO NOTHING`).run(
    input.content_hash, input.accepted_input_id, input.planning_identity, input.writer_run_id, input.writer_task_hash,
    input.writer_actual_task_hash, input.plan_path, input.bytes, input.result_hash,
  );
  const row = writerDraftFor(db, input.content_hash);
  if (!row || JSON.stringify(row) !== JSON.stringify(input)) throw new Error("writer draft identity changed");
  return row;
}

export function writerDraftFor(db: DatabaseSync, contentHash: string): WriterDraftRow | undefined {
  return db.prepare(`SELECT content_hash,accepted_input_id,planning_identity,writer_run_id,writer_task_hash,writer_actual_task_hash,plan_path,bytes,result_hash
    FROM workflow_writer_draft WHERE content_hash=?`).get(contentHash) as unknown as WriterDraftRow | undefined;
}

export function incidentById(db: DatabaseSync, id: string): WorkflowIncidentRow | undefined {
  return db.prepare("SELECT * FROM workflow_incident WHERE id=?").get(id) as unknown as WorkflowIncidentRow | undefined;
}

export function readIncidentEvents(db: DatabaseSync, incidentId: string): WorkflowIncidentEventRow[] {
  return db.prepare("SELECT * FROM workflow_incident_event WHERE incident_id=? ORDER BY id").all(incidentId) as unknown as WorkflowIncidentEventRow[];
}

export function recordIncidentOutcome(db: DatabaseSync, incidentId: string, input: Omit<IncidentEventInput, "kind">): WorkflowIncidentEventRow {
  const incident = incidentById(db, incidentId);
  if (!incident) throw new Error("unknown workflow incident");
  return appendIncidentEvent(db, incident, { ...input, kind: "outcome" });
}
