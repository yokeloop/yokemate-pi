import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { captureScoutCandidate } from "../src/plan-scout-recovery.ts";
import { ChildRuns, JsonlObservation, resultEnvelope, sha256 } from "../src/subagent-runs.ts";
import { BreakGlassPermitStore, parseBreakGlass, previewScoutAcceptance, resolveScoutAcceptance } from "../src/workflow-break-glass.ts";
import { persistScoutCandidate } from "../src/workflow-incident-state.ts";
import type { WorkflowIngressWitness } from "../src/workflow-ingress.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "break-glass-"));
  mkdirSync(join(root, ".pi"), { recursive: true });
  const task = "Scout";
  const identity = new ChildRuns("owner", "plan-session", "YM-1").admit("batch", [{ agent: "plan-scout", task }], root).children[0]!.identity;
  const observation = new JsonlObservation();
  observation.write(Buffer.from("{transport}\n"));
  const childSession = "11111111-1111-4111-8111-111111111111";
  observation.write(Buffer.from(JSON.stringify({ type: "session", id: childSession }) + "\n"));
  observation.write(Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "# Complete scout\n\nFacts.\n" }], stopReason: "stop" } }) + "\n"));
  observation.write(Buffer.from(JSON.stringify({ type: "agent_settled" }) + "\n"));
  observation.end();
  const envelope = resultEnvelope(identity, task, { processOutcome: "exited", exitCode: 0, signal: null, stopReason: "stop", protocolError: true }, observation.finalText);
  const captured = captureScoutCandidate({ root, identity, envelope, finalText: observation.finalText, childSessionId: childSession, evidence: observation.evidence(), planningIdentity: "plan-run", generation: 1, parentRuntimeId: "runtime", parentSessionId: "main-session" });
  if (captured.state !== "captured") throw new Error(captured.reason);
  const db = openDb(join(root, "yokemate.db"));
  const candidate = persistScoutCandidate(db, root, captured.candidate);
  const raw = `/break-glass YM-1 accept-plan-scout-input --candidate ${candidate.id} --reason transport failed after complete final`;
  const witness: WorkflowIngressWitness = { id: "witness", sessionId: "main-session", runtimeId: "runtime", generation: 3, raw, hash: sha256(raw), submittedAt: 1, consumed: false };
  const command = parseBreakGlass(raw);
  const store = new BreakGlassPermitStore();
  const preview = previewScoutAcceptance({ db, root, command, witness, planningRunId: "plan-run", liveFailureHash: candidate.failed_envelope_hash, scopeHash: sha256("scope"), targetHash: sha256("target"), plan: { state: "absent", hash: sha256("absent"), scopeHash: sha256("absent-scope"), pathHash: sha256("absent-path") }, store });
  const { permitId: _permit, createdAt: _created, expiresAt: _expires, ...expected } = preview;
  return { root, db, candidate, raw, witness, store, preview, expected };
}

test("strict parser accepts only the one candidate action and bounded reason", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(parseBreakGlass(`/break-glass YM-1 accept-plan-scout-input --candidate ${id} --reason exact transport failure`), { ticket: "YM-1", action: "accept-plan-scout-input", candidateId: id, reason: "exact transport failure" });
  for (const raw of [
    `/break-glass YM-1 accept-plan-scout-input --candidate ${id} --reason x --force`,
    `/break-glass YM-1 force --candidate ${id} --reason x`,
    `/break-glass YM-1 accept-plan-scout-input --candidate ${id} --candidate ${id} --reason x`,
    `/break-glass YM-1 accept-plan-scout-input --candidate ${id} --reason token=private`,
    `/break-glass YM-1 accept-plan-scout-input --candidate ${id} --reason x\nnext`,
    `/break-glass YM-1 accept-plan-scout-input --candidate * --reason x`,
  ]) assert.throws(() => parseBreakGlass(raw));
});

test("preview, mandatory confirmation and atomic consume produce one recovery acceptance", async () => {
  const fixture = setup();
  try {
    let confirms = 0;
    let continuations = 0;
    const result = await resolveScoutAcceptance({ db: fixture.db, root: fixture.root, store: fixture.store, preview: fixture.preview, witness: fixture.witness, sourceUid: process.getuid!(), confirm: async () => { confirms++; return true; }, recheck: async () => ({ ...fixture.expected, plan: { ...fixture.expected.plan }, preserved: [...fixture.expected.preserved], blockers: [] }), continueLineage: async () => { continuations++; return { planningIdentity: "plan-run:2", generation: 2 }; } });
    assert.equal(confirms, 1);
    assert.equal(continuations, 1);
    assert.equal(result.acceptance.source_kind, "engineer-accepted-input");
    assert.equal(result.acceptance.candidate_id, fixture.candidate.id);
    assert.equal(result.planningIdentity, "plan-run:2");
    await assert.rejects(() => resolveScoutAcceptance({ db: fixture.db, root: fixture.root, store: fixture.store, preview: fixture.preview, witness: fixture.witness, sourceUid: 0, confirm: async () => true, recheck: async () => fixture.expected, continueLineage: async () => ({ planningIdentity: "again", generation: 3 }) }), /not live/);
  } finally { fixture.db.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("decline, expiry, blocker, supersession and changed target prevent consumption", async () => {
  const declined = setup();
  try {
    await assert.rejects(() => resolveScoutAcceptance({ db: declined.db, root: declined.root, store: declined.store, preview: declined.preview, witness: declined.witness, sourceUid: 0, confirm: async () => false, recheck: async () => declined.expected, continueLineage: async () => ({ planningIdentity: "never", generation: 2 }) }), /declined/);
    assert.equal(declined.db.prepare("SELECT count(*) AS n FROM workflow_incident").get()?.n, 0);
  } finally { declined.db.close(); rmSync(declined.root, { recursive: true, force: true }); }

  let now = 0;
  const expiring = setup();
  const store = new BreakGlassPermitStore(10, () => now);
  const command = parseBreakGlass(expiring.raw);
  const preview = previewScoutAcceptance({ db: expiring.db, root: expiring.root, command, witness: expiring.witness, planningRunId: "plan-run", liveFailureHash: expiring.candidate.failed_envelope_hash, scopeHash: sha256("scope"), targetHash: sha256("target"), plan: expiring.preview.plan, store });
  const { permitId: _id, createdAt: _at, expiresAt: _until, ...expected } = preview;
  now = 11;
  await assert.rejects(() => resolveScoutAcceptance({ db: expiring.db, root: expiring.root, store, preview, witness: expiring.witness, sourceUid: 0, confirm: async () => true, recheck: async () => expected, continueLineage: async () => ({ planningIdentity: "never", generation: 2 }) }), /expired/);
  expiring.db.close(); rmSync(expiring.root, { recursive: true, force: true });

  const changed = setup();
  try {
    await assert.rejects(() => resolveScoutAcceptance({ db: changed.db, root: changed.root, store: changed.store, preview: changed.preview, witness: changed.witness, sourceUid: 0, confirm: async () => true, recheck: async () => ({ ...changed.expected, targetHash: sha256("changed") }), continueLineage: async () => ({ planningIdentity: "never", generation: 2 }) }), /targetHash changed/);
    changed.store.revoke();
    await assert.rejects(() => resolveScoutAcceptance({ db: changed.db, root: changed.root, store: changed.store, preview: changed.preview, witness: changed.witness, sourceUid: 0, confirm: async () => true, recheck: async () => changed.expected, continueLineage: async () => ({ planningIdentity: "never", generation: 2 }) }), /not live/);
  } finally { changed.db.close(); rmSync(changed.root, { recursive: true, force: true }); }
});
