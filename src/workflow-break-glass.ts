import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { acceptRecoveredScoutArtifact, readPublicationArtifact, type PublicationAcceptanceRow } from "./plan-publication-state.ts";
import { sha256 } from "./subagent-runs.ts";
import { consumeScoutIncident, safeIncidentReason, scoutCandidateById, type ScoutCandidateRow } from "./workflow-incident-state.ts";
import { assertMandatoryBoundary, assertRecoveryBoundary, RECOVERY_ACTION } from "./workflow-boundaries.ts";
import type { WorkflowIngressWitness } from "./workflow-ingress.ts";

export interface BreakGlassCommand {
  ticket: string;
  action: typeof RECOVERY_ACTION;
  candidateId: string;
  reason: string;
}

export function parseBreakGlass(raw: string): BreakGlassCommand {
  if (raw.includes("\n") || raw.includes("\r")) throw new Error("break-glass command must be one submitted line");
  const match = /^\/break-glass ([A-Z][A-Z0-9]*-\d+) (accept-plan-scout-input) --candidate ([a-f0-9-]{36}) --reason (.+)$/.exec(raw);
  if (!match) throw new Error("usage: /break-glass <KEY> accept-plan-scout-input --candidate <ID> --reason <reason>");
  const reason = safeIncidentReason(match[4]!);
  if (/(?:^|\s)--(?:force|candidate|reason|boundary)(?:\s|=|$)/.test(reason)) throw new Error("break-glass reason cannot contain command flags");
  assertRecoveryBoundary("plan.scout.transport-input", match[2]!);
  return { ticket: match[1]!, action: RECOVERY_ACTION, candidateId: match[3]!, reason };
}

export interface PlanSnapshotIdentity {
  state: "absent" | "recorded";
  hash: string;
  scopeHash: string;
  pathHash: string;
}

export interface BreakGlassPreview {
  permitId: string;
  ticket: string;
  action: typeof RECOVERY_ACTION;
  candidateId: string;
  candidateHash: string;
  candidateBytes: number;
  failureHash: string;
  sourceRunId: string;
  planningRunId: string;
  sourceSessionId: string;
  inputGeneration: number;
  inputHash: string;
  witnessId: string;
  scopeHash: string;
  targetHash: string;
  plan: PlanSnapshotIdentity;
  reason: string;
  bypassed: readonly ["plan.scout.transport-input"];
  preserved: readonly string[];
  blockers: readonly string[];
  createdAt: number;
  expiresAt: number;
}

interface StoredPermit extends BreakGlassPreview {
  sessionId: string;
  runtimeId: string;
  state: "preview" | "consumed" | "revoked";
}

