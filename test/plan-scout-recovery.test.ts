import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureScoutCandidate } from "../src/plan-scout-recovery.ts";
import { ChildRuns, JsonlObservation, resultEnvelope, sha256 } from "../src/subagent-runs.ts";

const clean = { processOutcome: "exited" as const, exitCode: 0, signal: null, stopReason: "stop", protocolError: true };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "scout-recovery-"));
  mkdirSync(join(root, ".pi"), { recursive: true });
  const task = "Investigate exactly";
  const identity = new ChildRuns("owner", "parent-session", "YM-1").admit("batch", [{ agent: "plan-scout", task }], root).children[0]!.identity;
  return { root, task, identity };
}

function observation(finalText: string, chunks = 1) {
  const observed = new JsonlObservation();
  observed.write(Buffer.from("{failed transport record}\n"));
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const records = Buffer.from(JSON.stringify({ type: "session", id: sessionId }) + "\n" + JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalText.slice(0, 3) }, { type: "text", text: finalText.slice(3) }], stopReason: "stop" } }) + "\n" + JSON.stringify({ type: "agent_settled" }) + "\n");
  const width = Math.max(1, Math.ceil(records.length / chunks));
  for (let offset = 0; offset < records.length; offset += width) observed.write(records.subarray(offset, offset + width));
  observed.end();
  return { observed, sessionId };
}

test("captures the complete post-error final as exact UTF-8 bytes without normalizing transport", () => {
  const { root, task, identity } = fixture();
  try {
    const finalText = "\uFEFF# Scout\r\n\r\nUnicode é日🙂\r\n" + "x".repeat(55 * 1024) + "\r\nEVIDENCE-TAIL\r\n";
    const { observed, sessionId } = observation(finalText, 97);
    const envelope = resultEnvelope(identity, task, clean, observed.finalText);
    assert.equal(envelope.payloadOutcome, "protocol_error");
    assert.ok(Buffer.byteLength(envelope.payload) <= 50 * 1024 + 32);
    const captured = captureScoutCandidate({ root, identity, envelope, finalText: observed.finalText, childSessionId: sessionId, evidence: observed.evidence(), planningIdentity: "plan-run:1", generation: 1, parentRuntimeId: "runtime", parentSessionId: "parent-session" });
    assert.equal(captured.state, "captured");
    if (captured.state !== "captured") return;
    const bytes = readFileSync(captured.candidate.artifactPath);
    assert.deepEqual(bytes, Buffer.from(finalText, "utf8"));
    assert.equal(captured.candidate.bytes, bytes.length);
    assert.equal(captured.candidate.contentHash, sha256(bytes));
    assert.equal(captured.candidate.failedEnvelopeHash, sha256(JSON.stringify(envelope)));
    assert.equal(captured.candidate.evidence.errors[0]?.kind, "invalid_json");
    assert.ok(captured.candidate.evidence.finalSequence! > captured.candidate.evidence.errors[0]!.eventSequence);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("refuses loss, stale terminal state, foreign identity and non-protocol failures", () => {
  const { root, task, identity } = fixture();
  try {
    const { observed, sessionId } = observation("# Complete scout\n");
    const envelope = resultEnvelope(identity, task, clean, observed.finalText);
    const base = { root, identity, envelope, finalText: observed.finalText, childSessionId: sessionId, evidence: observed.evidence(), planningIdentity: "plan-run:1", generation: 1, parentRuntimeId: "runtime", parentSessionId: "parent-session" };
    const cases = [
      [{ ...base, evidence: { ...base.evidence, recordLimit: true, lostSource: true } }, "lost-source"],
      [{ ...base, evidence: { ...base.evidence, retry: true } }, "active-runtime-state"],
      [{ ...base, evidence: { ...base.evidence, finalSequence: undefined } }, "stale-final"],
      [{ ...base, childSessionId: "22222222-2222-4222-8222-222222222222" }, "missing-session"],
      [{ ...base, envelope: { ...envelope, actualTaskHash: "f".repeat(64) } }, "task-mismatch"],
      [{ ...base, envelope: { ...envelope, payloadOutcome: "valid" as const } }, "not-failed-transport"],
      [{ ...base, blockers: ["auth" as const] }, "blocked-auth"],
    ] as const;
    for (const [input, reason] of cases) assert.deepEqual(captureScoutCandidate(input), { state: "refused", reason });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("settled evidence never erases a known nonempty queue and later activity requires a new terminal cycle", () => {
  const observed = new JsonlObservation();
  const write = (event: unknown) => observed.write(Buffer.from(JSON.stringify(event) + "\n"));
  write({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final" }], stopReason: "stop" } });
  write({ type: "queue_update", steering: [{ text: "continue" }], followUp: [] });
  write({ type: "agent_settled" });
  assert.equal(observed.evidence().agentSettled, true);
  assert.equal(observed.evidence().queueEmpty, false);
  write({ type: "queue_update", steering: [], followUp: [] });
  assert.equal(observed.evidence().agentSettled, false);
  write({ type: "agent_settled" });
  assert.equal(observed.evidence().agentSettled, true);
  assert.equal(observed.evidence().queueEmpty, true);
  write({ type: "turn_start" });
  assert.equal(observed.evidence().agentSettled, false);
});

test("invalid UTF-8 and record overflow remain monotonic loss evidence while genuine replacement text is valid", () => {
  const invalid = new JsonlObservation();
  invalid.write(Buffer.from([0xff, 0x0a]));
  invalid.end();
  assert.equal(invalid.evidence().invalidUtf8, true);
  assert.equal(invalid.evidence().lostSource, true);
  assert.equal(invalid.evidence().errors[0]?.kind, "invalid_utf8");

  const overflow = new JsonlObservation();
  overflow.write(Buffer.from("x".repeat(1024 * 1024 + 1) + "\n"));
  overflow.end();
  assert.equal(overflow.evidence().recordLimit, true);
  assert.equal(overflow.evidence().lostSource, true);

  const genuine = new JsonlObservation();
  genuine.write(Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "genuine �" }], stopReason: "stop" } }) + "\n"));
  genuine.end();
  assert.equal(genuine.finalText, "genuine �");
  assert.equal(genuine.evidence().invalidUtf8, false);
});
