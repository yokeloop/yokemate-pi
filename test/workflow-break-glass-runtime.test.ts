import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { openDb } from "../src/db.ts";
import { captureScoutCandidate } from "../src/plan-scout-recovery.ts";
import { acceptPlanRecord, acceptPublication, acceptRecoveredPublication, acceptScoutArtifact, markSuccessfulRecord, writePublicationArtifact } from "../src/plan-publication-state.ts";
import { ChildRuns, JsonlObservation, resultEnvelope, sha256 } from "../src/subagent-runs.ts";
import { BreakGlassPermitStore, parseBreakGlass, previewScoutAcceptance, resolveScoutAcceptance } from "../src/workflow-break-glass.ts";
import { claimWriterDispatch, persistScoutCandidate, recordWriterDraft } from "../src/workflow-incident-state.ts";
import { installWorkflowIngress, WorkflowIngressWitnessStore } from "../src/workflow-ingress.ts";

class RuntimeEditor implements EditorComponent {
  text = "";
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  getText() { return this.text; }
  getExpandedText() { return this.text; }
  setText(text: string) { this.text = text; }
  handleInput(data: string) { if (data === "ENTER") { const value = this.text; this.text = ""; this.onSubmit?.(value); } }
  render() { return [this.text]; }
  invalidate() {}
}

function failedScout(root: string) {
  mkdirSync(join(root, ".pi"), { recursive: true });
  const task = "Return complete scout evidence";
  const identity = new ChildRuns("owner", "main-session", "YM-1").admit("batch", [{ agent: "plan-scout", task }], root).children[0]!.identity;
  const observation = new JsonlObservation();
  const sessionId = "11111111-1111-4111-8111-111111111111";
  observation.write(Buffer.from("{transport failed}\n"));
  observation.write(Buffer.from(JSON.stringify({ type: "session", id: sessionId }) + "\n"));
  const text = "# Scout\n\n## Facts and sources\n- exact.\n\n## Assumptions\n- one.\n\n## Forks and recommendations\n- proceed.\n";
  observation.write(Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } }) + "\n"));
  observation.write(Buffer.from(JSON.stringify({ type: "agent_settled" }) + "\n"));
  observation.end();
  const envelope = resultEnvelope(identity, task, { processOutcome: "exited", exitCode: 0, signal: null, stopReason: "stop", protocolError: true }, observation.finalText);
  const captured = captureScoutCandidate({ root, identity, envelope, finalText: observation.finalText, childSessionId: sessionId, evidence: observation.evidence(), planningIdentity: "plan-run", generation: 1, parentRuntimeId: "runtime", parentSessionId: "main-session" });
  if (captured.state !== "captured") throw new Error(captured.reason);
  return captured.candidate;
}