export class BreakGlassPermitStore {
  private permits = new Map<string, StoredPermit>();
  private readonly ttlMs: number;
  private readonly clock: () => number;
  constructor(ttlMs = 300_000, clock = () => Date.now()) { this.ttlMs = ttlMs; this.clock = clock; }
  preview(input: Omit<BreakGlassPreview, "permitId" | "createdAt" | "expiresAt">, witness: WorkflowIngressWitness): BreakGlassPreview {
    this.revoke();
    if (witness.consumed || witness.generation !== input.inputGeneration || witness.hash !== input.inputHash) throw new Error("break-glass typed witness changed");
    const now = this.clock();
    const stored: StoredPermit = { ...input, permitId: randomUUID(), createdAt: now, expiresAt: now + this.ttlMs, sessionId: witness.sessionId, runtimeId: witness.runtimeId, state: "preview" };
    this.permits.set(stored.permitId, stored);
    return this.copy(stored);
  }
  assert(permitId: string, witness: WorkflowIngressWitness, expected: Omit<BreakGlassPreview, "permitId" | "createdAt" | "expiresAt">): BreakGlassPreview {
    const permit = this.permits.get(permitId);
    if (!permit || permit.state !== "preview") throw new Error("break-glass permit is not live");
    if (this.clock() > permit.expiresAt) throw new Error("break-glass permit expired");
    if (witness.consumed || witness.id !== permit.witnessId || witness.sessionId !== permit.sessionId || witness.runtimeId !== permit.runtimeId || witness.generation !== permit.inputGeneration || witness.hash !== permit.inputHash) throw new Error("break-glass typed witness changed");
    for (const key of ["ticket", "action", "candidateId", "candidateHash", "candidateBytes", "failureHash", "sourceRunId", "planningRunId", "sourceSessionId", "inputGeneration", "inputHash", "witnessId", "scopeHash", "targetHash", "plan", "reason", "bypassed", "preserved", "blockers"] as const) {
      if (JSON.stringify(permit[key]) !== JSON.stringify(expected[key])) throw new Error(`break-glass ${key} changed`);
    }
    return this.copy(permit);
  }
  consume(permitId: string): void {
    const permit = this.permits.get(permitId);
    if (!permit || permit.state !== "preview") throw new Error("break-glass permit is not live");
    permit.state = "consumed";
  }
  active(): BreakGlassPreview[] { return [...this.permits.values()].filter((permit) => permit.state === "preview").map((permit) => this.copy(permit)); }
  revoke(): BreakGlassPreview[] {
    const revoked: BreakGlassPreview[] = [];
    for (const permit of this.permits.values()) if (permit.state === "preview") { revoked.push(this.copy(permit)); permit.state = "revoked"; }
    return revoked;
  }
  private copy(permit: StoredPermit): BreakGlassPreview {
    const { sessionId: _sessionId, runtimeId: _runtimeId, state: _state, ...preview } = permit;
    return { ...preview, plan: { ...preview.plan }, bypassed: [...preview.bypassed] as ["plan.scout.transport-input"], preserved: [...preview.preserved], blockers: [...preview.blockers] };
  }
}

export interface PreviewScoutAcceptanceInput {
  db: DatabaseSync;
  root: string;
  command: BreakGlassCommand;
  witness: WorkflowIngressWitness;
  planningRunId: string;
  liveFailureHash: string;
  scopeHash: string;
  targetHash: string;
  plan: PlanSnapshotIdentity;
  store: BreakGlassPermitStore;
}

function exactCandidate(db: DatabaseSync, root: string, command: BreakGlassCommand, planningRunId: string, liveFailureHash: string): ScoutCandidateRow {
  const candidate = scoutCandidateById(db, command.candidateId);
  if (!candidate || candidate.ticket !== command.ticket || candidate.planning_identity !== planningRunId || candidate.failed_envelope_hash !== liveFailureHash) throw new Error("recovery candidate is stale or foreign");
  const bytes = readPublicationArtifact(root, candidate);
  if (sha256(bytes) !== candidate.content_hash || bytes.length !== candidate.bytes) throw new Error("recovery candidate artifact changed");
  const terminal = JSON.parse(candidate.terminal_json);
  const evidence = JSON.parse(candidate.evidence_json);
  if (terminal.processOutcome !== "exited" || terminal.exitCode !== 0 || terminal.signal !== null || terminal.stopReason !== "stop" || terminal.payloadOutcome !== "protocol_error" || evidence.lostSource || evidence.exhaustedEvidence || evidence.activeTools || evidence.retry || evidence.compaction || evidence.summaryRetry || !evidence.agentSettled || !evidence.queueKnown || !evidence.queueEmpty || !evidence.finalSequence || !evidence.settledSequence || evidence.settledSequence <= evidence.finalSequence) throw new Error("recovery candidate has immutable blockers");
  return candidate;
}

