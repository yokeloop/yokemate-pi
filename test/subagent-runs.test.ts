import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { ChildRuns, deliveryFor, reportContent, resultEnvelope, reviewerVerdict, PAYLOAD_LIMIT } from "../src/subagent-runs.ts";
import { buildReportDisplay } from "../src/subagent-report.ts";

const cwd = process.cwd();
const headSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const task = { agent: "task-reviewer", task: "exact task", review: { baseSha: headSha, headSha } };
const clean = { processOutcome: "exited" as const, exitCode: 0, signal: null, stopReason: "stop" };
const approved = '{"status":"approved","findings":[]}';

test("identities distinguish same-name siblings and batches; duplicate and foreign settle are inert", () => {
  const runs = new ChildRuns("owner", "session");
  const a = runs.admit("A", [task, task], cwd);
  const b = runs.admit("B", [task], cwd);
  const identities = [...a.children, ...b.children].map((child) => child.identity);
  assert.equal(new Set(identities.map((identity) => identity.runId)).size, 3);
  assert.equal(a.terminal, false);
  assert.throws(() => runs.admit("A", [task], cwd), /duplicate/);
  const result = resultEnvelope(identities[0]!, task.task, clean, approved);
  assert.equal(runs.settle({ ...result, identity: { ...result.identity, ownerRunId: "stale" } }), false);
  assert.equal(runs.settle(result), true);
  assert.equal(runs.settle(result), false);
  assert.equal(runs.batch("A"), undefined);
  assert.equal(runs.settle(resultEnvelope(identities[1]!, task.task, clean, approved)), true);
  assert.deepEqual(runs.batch("A")?.results[0], result);
  assert.deepEqual(runs.active().map((child) => child.identity.batchId), ["B"]);
});

test("settlement and batch snapshots are immutable from caller mutation", () => {
  const runs = new ChildRuns("owner", "session");
  const identity = runs.admit("immutable", [{ agent: "worker", task: "task" }], cwd).children[0]!.identity;
  const result = resultEnvelope(identity, "task", clean, "original");
  assert.equal(runs.settle(result), true);
  result.payload = "mutated";
  result.identity.agent = "changed";
  const first = runs.batch("immutable")!;
  assert.equal(first.results[0]!.payload, "original");
  assert.equal(first.results[0]!.identity.agent, "worker");
  first.results[0]!.payload = "batch mutation";
  assert.equal(runs.batch("immutable")!.results[0]!.payload, "original");
});

test("plan scouts require an explicit or stamped ticket and keep it in correlation identity", () => {
  assert.throws(() => new ChildRuns("owner", "session").admit("missing", [{ agent: "plan-scout", task: "scout" }], cwd), /ticket binding/);
  const stamped = new ChildRuns("owner", "session", "YM-1");
  const identity = stamped.admit("stamped", [{ agent: "plan-scout", task: "scout" }], cwd).children[0]!.identity;
  assert.equal(identity.ticket, "YM-1");
  assert.throws(() => stamped.admit("foreign", [{ agent: "plan-scout", task: "scout", ticket: "YM-2" }], cwd), /differs/);
  const problem = new ChildRuns("owner", "session").admit("problem", [{ agent: "plan-scout", task: "scout", ticket: "YM-3" }], cwd);
  assert.equal(problem.children[0]!.identity.ticket, "YM-3");
});

test("current accepted scout gates plan writers and a newer scout revokes prior permission", () => {
  const runs = new ChildRuns("owner", "session", "YM-1");
  assert.throws(() => new ChildRuns("owner", "session").admit("writer-unbound", [{ agent: "plan-writer", task: "write" }], cwd), /ticket binding/);
  assert.throws(() => runs.admit("writer-early", [{ agent: "plan-writer", task: "write", acceptedInputId: 1 }], cwd), /current accepted scout/);
  const first = runs.admit("scout-one", [{ agent: "plan-scout", task: "scout one" }], cwd).children[0]!.identity;
  const accepted = resultEnvelope(first, "scout one", clean, "# Scout");
  accepted.artifact = { state: "accepted", path: "/artifact", hash: "a".repeat(64), bytes: 7, acceptanceId: 1 };
  assert.equal(runs.settle(accepted), true);
  assert.equal(runs.admit("writer-one", [{ agent: "plan-writer", task: "write", acceptedInputId: 1 }], cwd).children[0]!.identity.ticket, "YM-1");
  const newer = runs.admit("scout-two", [{ agent: "plan-scout", task: "scout two" }], cwd).children[0]!.identity;
  assert.throws(() => runs.admit("writer-revoked", [{ agent: "plan-writer", task: "write", acceptedInputId: 1 }], cwd), /current accepted scout/);
  assert.equal(runs.settle(resultEnvelope(newer, "scout two", { ...clean, protocolError: true }, "beautiful final")), true);
  assert.throws(() => runs.admit("writer-after-fault", [{ agent: "plan-writer", task: "write", acceptedInputId: 1 }], cwd), /current accepted scout/);
});