test("production break-glass path binds raw editor submit through confirmation, writer, and both record provenances", async () => {
  const root = mkdtempSync(join(tmpdir(), "break-glass-runtime-"));
  try {
    const db = openDb(join(root, "yokemate.db"));
    const candidate = failedScout(root);
    const candidateRow = persistScoutCandidate(db, root, candidate);
    const ingress = new WorkflowIngressWitnessStore();
    let witness = undefined as ReturnType<WorkflowIngressWitnessStore["submit"]> | undefined;
    let factory: any = () => new RuntimeEditor();
    const uninstall = installWorkflowIngress({ getEditorComponent: () => factory, setEditorComponent: (value) => { factory = value; } }, (raw) => { witness = ingress.submit(raw, "main-session", "runtime"); });
    const commandText = `/break-glass YM-1 accept-plan-scout-input --candidate ${candidate.id} --reason complete-owned-final`;
    const editor = factory({}, {}, {});
    editor.setText(commandText);
    editor.handleInput("ENTER");
    assert.equal(witness?.raw, commandText);
    const command = parseBreakGlass(commandText);
    const scopeHash = sha256("scope");
    const targetHash = sha256("target");
    const plan = { state: "absent" as const, hash: sha256("absent"), scopeHash, pathHash: sha256("absent") };
    const permits = new BreakGlassPermitStore();
    const preview = previewScoutAcceptance({ db, root, command, witness: witness!, planningRunId: "plan-run", liveFailureHash: candidate.failedEnvelopeHash, scopeHash, targetHash, plan, store: permits });
    let confirmations = 0;
    const accepted = await resolveScoutAcceptance({
      db, root, store: permits, preview, witness: witness!, sourceUid: process.getuid!(),
      confirm: async () => { confirmations++; return true; },
      recheck: async () => ({ ...preview, plan: { ...plan }, bypassed: [...preview.bypassed], preserved: [...preview.preserved], blockers: [], permitId: undefined, createdAt: undefined, expiresAt: undefined } as never),
      continueLineage: async () => ({ planningIdentity: "plan-run:2", generation: 2 }),
    });
    assert.equal(confirmations, 1);
    assert.equal(accepted.acceptance.source_kind, "engineer-accepted-input");
    ingress.consume(witness!.id, "main-session", "runtime", commandText);

    const writerTaskHash = sha256("writer task");
    const writerActualTaskHash = sha256(`writer task\n${candidate.contentHash}`);
    claimWriterDispatch(db, db.prepare("SELECT * FROM workflow_incident WHERE id=?").get(accepted.incidentId) as never, { acceptedInputId: String(accepted.acceptance.id), planningIdentity: accepted.planningIdentity, kind: "initial", writerRunId: "writer-run", taskHash: writerTaskHash, actualTaskHash: writerActualTaskHash });
    const recoveredPlan = Buffer.from(`# Plan\n\n## Goal\nRecover.\n\n## Assumptions\n- BREAK-GLASS: engineer-accepted-input\n- incident: ${accepted.incidentId}\n- source-run: ${candidate.child.runId}\n- source-hash: ${candidate.contentHash}\n- reason: complete-owned-final\n- skipped: failed-transport-envelope\n\n## Acceptance\nPass.\n`);
    const recoveredHash = sha256(recoveredPlan);
    const recoveredPath = "home/knowledge/org/repo/ai/YM-1-recovered/plan.md";
    const recoveredArtifact = writePublicationArtifact(root, "YM-1", "plan", recoveredHash, recoveredPlan);
    recordWriterDraft(db, { content_hash: recoveredHash, accepted_input_id: accepted.acceptance.id, planning_identity: accepted.planningIdentity, writer_run_id: "writer-run", writer_task_hash: writerTaskHash, writer_actual_task_hash: writerActualTaskHash, plan_path: recoveredPath, bytes: recoveredPlan.length, result_hash: sha256(recoveredPath) });
    const recoveredRecord = acceptPlanRecord(db, { ticket: "YM-1", planPath: recoveredPath, contentHash: recoveredHash, scopeHash, artifactPath: recoveredArtifact, bytes: recoveredPlan.length, scoutAcceptance: accepted.acceptance.id, writer: { runId: "writer-run", taskHash: writerTaskHash, actualTaskHash: writerActualTaskHash } });
    markSuccessfulRecord(db, recoveredRecord.id);
    const recoveredPublication = acceptRecoveredPublication(db, root, { target: "github:org/repo#1", targetHash, ticket: "YM-1", kind: "plan", bytes: recoveredPlan, runId: "writer-run" }, accepted.acceptance.id);
    assert.equal(recoveredRecord.source_kind, "engineer-accepted-input");
    assert.equal(recoveredPublication.provenance_key, `incident:${accepted.incidentId}`);

    const normalIdentity = new ChildRuns("owner-normal", "main-session", "YM-1").admit("normal", [{ agent: "plan-scout", task: "normal" }], root).children[0]!.identity;
    const normalScout = acceptScoutArtifact(db, root, normalIdentity, Buffer.from("# normal scout\n"));
    const normalPlan = Buffer.from("# Normal plan\n\n## Goal\nNormal.\n\n## Acceptance\nPass.\n");
    const normalHash = sha256(normalPlan);
    const normalArtifact = writePublicationArtifact(root, "YM-1", "plan", normalHash, normalPlan);
    const normalRecord = acceptPlanRecord(db, { ticket: "YM-1", planPath: "home/knowledge/org/repo/ai/YM-1-normal/plan.md", contentHash: normalHash, scopeHash, artifactPath: normalArtifact, bytes: normalPlan.length, scoutAcceptance: normalScout.id });
    const normalPublication = acceptPublication(db, root, { target: "github:org/repo#1", targetHash, ticket: "YM-1", kind: "plan", bytes: normalPlan, runId: "normal-run" });
    assert.equal(normalRecord.source_kind, "normal-transport");
    assert.equal(normalPublication.provenance_key, "normal");
    uninstall();
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
