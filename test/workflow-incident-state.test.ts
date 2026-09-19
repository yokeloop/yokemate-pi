import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { captureScoutCandidate } from "../src/plan-scout-recovery.ts";
import { acceptPlanRecord, acceptPublicationDelivery, acceptRecoveredPublication, acceptRecoveredScoutArtifact, acceptScoutArtifact, publicationAcceptanceById, writePublicationArtifact } from "../src/plan-publication-state.ts";
import { ChildRuns, JsonlObservation, resultEnvelope, sha256 } from "../src/subagent-runs.ts";
import { appendRecoveryAttempt, claimWriterDispatch, consumeScoutIncident, persistScoutCandidate, readIncidentEvents, recordWriterDraft, safeIncidentReason } from "../src/workflow-incident-state.ts";

function candidateFixture(root: string) {
  mkdirSync(join(root, ".pi"), { recursive: true });
  const task = "Scout exact input";
  const identity = new ChildRuns("owner", "parent-session", "YM-1").admit("batch", [{ agent: "plan-scout", task }], root).children[0]!.identity;
  const observed = new JsonlObservation();
  observed.write(Buffer.from("{transport failed}\n"));
  const sessionId = "11111111-1111-4111-8111-111111111111";
  observed.write(Buffer.from(JSON.stringify({ type: "session", id: sessionId }) + "\n"));
  const text = "# Exact scout\n\nEvidence.\n";
  observed.write(Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } }) + "\n"));
  observed.write(Buffer.from(JSON.stringify({ type: "agent_settled" }) + "\n"));
  observed.end();
  const envelope = resultEnvelope(identity, task, { processOutcome: "exited", exitCode: 0, signal: null, stopReason: "stop", protocolError: true }, observed.finalText);
  const result = captureScoutCandidate({ root, identity, envelope, finalText: observed.finalText, childSessionId: sessionId, evidence: observed.evidence(), planningIdentity: "plan-run:1", generation: 1, parentRuntimeId: "runtime", parentSessionId: "parent-session" });
  if (result.state !== "captured") throw new Error(`candidate refused: ${result.reason}`);
  return result.candidate;
}

const incidentInput = (candidateId: string, contentHash: string) => ({
  candidateId,
  ticket: "YM-1",
  planningIdentity: "plan-run:1",
  inputGeneration: 4,
  inputHash: sha256("typed raw input"),
  scopeHash: sha256("scope"),
  targetHash: sha256("target"),
  plan: { state: "absent" as const, hash: sha256("absent"), scopeHash: sha256("scope"), pathHash: sha256("absent") },
  reason: "The transport failed after a complete owned final.",
  sourceUid: process.getuid!(),
  sourceSessionId: "parent-session",
  sourceRuntimeId: "runtime",
  payloadHash: contentHash,
  bypassed: ["plan.scout.transport-input"],
  preserved: ["workflow.audit", "plan.writer.admission", "workflow.do-authority"],
});