test("plan writers require an explicit accepted scout binding and preserve it in child identity", () => {
  const runs = new ChildRuns("owner", "session", "YM-1");
  assert.throws(() => runs.admit("missing-input", [{ agent: "plan-writer", task: "write" }], cwd), /acceptedInputId/);
  assert.throws(() => new ChildRuns("owner", "session").admit("missing-ticket", [{ agent: "plan-writer", task: "write", acceptedInputId: 1 }], cwd), /explicit ticket/);
  const scout = runs.admit("scout", [{ agent: "plan-scout", task: "investigate" }], cwd).children[0]!.identity;
  const accepted = resultEnvelope(scout, "investigate", clean, "# Scout");
  accepted.artifact = { state: "accepted", path: "/artifact", hash: "a".repeat(64), bytes: 7, acceptanceId: 7 };
  assert.equal(runs.settle(accepted), true);
  assert.throws(() => runs.admit("wrong-input", [{ agent: "plan-writer", task: "write", acceptedInputId: 8 }], cwd), /current accepted scout/);
  const identity = runs.admit("writer", [{ agent: "plan-writer", task: "write", ticket: "YM-1", acceptedInputId: 7 }], cwd).children[0]!.identity;
  assert.equal(identity.ticket, "YM-1");
  assert.equal(identity.acceptedInputId, 7);
  assert.throws(() => runs.admit("foreign", [{ agent: "plan-writer", task: "write", ticket: "YM-2", acceptedInputId: 8 }], cwd), /differs/);
  assert.throws(() => runs.admit("bad-revision", [{ agent: "plan-writer", task: "revise", ticket: "YM-1", acceptedInputId: 7, writerRevisionOf: "short" }], cwd), /full draft hash/);
});

test("review revisions are validated before admission and template hashes survive chain substitution", () => {
  const runs = new ChildRuns("owner", "session");
  assert.throws(() => runs.admit("bad", [{ agent: "task-reviewer", task: "task" }], cwd), /requires review/);
  assert.throws(() => runs.admit("bad", [{ ...task, review: { baseSha: "short", headSha } }], cwd), /full commit/);
  assert.equal(runs.active().length, 0);
  const ack = runs.admit("chain", [{ ...task, task: "review {previous}" }, task], cwd);
  const first = resultEnvelope(ack.children[0]!.identity, "review substituted", { ...clean, exitCode: 1 }, approved);
  const second = resultEnvelope(ack.children[1]!.identity, task.task, { processOutcome: "not_started", exitCode: null, signal: null }, "");
  runs.settle(first);
  runs.settle(second);
  assert.notEqual(first.actualTaskHash, first.identity.taskHash);
  assert.equal(runs.batch("chain", "chain")?.results[1]?.processOutcome, "not_started");
});

test("review verdict is separate from process and payload failures, and oversized JSON is not truncated into success", () => {
  const identity = new ChildRuns("owner", "session").admit("A", [task], cwd).children[0]!.identity;
  assert.equal(resultEnvelope(identity, task.task, clean, approved).reviewVerdict, "approved");
  for (const terminal of [{ ...clean, signal: "SIGTERM", processOutcome: "signaled" as const }, { ...clean, exitCode: null }, { ...clean, exitCode: 1 }, { ...clean, incomplete: true }, { ...clean, stopReason: "toolUse" }]) {
    const result = resultEnvelope(identity, task.task, terminal, approved);
    assert.equal(result.payloadOutcome, "incomplete");
    assert.equal(result.reviewVerdict, null);
  }
  assert.equal(resultEnvelope(identity, task.task, clean, "").payloadOutcome, "missing_final");
  assert.equal(resultEnvelope(identity, task.task, clean, "{}").payloadOutcome, "invalid_reviewer_json");
  const huge = resultEnvelope(identity, task.task, clean, approved + " ".repeat(PAYLOAD_LIMIT));
  assert.equal(huge.payloadOutcome, "output_limit");
  assert.equal(huge.payload, "");
  assert.equal(huge.reviewVerdict, null);
  const finding = { severity: "blocking", lens: 1, file: "src/x.ts", line: 1, problem: "problem", evidence: "evidence", fix: "fix" };
  assert.equal(reviewerVerdict(JSON.stringify({ status: "approved", findings: [finding] })), null);
  assert.equal(reviewerVerdict(JSON.stringify({ status: "changes_required", findings: [finding] })), "changes_required");
});

