import { randomUUID } from "node:crypto";
import { assertPublishable } from "./plan-publication.ts";
import { writePublicationArtifact } from "./plan-publication-state.ts";
import { sha256, type ChildIdentity, type ResultEnvelope, type ScoutCompletenessEvidence } from "./subagent-runs.ts";
import { assertMandatoryBoundary } from "./workflow-boundaries.ts";

export type ScoutCandidateRefusal =
  | "foreign-child"
  | "task-mismatch"
  | "not-failed-transport"
  | "process-not-clean"
  | "terminal-not-stop"
  | "missing-session"
  | "missing-final"
  | "stale-final"
  | "lost-source"
  | "active-runtime-state"
  | "unsafe-document"
  | "blocked-data"
  | "blocked-auth"
  | "cancelled"
  | "late"
  | "unknown";

export interface ScoutCandidate {
  id: string;
  ticket: string;
  planningIdentity: string;
  generation: number;
  parentRuntimeId: string;
  parentSessionId: string;
  child: ChildIdentity;
  actualTaskHash: string;
  childSessionId: string;
  artifactPath: string;
  contentHash: string;
  bytes: number;
  failedEnvelopeHash: string;
  terminal: {
    processOutcome: ResultEnvelope["processOutcome"];
    exitCode: number | null;
    signal: string | null;
    stopReason?: string;
    payloadOutcome: ResultEnvelope["payloadOutcome"];
  };
  evidence: ScoutCompletenessEvidence;
}

export type ScoutCandidateResult =
  | { state: "captured"; candidate: ScoutCandidate }
  | { state: "refused"; reason: ScoutCandidateRefusal };

export interface CaptureScoutCandidateInput {
  root: string;
  identity: ChildIdentity;
  envelope: ResultEnvelope;
  finalText: string;
  childSessionId?: string;
  evidence: ScoutCompletenessEvidence;
  planningIdentity: string;
  generation: number;
  parentRuntimeId: string;
  parentSessionId: string;
  blockers?: readonly ("data" | "auth" | "cancelled" | "late" | "unknown")[];
}

const cloneIdentity = (identity: ChildIdentity): ChildIdentity => ({ ...identity, ...(identity.review ? { review: { ...identity.review } } : {}) });
const cloneEvidence = (evidence: ScoutCompletenessEvidence): ScoutCompletenessEvidence => ({ ...evidence, errors: evidence.errors.map((error) => ({ ...error })) });

export function evaluateScoutCompleteness(input: CaptureScoutCandidateInput): ScoutCandidateRefusal | null {
  const { identity, envelope, evidence } = input;
  if (identity.agent !== "plan-scout" || !identity.ticket || JSON.stringify(identity) !== JSON.stringify(envelope.identity)) return "foreign-child";
  if (envelope.actualTaskHash !== identity.taskHash) return "task-mismatch";
  if (envelope.payloadOutcome !== "protocol_error") return "not-failed-transport";
  if (envelope.processOutcome !== "exited" || envelope.exitCode !== 0 || envelope.signal !== null) return envelope.processOutcome === "cancelled" ? "cancelled" : "process-not-clean";
  if (envelope.stopReason !== "stop" || evidence.stopReason !== "stop") return "terminal-not-stop";
  if (!input.childSessionId || input.childSessionId !== evidence.sessionId) return "missing-session";
  const bytes = Buffer.from(input.finalText, "utf8");
  if (!input.finalText.trim() || bytes.length === 0 || evidence.finalBytes !== bytes.length || evidence.finalHash !== sha256(bytes)) return "missing-final";
  const finalSequence = evidence.finalSequence;
  if (!finalSequence || evidence.errors.some((error) => error.eventSequence >= finalSequence)) return "stale-final";
  if (evidence.recordLimit || evidence.partialRecord || evidence.invalidUtf8 || evidence.lostSource || evidence.exhaustedEvidence) return "lost-source";
  if (evidence.activeTools || evidence.retry || evidence.compaction || evidence.summaryRetry || !evidence.agentSettled || !evidence.settledSequence || evidence.settledSequence <= finalSequence || !evidence.queueKnown || !evidence.queueEmpty) return "active-runtime-state";
  if (!evidence.errors.length || evidence.errors.some((error) => !["invalid_json", "invalid_event"].includes(error.kind))) return "unknown";
  const blocker = input.blockers?.[0];
  if (blocker === "data") return "blocked-data";
  if (blocker === "auth") return "blocked-auth";
  if (blocker === "cancelled") return "cancelled";
  if (blocker === "late") return "late";
  if (blocker === "unknown") return "unknown";
  try { assertPublishable(bytes); }
  catch { return "unsafe-document"; }
  return null;
}

export function captureScoutCandidate(input: CaptureScoutCandidateInput): ScoutCandidateResult {
  const refusal = evaluateScoutCompleteness(input);
  if (refusal) return { state: "refused", reason: refusal };
  assertMandatoryBoundary("plan.scout.complete-bytes", input.evidence.agentSettled && input.evidence.queueKnown && input.evidence.queueEmpty, "scout completeness evidence is not terminal");
  const bytes = Buffer.from(input.finalText, "utf8");
  const contentHash = sha256(bytes);
  const artifactPath = writePublicationArtifact(input.root, input.identity.ticket!, "scout", contentHash, bytes);
  return {
    state: "captured",
    candidate: {
      id: randomUUID(),
      ticket: input.identity.ticket!,
      planningIdentity: input.planningIdentity,
      generation: input.generation,
      parentRuntimeId: input.parentRuntimeId,
      parentSessionId: input.parentSessionId,
      child: cloneIdentity(input.identity),
      actualTaskHash: input.envelope.actualTaskHash,
      childSessionId: input.childSessionId!,
      artifactPath,
      contentHash,
      bytes: bytes.length,
      failedEnvelopeHash: sha256(JSON.stringify(input.envelope)),
      terminal: {
        processOutcome: input.envelope.processOutcome,
        exitCode: input.envelope.exitCode,
        signal: input.envelope.signal,
        stopReason: input.envelope.stopReason,
        payloadOutcome: input.envelope.payloadOutcome,
      },
      evidence: cloneEvidence(input.evidence),
    },
  };
}