test("candidate consumption, acceptance and audit commit atomically and survive reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "incident-state-"));
  try {
    const path = join(root, "yokemate.db");
    const candidate = candidateFixture(root);
    let db = openDb(path);
    const row = persistScoutCandidate(db, root, candidate);
    assert.throws(() => consumeScoutIncident(db, incidentInput(row.id, row.content_hash), () => { throw new Error("injected acceptance failure"); }), /injected/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM workflow_incident").get()?.n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM workflow_incident_event").get()?.n, 0);
    const consumed = consumeScoutIncident(db, incidentInput(row.id, row.content_hash), (incident, exact) => acceptRecoveredScoutArtifact(db, root, incident, exact, exact.content_hash, ["failed-envelope"], ["complete-bytes", "plan-only"]));
    assert.equal(consumed.value.source_kind, "engineer-accepted-input");
    assert.equal(consumed.value.incident_id, consumed.incident.id);
    assert.equal(consumed.value.candidate_id, row.id);
    assert.equal(consumed.value.failure_hash, row.failed_envelope_hash);
    const publication = acceptRecoveredPublication(db, root, { target: "github:org/repo#1", targetHash: sha256("github:org/repo#1"), ticket: "YM-1", kind: "scout", bytes: Buffer.from("# Exact scout\n\nEvidence.\n"), runId: row.run_id }, consumed.value.id);
    const linked = acceptPublicationDelivery(db, publication.id, candidate.child);
    assert.equal(linked.publication_id, publication.id);
    assert.equal(publication.source_kind, "engineer-accepted-input");
    assert.deepEqual(readIncidentEvents(db, consumed.incident.id).map((event) => event.kind), ["grant", "consume"]);
    assert.throws(() => consumeScoutIncident(db, incidentInput(row.id, row.content_hash), () => undefined), /UNIQUE/);
    const writer = claimWriterDispatch(db, consumed.incident, { acceptedInputId: String(consumed.value.id), planningIdentity: consumed.incident.planning_identity, kind: "initial", writerRunId: "writer-run", taskHash: sha256("writer task"), actualTaskHash: sha256("writer task") });
    assert.ok(writer);
    assert.throws(() => claimWriterDispatch(db, consumed.incident, { acceptedInputId: String(consumed.value.id), planningIdentity: consumed.incident.planning_identity, kind: "initial", writerRunId: "writer-two", taskHash: sha256("writer task two"), actualTaskHash: sha256("writer task two") }), /UNIQUE/);
    assert.throws(() => db.prepare("UPDATE workflow_incident_event SET code='changed'").run(), /append-only/);
    assert.throws(() => db.prepare("DELETE FROM workflow_incident_event").run(), /append-only/);
    db.close();
    db = openDb(path);
    const acceptance = publicationAcceptanceById(db, consumed.value.id)!;
    assert.equal(acceptance.source_kind, "engineer-accepted-input");
    assert.equal(acceptance.incident_id, consumed.incident.id);
    assert.equal(db.prepare("SELECT count(*) AS n FROM workflow_incident_event WHERE incident_id=?").get(consumed.incident.id)?.n, 3);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recovered plan records require immutable incident and correlated writer provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "incident-plan-record-"));
  try {
    const candidate = candidateFixture(root);
    const db = openDb(join(root, "yokemate.db"));
    const row = persistScoutCandidate(db, root, candidate);
    const consumed = consumeScoutIncident(db, incidentInput(row.id, row.content_hash), (incident, exact) => acceptRecoveredScoutArtifact(db, root, incident, exact, exact.content_hash, ["failed-transport-envelope"], ["plan-only"], "continuation", 2));
    const plan = Buffer.from("# Plan\n\n## Goal\nShip.\n\n## Acceptance\nPass.\n\n## Assumptions\n- recovery.\n");
    const planHash = sha256(plan);
    const planPath = "home/knowledge/org/repo/ai/YM-1-test/YM-1-test-plan.md";
    const artifactPath = writePublicationArtifact(root, "YM-1", "plan", planHash, plan);
    const base = { ticket: "YM-1", planPath, contentHash: planHash, scopeHash: sha256("scope"), artifactPath, bytes: plan.length, scoutAcceptance: consumed.value.id };
    assert.throws(() => acceptPlanRecord(db, base), /artifact_invalid/);
    const draft = recordWriterDraft(db, { content_hash: planHash, accepted_input_id: consumed.value.id, planning_identity: "continuation", writer_run_id: "writer-run", writer_task_hash: sha256("writer task"), writer_actual_task_hash: sha256("writer actual task"), plan_path: planPath, bytes: plan.length, result_hash: sha256(planPath) });
    const record = acceptPlanRecord(db, { ...base, writer: { runId: draft.writer_run_id, taskHash: draft.writer_task_hash, actualTaskHash: draft.writer_actual_task_hash } });
    assert.equal(record.source_kind, "engineer-accepted-input");
    assert.equal(record.incident_id, consumed.incident.id);
    assert.equal(record.writer_run_id, "writer-run");
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("refusal, revoke and expiry attempts are durable append-only audit facts", () => {
  const root = mkdtempSync(join(tmpdir(), "incident-attempt-"));
  try {
    const candidate = candidateFixture(root);
    const db = openDb(join(root, "yokemate.db"));
    const row = persistScoutCandidate(db, root, candidate);
    for (const outcome of ["refusal", "revoke", "expiry"] as const) appendRecoveryAttempt(db, { candidateId: row.id, ticket: row.ticket, action: "accept-plan-scout-input", inputGeneration: 1, inputHash: sha256("input"), scopeHash: sha256("scope"), targetHash: sha256("target"), sourceUid: process.getuid!(), sourceSessionId: "session", sourceRuntimeId: "runtime", payloadHash: row.content_hash, failureHash: row.failed_envelope_hash, reason: "Transport recovery decision.", outcome });
    assert.equal(db.prepare("SELECT count(*) AS n FROM workflow_recovery_attempt").get()?.n, 3);
    assert.throws(() => db.prepare("DELETE FROM workflow_recovery_attempt").run(), /append-only/);
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("audit storage rejects secrets, controls and raw error text", () => {
  for (const reason of ["", "token=private", "Authorization: Bearer private", "bad\u0000reason", "x".repeat(1001)]) assert.throws(() => safeIncidentReason(reason), /unsafe/);
  assert.equal(safeIncidentReason("Transport failed; use the exact complete final."), "Transport failed; use the exact complete final.");
});

test("normal acceptance cannot be rebound as recovery provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "incident-normal-"));
  try {
    const candidate = candidateFixture(root);
    const db = openDb(join(root, "yokemate.db"));
    const row = persistScoutCandidate(db, root, candidate);
    const identity = candidate.child;
    const normal = acceptScoutArtifact(db, root, identity, Buffer.from("# normal\n"));
    assert.equal(normal.source_kind, "normal-transport");
    assert.throws(() => consumeScoutIncident(db, incidentInput(row.id, row.content_hash), (incident, exact) => acceptRecoveredScoutArtifact(db, root, incident, exact, exact.content_hash, [], [])), /artifact_invalid/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM workflow_incident").get()?.n, 0);
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