test("JSONL observation preserves split UTF-8 and the last assistant only", async () => {
  const { JsonlObservation } = await import("../src/subagent-runs.ts");
  const observed = new JsonlObservation();
  const line = (message: unknown) => Buffer.from(JSON.stringify({ type: "message_end", message }) + "\r\n");
  const bytes = line({ role: "assistant", content: [{ type: "text", text: "é日" }, { type: "text", text: "🙂" }], stopReason: "stop", provider: "fixture", model: "model" });
  for (const byte of bytes) observed.write(Buffer.from([byte]));
  assert.equal(observed.finalText, "é日🙂");
  observed.write(line({ role: "assistant", content: [{ type: "thinking", thinking: "private" }], stopReason: "toolUse" }));
  observed.end();
  assert.equal(observed.finalText, "");
  assert.equal(observed.stopReason, "toolUse");
  assert.equal(observed.protocolError, false);
  assert.doesNotMatch(JSON.stringify(observed.metadata()), /private/);
});

test("JSONL framing reports malformed, unfinished and overflow records without retaining secrets", async () => {
  const { JsonlObservation } = await import("../src/subagent-runs.ts");
  for (const bytes of [Buffer.from('{bad-private}\n'), Buffer.from('{"unfinished":"private"}'), Buffer.from('x'.repeat(1024 * 1024 + 1) + '\n')]) {
    const observed = new JsonlObservation();
    observed.write(bytes);
    observed.end();
    assert.equal(observed.protocolError, true);
    assert.ok(observed.metadata().parserErrors > 0);
    assert.doesNotMatch(JSON.stringify(observed.metadata()), /bad-private|unfinished|x{100}/);
  }
});

test("parser facts are byte-exact, cumulative and preserve authoritative final hashes", async () => {
  const { JsonlObservation, sha256 } = await import("../src/subagent-runs.ts");
  const record = (bytes: number) => {
    const prefix = '{"type":"future_event","pad":"';
    const suffix = '"}';
    return Buffer.from(prefix + "x".repeat(bytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)) + suffix);
  };
  const exact = new JsonlObservation();
  const exactWire = Buffer.concat([record(1024 * 1024), Buffer.from("\r\n")]);
  for (let offset = 0; offset < exactWire.length; offset += 8191) exact.write(exactWire.subarray(offset, offset + 8191));
  exact.end();
  assert.equal(exact.protocolError, false);
  assert.equal(exact.metadata().events.other, 1);
  assert.equal(exact.metadata().stdoutBytes, exactWire.length);
  assert.equal(exact.metadata().stdoutHash, sha256(exactWire));

  const tooLarge = new JsonlObservation();
  tooLarge.write(Buffer.concat([record(1024 * 1024 + 1), Buffer.from("\n")]))
  tooLarge.end();
  assert.deepEqual(tooLarge.metadata().firstParserError, { kind: "record_limit", offset: 0 });
  assert.equal(tooLarge.metadata().parserErrorCounters.record_limit, 1);

  const overflowEof = new JsonlObservation();
  overflowEof.write(record(1024 * 1024 + 2));
  overflowEof.end();
  overflowEof.end();
  assert.deepEqual(overflowEof.metadata().firstParserError, { kind: "record_limit", offset: 0 });
  assert.deepEqual(overflowEof.metadata().lastParserError, { kind: "partial_record", offset: 0 });
  assert.deepEqual(overflowEof.metadata().parserErrorCounters, { invalid_json: 0, invalid_event: 0, record_limit: 1, partial_record: 1 });

  const mixed = new JsonlObservation();
  const finalText = "é日🙂tail";
  const final = Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalText }], stopReason: "stop" } }) + "\n");
  const wire = Buffer.concat([Buffer.from("junk\n{}\n{\"type\":\"future\"}\n"), final]);
  for (const byte of wire) mixed.write(Buffer.from([byte]));
  mixed.end();
  assert.equal(mixed.finalText, finalText);
  assert.equal(mixed.metadata().assistantMessageSeen, true);
  assert.equal(mixed.metadata().finalTextPresent, true);
  assert.equal(mixed.metadata().events.other, 1);
  assert.deepEqual(mixed.metadata().parserErrorCounters, { invalid_json: 1, invalid_event: 1, record_limit: 0, partial_record: 0 });
  assert.deepEqual(mixed.metadata().firstParserError, { kind: "invalid_json", offset: 0 });
  assert.deepEqual(mixed.metadata().lastParserError, { kind: "invalid_event", offset: 5 });
  assert.equal(mixed.metadata().stdoutHash, sha256(wire));

  const completeWithoutLf = new JsonlObservation();
  completeWithoutLf.write(final.subarray(0, -1));
  completeWithoutLf.end();
  assert.equal(completeWithoutLf.metadata().assistantMessageSeen, false);
  assert.deepEqual(completeWithoutLf.metadata().lastParserError, { kind: "partial_record", offset: 0 });
});