export function previewScoutAcceptance(input: PreviewScoutAcceptanceInput): BreakGlassPreview {
  const candidate = exactCandidate(input.db, input.root, input.command, input.planningRunId, input.liveFailureHash);
  if (!/^[a-f0-9]{64}$/.test(input.scopeHash) || !/^[a-f0-9]{64}$/.test(input.targetHash)) throw new Error("recovery target or scope is unknown");
  const preserved = ["workflow.assigned-scope", "workflow.target-identity", "workflow.required-data", "workflow.external-auth", "workflow.quality-gates", "workflow.explicit-ship", "workflow.do-authority", "workflow.truthful-outcome", "workflow.live-owner", "workflow.plan-binding", "workflow.terminal-lineage", "workflow.single-use", "workflow.audit", "plan.scout.complete-bytes", "plan.writer.admission", "plan-only"];
  return input.store.preview({ ticket: input.command.ticket, action: input.command.action, candidateId: candidate.id, candidateHash: candidate.content_hash, candidateBytes: candidate.bytes, failureHash: candidate.failed_envelope_hash, sourceRunId: candidate.run_id, planningRunId: candidate.planning_identity, sourceSessionId: candidate.owner_session_id, inputGeneration: input.witness.generation, inputHash: input.witness.hash, witnessId: input.witness.id, scopeHash: input.scopeHash, targetHash: input.targetHash, plan: { ...input.plan }, reason: input.command.reason, bypassed: ["plan.scout.transport-input"], preserved, blockers: [] }, input.witness);
}

export interface ResolveScoutAcceptanceInput {
  db: DatabaseSync;
  root: string;
  store: BreakGlassPermitStore;
  preview: BreakGlassPreview;
  witness: WorkflowIngressWitness;
  sourceUid: number;
  confirm(preview: BreakGlassPreview): Promise<boolean>;
  recheck(): Promise<Omit<BreakGlassPreview, "permitId" | "createdAt" | "expiresAt">>;
  continueLineage(): Promise<{ planningIdentity: string; generation: number }>;
}

export async function resolveScoutAcceptance(input: ResolveScoutAcceptanceInput): Promise<{ acceptance: PublicationAcceptanceRow; incidentId: string; planningIdentity: string; generation: number }> {
  const expected = await input.recheck();
  input.store.assert(input.preview.permitId, input.witness, expected);
  if (expected.blockers.length) throw new Error(`break-glass blocked: ${expected.blockers.join(", ")}`);
  const confirmed = await input.confirm(input.preview);
  input.store.assert(input.preview.permitId, input.witness, await input.recheck());
  if (!confirmed) throw new Error("break-glass confirmation declined");
  const current = await input.recheck();
  input.store.assert(input.preview.permitId, input.witness, current);
  const candidate = exactCandidate(input.db, input.root, { ticket: current.ticket, action: current.action, candidateId: current.candidateId, reason: current.reason }, current.planningRunId, current.failureHash);
  const expectedContinuation = { planningIdentity: `${candidate.planning_identity}:${candidate.generation + 1}`, generation: candidate.generation + 1 };
  assertMandatoryBoundary("workflow.single-use", input.store.active().some((permit) => permit.permitId === input.preview.permitId), "break-glass permit is no longer current");
  const consumed = consumeScoutIncident(input.db, {
    candidateId: candidate.id,
    ticket: current.ticket,
    planningIdentity: candidate.planning_identity,
    inputGeneration: current.inputGeneration,
    inputHash: current.inputHash,
    scopeHash: current.scopeHash,
    targetHash: current.targetHash,
    plan: current.plan,
    reason: current.reason,
    sourceUid: input.sourceUid,
    sourceSessionId: input.witness.sessionId,
    sourceRuntimeId: input.witness.runtimeId,
    payloadHash: candidate.content_hash,
    bypassed: current.bypassed,
    preserved: current.preserved,
  }, (incident, row) => acceptRecoveredScoutArtifact(input.db, input.root, incident, row, row.content_hash, ["failed-transport-envelope"], current.preserved, expectedContinuation.planningIdentity, expectedContinuation.generation));
  assertMandatoryBoundary("workflow.audit", !!consumed.incident.id && consumed.value.incident_id === consumed.incident.id, "durable recovery audit was not committed");
  input.store.consume(input.preview.permitId);
  const continuation = await input.continueLineage();
  if (continuation.planningIdentity !== expectedContinuation.planningIdentity || continuation.generation !== expectedContinuation.generation) throw new Error("recovery continuation identity changed");
  return { acceptance: consumed.value, incidentId: consumed.incident.id, planningIdentity: continuation.planningIdentity, generation: continuation.generation };
}