test("patched producer summarizes only oversized agent_end messages and parser validates the summary", async () => {
  const { JsonlObservation, sha256 } = await import("../src/subagent-runs.ts");
  const { toJsonEvent, YOKEMATE_SUBAGENT_JSON_CONTRACT_VERSION } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/json-event.js");
  assert.equal(YOKEMATE_SUBAGENT_JSON_CONTRACT_VERSION, 1);
  const small = { type: "agent_end", messages: [{ role: "user", content: "small" }], willRetry: false } as any;
  const smallCopy = structuredClone(small);
  assert.equal(toJsonEvent(small, { yokemateSubagentJsonContract: 1 }), small);
  assert.equal(JSON.stringify(toJsonEvent(small, { yokemateSubagentJsonContract: 1 })), JSON.stringify(small));
  assert.deepEqual(small, smallCopy);

  const messages = [{ role: "user", content: "é".repeat(600_000) }, { role: "assistant", content: "tail" }];
  const large = { type: "agent_end", messages, willRetry: true } as any;
  const summarized = toJsonEvent(large, { yokemateSubagentJsonContract: 1 }) as any;
  const serializedMessages = JSON.stringify(messages);
  assert.equal(summarized.messages, undefined);
  assert.deepEqual(summarized.messagesSummary, { version: 1, count: 2, bytes: Buffer.byteLength(serializedMessages), sha256: sha256(serializedMessages) });
  assert.equal(summarized.willRetry, true);
  assert.equal(large.messages, messages);

  const valid = new JsonlObservation();
  valid.write(Buffer.from(JSON.stringify(summarized) + "\n"));
  valid.end();
  assert.equal(valid.protocolError, false);
  for (const bad of [
    { ...summarized, messages: [{ role: "user", content: "small" }] },
    { ...summarized, messagesSummary: { ...summarized.messagesSummary, version: 2 } },
    { ...summarized, messagesSummary: { ...summarized.messagesSummary, sha256: "A".repeat(64) } },
  ]) {
    const observed = new JsonlObservation();
    observed.write(Buffer.from(JSON.stringify(bad) + "\n"));
    observed.end();
    assert.deepEqual(observed.metadata().lastParserError, { kind: "invalid_event", offset: 0 });
  }
});

test("tool and retry remain incomplete until their actual end events", async () => {
  const { JsonlObservation } = await import("../src/subagent-runs.ts");
  const observed = new JsonlObservation();
  const event = (value: unknown) => observed.write(Buffer.from(JSON.stringify(value) + "\n"));
  event({ type: "tool_execution_start", toolCallId: "one", args: { secret: "private" } });
  assert.equal(observed.incomplete, true);
  event({ type: "tool_execution_end", toolCallId: "one" });
  event({ type: "auto_retry_start", errorMessage: "private" });
  assert.equal(observed.incomplete, true);
  event({ type: "auto_retry_end", success: true });
  assert.equal(observed.incomplete, false);
  assert.doesNotMatch(JSON.stringify(observed.metadata()), /private/);
});

test("ordinary snapshots are private, bounded, locked and protect active delivery lifecycles", async () => {
  const fs = (await import("node:fs")).default;
  const path = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { JsonlObservation, RunSnapshots } = await import("../src/subagent-runs.ts");
  const root = fs.mkdtempSync(path.join(tmpdir(), "ym226-snapshots-"));
  const activeRoot = path.join(root, "active");
  try {
    const snapshots = new RunSnapshots(activeRoot);
    const identity = { ownerSessionId: "session", batchId: "batch", agent: "worker", taskHash: "a".repeat(64) };
    const observed = new JsonlObservation();
    observed.write(Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } }) + "\n"));
    const stream = { ...observed.metadata(), privateNested: "private sentinel" };
    assert.deepEqual(snapshots.write("owner", "active", { identity, ownerPid: process.pid, runtime: { node: process.version, pi: "0.85.1", contract: 1, privateNested: "private sentinel" }, artifact: { state: "accepted", hash: "b".repeat(64), bytes: 4, acceptanceId: 7, path: "private sentinel" }, publication: { state: "pending", revision: "c".repeat(64), publicationId: 9, error: "target_unavailable", target: "private sentinel" }, stream, rawPrompt: "private sentinel", deliveries: {} }, false), { state: "available" });
    const dir = path.join(activeRoot, "sessions/subagent-runs");
    const active = fs.readFileSync(path.join(dir, "owner-active.json"), "utf8");
    const activeSnapshot = JSON.parse(active);
    assert.deepEqual(activeSnapshot.artifact, { state: "accepted", hash: "b".repeat(64), bytes: 4, acceptanceId: 7 });
    assert.deepEqual(activeSnapshot.publication, { state: "pending", revision: "c".repeat(64), publicationId: 9, error: "target_unavailable" });
    assert.deepEqual(activeSnapshot.runtime, { node: process.version, pi: "0.85.1", contract: 1 });
    assert.doesNotMatch(active, /private sentinel|rawPrompt|privateNested/);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, "owner-active.json")).mode & 0o777, 0o600);
    for (let i = 0; i < 39; i++) assert.equal(snapshots.write("owner", `active-${i}`, { identity, deliveries: {} }, false).state, "available");
    assert.deepEqual(snapshots.write("owner", "protected-overflow", { identity, deliveries: {} }, false), { state: "unavailable", code: "storage_limit" });
    assert.equal(fs.readdirSync(dir).filter((name: string) => name.endsWith(".json")).length, 40);

    const completedRoot = path.join(root, "completed");
    const completed = new RunSnapshots(completedRoot);
    for (let i = 0; i < 24; i++) {
      const delivery = "b".repeat(62) + i.toString(16).padStart(2, "0");
      const status = completed.write("owner", `run-${i}`, { identity, closeAt: new Date().toISOString(), terminal: { processOutcome: "exited", exitCode: 0, signal: null, stopReason: "stop" }, deliveries: { [delivery]: { state: "observed", envelopeHash: "c".repeat(64), observedAt: new Date().toISOString() } }, arbitrary: "private sentinel" }, true);
      assert.equal(status.state, "available");
    }
    const completedDir = path.join(completedRoot, "sessions/subagent-runs");
    assert.equal(fs.readdirSync(completedDir).filter((name: string) => name.endsWith(".json")).length, 20);
    assert.doesNotMatch(fs.readFileSync(path.join(completedDir, fs.readdirSync(completedDir).find((name: string) => name.endsWith(".json"))!), "utf8"), /private sentinel/);

    const liveLockRoot = path.join(root, "live-lock");
    const liveLock = new RunSnapshots(liveLockRoot, { pid: 42, processStarttime: () => "live" });
    fs.mkdirSync(liveLock.directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(liveLock.directory, ".lock"), JSON.stringify({ pid: 41, starttime: "live" }), { mode: 0o600 });
    assert.deepEqual(liveLock.write("owner", "blocked", { identity }, false), { state: "unavailable", code: "storage_busy" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("result, chain and follow-up batch canonical contracts remain distinct and byte-stable", () => {
  const runs = new ChildRuns("owner", "session");
  const ack = runs.admit("single", [task], cwd);
  const result = resultEnvelope(ack.children[0]!.identity, task.task, clean, approved);
  assert.equal(runs.settle(result), true);
  const batch = runs.batch("single")!;
  const resultDelivery = deliveryFor(result);
  const batchDelivery = deliveryFor(batch);
  const resultCanonical = reportContent(result, resultDelivery);
  const batchCanonical = reportContent(batch, batchDelivery);
  assert.notEqual(resultDelivery.deliveryId, batchDelivery.deliveryId);
  assert.equal(resultCanonical, `[subagent task-reviewer] ${JSON.stringify({ version: 1, deliveryId: resultDelivery.deliveryId, envelopeHash: resultDelivery.envelopeHash, envelope: result })}`);
  assert.equal(batchCanonical, `[subagent batch complete] ${JSON.stringify({ version: 1, deliveryId: batchDelivery.deliveryId, envelopeHash: batchDelivery.envelopeHash, envelope: batch })}`);

  const chainRuns = new ChildRuns("owner", "session");
  const chainAck = chainRuns.admit("chain", [task, task], cwd);
  for (const child of chainAck.children) assert.equal(chainRuns.settle(resultEnvelope(child.identity, task.task, clean, approved)), true);
  const chain = chainRuns.batch("chain", "chain")!;
  const followUp = chainRuns.batch("chain")!;
  const chainDelivery = deliveryFor(chain);
  const followUpDelivery = deliveryFor(followUp);
  assert.equal(reportContent(chain, chainDelivery), `[subagent chain] ${JSON.stringify({ version: 1, deliveryId: chainDelivery.deliveryId, envelopeHash: chainDelivery.envelopeHash, envelope: chain })}`);
  assert.equal(reportContent(followUp, followUpDelivery), `[subagent batch complete] ${JSON.stringify({ version: 1, deliveryId: followUpDelivery.deliveryId, envelopeHash: followUpDelivery.envelopeHash, envelope: followUp })}`);
});

test("aggregate framing budgets account for escaped content and details without changing settled envelopes", async () => {
  const { boundBatchResult, deliveryFor, reportContent, JsonlObservation } = await import("../src/subagent-runs.ts");
  for (const character of ["x", '"']) {
    const runs = new ChildRuns("owner", "session");
    const ack = runs.admit("maximum", Array.from({ length: 8 }, () => task), cwd);
    const payload = JSON.stringify({ status: "approved", findings: [{ severity: "advice", lens: 1, file: "fixture.ts", line: 1, problem: "fixture", evidence: character.repeat(character === "x" ? 48000 : 24000), fix: "fixture" }] });
    assert.ok(Buffer.byteLength(payload) < PAYLOAD_LIMIT);
    const results = ack.children.map(({ identity }) => boundBatchResult(resultEnvelope(identity, task.task, clean, payload), ack.children.map((child) => child.identity)));
    assert.ok(results.every((result) => result.payloadOutcome === "valid"));
    if (character === '"') assert.ok(results.every((result) => Buffer.byteLength(result.payload) < Buffer.byteLength(payload)));
    for (const result of results) assert.equal(runs.settle(result), true);
    const envelope = runs.batch("maximum")!;
    assert.deepEqual(envelope.results, results);
    const delivery = deliveryFor(envelope);
    const admissions = new Map(ack.children.map(({ identity }, ordinal) => [identity.runId, { startedAt: 0, taskExcerpt: `${ordinal} ${character.repeat(200)}`, ordinal: ordinal + 1 }]));
    const display = buildReportDisplay(envelope, admissions, 10_000, { state: "available", reportPath: `/private/${character.repeat(100)}/report.txt`, diagnosticsPath: `/private/${character.repeat(100)}/diagnostics.json`, reportBytes: 1024, reportHash: "f".repeat(64), retentionDays: 7 });
    const record = JSON.stringify({ type: "message_end", message: { role: "custom", customType: "subagent-report", content: reportContent(envelope, delivery), details: { version: 1, deliveryId: delivery.deliveryId, envelopeHash: delivery.envelopeHash, envelope, display } } });
    assert.ok(Buffer.byteLength(record) < 1024 * 1024);
    const observation = new JsonlObservation();
    observation.write(Buffer.from(record + "\n"));
    observation.end();
    assert.equal(observation.protocolError, false);
  }
  const runs = new ChildRuns("owner", "session");
  assert.throws(() => runs.admit("oversized-identities", Array.from({ length: 2000 }, () => ({ agent: "worker", task: "task" })), cwd), /batch identity exceeds JSONL transport budget/);
  const one = new ChildRuns("owner", "session").admit("immutable-overflow", [{ agent: "worker", task: "task" }], cwd);
  const immutableOverflow = { ...resultEnvelope(one.children[0]!.identity, "task", clean, "done"), artifact: { state: "verified" as const, path: `/private/${"x".repeat(600000)}`, hash: "a".repeat(64), bytes: 4 } };
  assert.throws(() => boundBatchResult(immutableOverflow, one.children.map((child) => child.identity)), /immutable subagent result exceeds JSONL transport budget/);
  assert.equal(runs.children.size, 0);
  assert.equal(runs.batches.size, 0);
});
