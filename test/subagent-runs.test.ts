import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { boundBatchResult, ChildRuns, deliveryFor, reportContent, resultEnvelope, reviewerVerdict, sha256, PAYLOAD_LIMIT } from "../src/subagent-runs.ts";
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
  (result.identity as { agent: string }).agent = "changed";
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
  for (const separator of ["\n", "\r\n"]) {
    const exact = new JsonlObservation();
    const exactWire = Buffer.concat([record(1024 * 1024), Buffer.from(separator)]);
    for (let offset = 0; offset < exactWire.length; offset += 8191) exact.write(exactWire.subarray(offset, offset + 8191));
    exact.end();
    assert.equal(exact.protocolError, false);
    assert.equal(exact.metadata().events.other, 1);
    assert.equal(exact.metadata().stdoutBytes, exactWire.length);
    assert.equal(exact.metadata().stdoutHash, sha256(exactWire));

    const tooLarge = new JsonlObservation();
    tooLarge.write(Buffer.concat([record(1024 * 1024 + 1), Buffer.from(separator)]));
    tooLarge.end();
    assert.deepEqual(tooLarge.metadata().firstParserError, { kind: "record_limit", offset: 0 });
    assert.equal(tooLarge.metadata().parserErrorCounters.record_limit, 1);
  }

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

  const invalidUtf8 = new JsonlObservation();
  invalidUtf8.write(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3]));
  invalidUtf8.write(Buffer.from([0x28, 0x22, 0x7d, 0x0a]));
  invalidUtf8.write(final);
  invalidUtf8.end();
  assert.equal(invalidUtf8.protocolError, true);
  assert.equal(invalidUtf8.evidence().invalidUtf8, true);
  assert.deepEqual(invalidUtf8.metadata().firstParserError, { kind: "invalid_json", offset: 0 });
  assert.equal(invalidUtf8.finalText, finalText);

  const completeWithoutLf = new JsonlObservation();
  completeWithoutLf.write(final.subarray(0, -1));
  completeWithoutLf.end();
  assert.equal(completeWithoutLf.metadata().assistantMessageSeen, false);
  assert.deepEqual(completeWithoutLf.metadata().lastParserError, { kind: "partial_record", offset: 0 });
});

test("YM-221 writer terminal contract preserves failure precedence and required payload budget", async () => {
  const runs = new ChildRuns("owner", "session");
  const task = { agent: "plan-writer", task: "write", ticket: "YM-1", acceptedInputId: 1 };
  const admitted = runs.admit("writer", [task], cwd, () => undefined);
  const identity = admitted.children[0]!.identity;
  const empty = resultEnvelope(identity, task.task, clean, " \r\n");
  assert.equal(empty.payloadOutcome, "missing_final");
  const nonzero = resultEnvelope(identity, task.task, { ...clean, exitCode: 7 }, "/tmp/existing-plan.md");
  assert.equal(nonzero.payloadOutcome, "incomplete");
  const parser = resultEnvelope(identity, task.task, { ...clean, protocolError: true }, "/tmp/existing-plan.md");
  assert.equal(parser.payloadOutcome, "protocol_error");
  const oversized = resultEnvelope(identity, task.task, clean, "x".repeat(PAYLOAD_LIMIT + 1));
  assert.equal(oversized.payloadOutcome, "output_limit");
  assert.equal(oversized.payload, "");
  const required = { ...resultEnvelope(identity, task.task, clean, "/tmp/plan.md"), planResult: { state: "verified" as const, source: "final" as const, binding: { ticket: "YM-1", path: "/tmp/plan.md", repositories: ["org/repo"], scopeHash: "a".repeat(64), contentHash: "b".repeat(64) }, artifactBytes: 12 } };
  const bounded = boundBatchResult(required, [identity]);
  assert.equal(bounded.payloadOutcome, "valid");
  assert.equal(bounded.payload, "/tmp/plan.md");
  assert.equal(buildReportDisplay({ ...required, planResult: { ...required.planResult, source: "reconciled" } }, new Map(), 1).brief, "reconciled; review required");
  const rejected = { ...required, payloadOutcome: "missing_final" as const, payload: "", planResult: { state: "rejected" as const, reason: "artifact_not_found" as const } };
  assert.equal(buildReportDisplay(rejected, new Map(), 1).failureReason, "missing_final / artifact_not_found");
  assert.equal(runs.settle(required), true);
  assert.deepEqual(await runs.finalized(identity), required);
  assert.equal(runs.settle({ ...required, payloadOutcome: "invalid_plan_result", payload: "" }), false);
  assert.deepEqual(await runs.finalized(identity), required);
});

test("YM-221 bounded writer evidence", async () => {
  const { JsonlObservation, sha256 } = await import("../src/subagent-runs.ts");
  const observed = new JsonlObservation();
  const records = [
    "\r",
    "{malformed}",
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "é" } }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "observed" }], stopReason: "stop" } }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } }),
  ];
  const wire = Buffer.from(records.join("\n") + "\n");
  for (let offset = 0; offset < wire.length; offset += 3) observed.write(wire.subarray(offset, offset + 3));
  observed.end();
  const facts = observed.metadata();
  assert.equal(facts.parsedBytes + facts.malformedBytes + facts.ignoredBytes + facts.framingBytes + facts.partialBytes, wire.length);
  assert.equal(facts.ignoredBytes, 1);
  assert.equal(facts.framingBytes, records.length);
  assert.equal(facts.textDeltaEvents, 1);
  assert.equal(facts.textDeltaBytes, Buffer.byteLength("é"));
  assert.equal(facts.assistantMessageEndCount, 2);
  assert.equal(facts.assistantTextBearingCount, 1);
  assert.equal(facts.finalEventPresent, true);
  assert.equal(facts.finalTextPresent, false);
  assert.equal(facts.finalNonWhitespace, false);
  assert.equal(facts.finalTextBytes, 0);
  assert.equal(facts.finalTextHash, sha256(""));
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

  const aggregateAt = (bytes: number) => {
    const event = { type: "agent_end", messages: [{ role: "user", content: "" }], willRetry: false } as any;
    const overhead = Buffer.byteLength(JSON.stringify(event));
    event.messages[0].content = "x".repeat(bytes - overhead);
    assert.equal(Buffer.byteLength(JSON.stringify(event)), bytes);
    return event;
  };
  const exact = aggregateAt(1024 * 1024);
  const over = aggregateAt(1024 * 1024 + 1);
  assert.equal(toJsonEvent(exact, { yokemateSubagentJsonContract: 1 }), exact);
  assert.equal((toJsonEvent(over, { yokemateSubagentJsonContract: 1 }) as any).messages, undefined);

  const messages = [{ role: "user", content: "é".repeat(600_000) }, { role: "assistant", content: "tail" }];
  const large = { type: "agent_end", messages, willRetry: true } as any;
  const largeCopy = structuredClone(large);
  const serializedMessages = JSON.stringify(messages);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > JSON.stringify(large).length);
  assert.equal(toJsonEvent(large), large);
  assert.equal(toJsonEvent(large, { yokemateSubagentJsonContract: undefined }), large);
  const summarized = toJsonEvent(large, { yokemateSubagentJsonContract: 1 }) as any;
  assert.equal(summarized.messages, undefined);
  assert.deepEqual(summarized.messagesSummary, { version: 1, count: 2, bytes: Buffer.byteLength(serializedMessages), sha256: sha256(serializedMessages) });
  assert.equal(summarized.willRetry, true);
  assert.deepEqual(large, largeCopy);
  assert.equal(large.messages, messages);

  for (const type of ["future_event", "response", "message_end", "entry_appended"]) {
    const event = { type, content: "é".repeat(600_000) } as any;
    assert.ok(Buffer.byteLength(JSON.stringify(event)) > 1024 * 1024);
    assert.equal(toJsonEvent(event, { yokemateSubagentJsonContract: 1 }), event);
  }

  const callbacks: any[] = [];
  const valid = new JsonlObservation((event) => callbacks.push(event));
  const emit = (event: unknown) => valid.write(Buffer.from(JSON.stringify(event) + "\n"));
  emit({ type: "tool_execution_start", toolCallId: "active" });
  emit({ type: "auto_retry_start" });
  emit({ type: "compaction_start" });
  emit(summarized);
  assert.equal(valid.incomplete, true);
  assert.equal(valid.evidence().agentSettled, false);
  emit({ type: "tool_execution_end", toolCallId: "active" });
  emit({ type: "auto_retry_end" });
  emit({ type: "compaction_end" });
  const final = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "authoritative" }], stopReason: "stop" } };
  emit(final);
  emit({ type: "agent_settled" });
  emit({ type: "response", id: "next", success: true });
  valid.end();
  assert.equal(valid.protocolError, false);
  assert.equal(valid.finalText, "authoritative");
  assert.equal(valid.metadata().events.agent_end, 1);
  assert.deepEqual(callbacks.slice(-3).map((event) => event.type), ["message_end", "agent_settled", "response"]);

  const validSummary = summarized.messagesSummary;
  const malformed = [
    { ...summarized, messages: [{ role: "user", content: "small" }] },
    { ...summarized, willRetry: "false" },
    { ...summarized, extra: true },
    { ...summarized, messagesSummary: { ...validSummary, version: 2 } },
    { ...summarized, messagesSummary: { ...validSummary, count: -1 } },
    { ...summarized, messagesSummary: { ...validSummary, count: 1.5 } },
    { ...summarized, messagesSummary: { ...validSummary, count: Number.MAX_SAFE_INTEGER + 1 } },
    { ...summarized, messagesSummary: { ...validSummary, bytes: -1 } },
    { ...summarized, messagesSummary: { ...validSummary, bytes: 1.5 } },
    { ...summarized, messagesSummary: { ...validSummary, bytes: Number.MAX_SAFE_INTEGER + 1 } },
    { ...summarized, messagesSummary: { ...validSummary, sha256: "A".repeat(64) } },
    { ...summarized, messagesSummary: { ...validSummary, extra: true } },
    ...(["version", "count", "bytes", "sha256"] as const).map((key) => {
      const summary = { ...validSummary };
      delete summary[key];
      return { ...summarized, messagesSummary: summary };
    }),
  ];
  for (const bad of malformed) {
    const dispatched: any[] = [];
    const observed = new JsonlObservation((event) => dispatched.push(event));
    observed.write(Buffer.from(JSON.stringify(bad) + "\n"));
    observed.end();
    assert.deepEqual(observed.metadata().lastParserError, { kind: "invalid_event", offset: 0 });
    assert.deepEqual(dispatched, []);
  }
});

test("producer-only aggregate contract keeps direct oversized records fatal", async () => {
  const { JsonlObservation } = await import("../src/subagent-runs.ts");
  const final = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "late final" }], stopReason: "stop" } };
  const records = [
    { type: "agent_end", messages: [{ role: "user", content: "x".repeat(10 * 1024 * 1024) }], willRetry: false },
    { type: "future_event", content: "x".repeat(10 * 1024 * 1024) },
    { type: "response", id: "oversized", success: true, data: "x".repeat(10 * 1024 * 1024) },
  ];
  for (const record of records) {
    const dispatched: any[] = [];
    const observed = new JsonlObservation((event) => dispatched.push(event));
    observed.write(Buffer.from(JSON.stringify(record) + "\n"));
    observed.write(Buffer.from(JSON.stringify(final) + "\n"));
    observed.write(Buffer.from(JSON.stringify({ type: "agent_settled" }) + "\n"));
    observed.end();
    assert.equal(observed.protocolError, true);
    assert.deepEqual(observed.metadata().firstParserError, { kind: "record_limit", offset: 0 });
    assert.equal(observed.metadata().parserErrorCounters.record_limit, 1);
    assert.deepEqual(dispatched.map((event) => event.type), ["message_end", "agent_settled"]);
    assert.equal(observed.finalText, "late final");
  }
  const malformed = new JsonlObservation();
  malformed.write(Buffer.from("x".repeat(10 * 1024 * 1024 + 1) + "\n"));
  malformed.write(Buffer.from(JSON.stringify(final) + "\n"));
  malformed.end();
  assert.equal(malformed.protocolError, true);
  assert.equal(malformed.metadata().parserErrorCounters.record_limit, 1);
  assert.equal(malformed.finalText, "late final");
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

    const protectedRoot = path.join(root, "protected-delivery");
    const protectedStore = new RunSnapshots(protectedRoot);
    const time = new Date().toISOString();
    const protectedCases = [
      { name: "pending", metadata: { closeAt: time, terminal: { processOutcome: "exited", exitCode: 0, signal: null }, deliveries: { ["d".repeat(64)]: { state: "pending", envelopeHash: "e".repeat(64) } } }, completed: true },
      { name: "enqueued", metadata: { closeAt: time, terminal: { processOutcome: "exited", exitCode: 0, signal: null }, deliveries: { ["1".repeat(64)]: { state: "observed", envelopeHash: "2".repeat(64) }, ["3".repeat(64)]: { state: "enqueued", envelopeHash: "4".repeat(64) } } }, completed: true },
      { name: "missing-proof", metadata: { closeAt: time, terminal: { processOutcome: "exited", exitCode: 0, signal: null }, deliveries: {} }, completed: true },
      { name: "unknown", metadata: { closeAt: time, terminal: { processOutcome: "exited", exitCode: 0, signal: null }, deliveries: { ["5".repeat(64)]: { state: "unknown", envelopeHash: "6".repeat(64) } } }, completed: true },
      { name: "dead-pid", metadata: { pid: 999999, starttime: "1", closeAt: time, terminal: { processOutcome: "exited", exitCode: 0, signal: null }, deliveries: { ["7".repeat(64)]: { state: "enqueued", envelopeHash: "8".repeat(64) } } }, completed: true },
      { name: "live-process", metadata: { pid: process.pid, starttime: "1", deliveries: { ["9".repeat(64)]: { state: "observed", envelopeHash: "a".repeat(64), observedAt: time } } }, completed: false },
    ];
    for (let i = 0; i < 40; i++) {
      const candidate = protectedCases[i % protectedCases.length]!;
      assert.equal(protectedStore.write("owner", `${candidate.name}-${i}`, { identity, ...candidate.metadata, rawTask: "raw-task-sentinel", prompt: "prompt-sentinel", result: "result-sentinel", secret: "secret-sentinel" }, candidate.completed).state, "available");
    }
    const protectedDir = path.join(protectedRoot, "sessions/subagent-runs");
    const before = Object.fromEntries(fs.readdirSync(protectedDir).filter((name: string) => name.endsWith(".json")).map((name: string) => [name, sha256(fs.readFileSync(path.join(protectedDir, name)))]));
    assert.deepEqual(protectedStore.write("owner", "overflow", { identity, deliveries: {} }, false), { state: "unavailable", code: "storage_limit" });
    const after = Object.fromEntries(fs.readdirSync(protectedDir).filter((name: string) => name.endsWith(".json")).map((name: string) => [name, sha256(fs.readFileSync(path.join(protectedDir, name)))]));
    assert.deepEqual(after, before);
    assert.doesNotMatch(fs.readdirSync(protectedDir).filter((name: string) => name.endsWith(".json")).map((name: string) => fs.readFileSync(path.join(protectedDir, name), "utf8")).join("\n"), /raw-task-sentinel|prompt-sentinel|result-sentinel|secret-sentinel/);

    const byteRoot = path.join(root, "protected-bytes");
    const byteStore = new RunSnapshots(byteRoot);
    for (let i = 0; i < 39; i++) assert.equal(byteStore.write("owner", `bytes-${i}`, { identity, closeAt: time, terminal: { processOutcome: "exited", exitCode: 0, signal: null }, deliveries: { [sha256(`held-${i}`)]: { state: "enqueued", envelopeHash: sha256(`held-envelope-${i}`) } } }, true).state, "available");
    const byteDir = path.join(byteRoot, "sessions/subagent-runs");
    for (const name of fs.readdirSync(byteDir).filter((name: string) => name.endsWith(".json"))) {
      const file = path.join(byteDir, name);
      const data = fs.readFileSync(file);
      fs.writeFileSync(file, Buffer.concat([data, Buffer.alloc(50 * 1024 - data.length, 0x20)]));
    }
    fs.writeFileSync(path.join(byteDir, "held-provenance.bin"), Buffer.alloc(100_000, 0x78));
    const byteFiles = fs.readdirSync(byteDir).filter((name: string) => name !== ".lock");
    const byteTotal = byteFiles.reduce((sum: number, name: string) => sum + fs.statSync(path.join(byteDir, name)).size, 0);
    assert.ok(byteTotal < 2 * 1024 * 1024);
    const byteBefore = Object.fromEntries(byteFiles.map((name: string) => [name, sha256(fs.readFileSync(path.join(byteDir, name)))]));
    assert.deepEqual(byteStore.write("owner", "bytes-overflow", { identity, deliveries: {} }, false), { state: "unavailable", code: "storage_limit" });
    const byteAfter = Object.fromEntries(fs.readdirSync(byteDir).filter((name: string) => name !== ".lock").map((name: string) => [name, sha256(fs.readFileSync(path.join(byteDir, name)))]));
    assert.deepEqual(byteAfter, byteBefore);

    const unknownRoot = path.join(root, "delivery-unknown");
    const unknownStore = new RunSnapshots(unknownRoot);
    for (let i = 0; i < 24; i++) assert.equal(unknownStore.write("owner", `unknown-${i}`, { identity, closeAt: time, terminal: { processOutcome: "exited", exitCode: 0, signal: null }, deliveries: { [sha256(`delivery-${i}`)]: { state: "delivery_unknown", envelopeHash: sha256(`envelope-${i}`), failedAt: time } } }, true).state, "available");
    assert.equal(fs.readdirSync(path.join(unknownRoot, "sessions/subagent-runs")).filter((name: string) => name.endsWith(".json")).length, 20);

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

test("ordinary lifecycle reserves before dispatch and cancellation keeps the first terminal claim", async () => {
  const runs = new ChildRuns("owner", "session");
  const ack = runs.admit("cancel", [{ agent: "worker", task: "work" }, { agent: "worker", task: "queued" }], cwd);
  const active = ack.children[0]!.identity;
  const queued = ack.children[1]!.identity;
  assert.deepEqual(runs.active().map((child) => child.identity.runId), [active.runId, queued.runId]);
  assert.equal(runs.start(active), true);
  assert.equal(runs.attachProcess(active, process.pid, "start"), true);
  const first = runs.requestCancel(active.runId, "tool_cancel");
  const repeat = runs.requestCancel(active.runId, "later_cancel");
  assert.equal(first.first, true);
  assert.equal(first.shouldSignal, true);
  assert.equal(repeat.first, false);
  assert.equal(repeat.result.cancellationInitiator, "tool_cancel");
  const claimed = runs.claimTerminal(active, "work", { processOutcome: "exited", exitCode: 0, signal: null, stopReason: "stop" }, "late clean output")!;
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.result.processOutcome, "cancelled");
  assert.equal(claimed.result.exitCode, 0);
  assert.equal(claimed.result.cancellationInitiator, "tool_cancel");
  assert.equal(claimed.result.payloadOutcome, "incomplete");
  assert.equal(runs.claimTerminal(active, "work", { processOutcome: "signaled", exitCode: null, signal: "SIGKILL", protocolError: true }, "bad")!.claimed, false);
  runs.completeCleanup(active);
  assert.equal((await first.completion).status, "cancelled");
  assert.equal(runs.settle(claimed.result), true);
  assert.equal(runs.requestCancel(active.runId, "third").result.status, "already_terminal");

  const queuedCancel = runs.requestCancel(queued.runId, "parent_cancel");
  assert.equal(queuedCancel.result.status, "cancellation_requested");
  assert.equal(runs.claimed(queued)?.processOutcome, "cancelled");
  runs.completeCleanup(queued);
  assert.equal((await queuedCancel.completion).terminal, true);
  assert.equal(runs.settle(runs.claimed(queued)!), true);
  assert.deepEqual(runs.batch("cancel")?.results.map((result) => result.identity.runId), [active.runId, queued.runId]);
  assert.deepEqual(runs.active(), []);
});

test("unconfirmed process identity releases cancellation wait and compact repeats retain only terminal facts", async () => {
  const runs = new ChildRuns("owner", "session");
  const identity = runs.admit("mismatch", [{ agent: "worker", task: "sensitive prompt" }], cwd).children[0]!.identity;
  assert.equal(runs.start(identity), true);
  assert.equal(runs.attachProcess(identity, process.pid, "stale-starttime"), true);
  const requested = runs.requestCancel(identity.runId, "tool_cancel");
  const unconfirmed = runs.markCancellationUnconfirmed(identity.runId, "process identity could not be verified for cancellation");
  assert.equal(unconfirmed.status, "cancellation_requested");
  assert.equal(unconfirmed.terminal, false);
  assert.match(unconfirmed.reason ?? "", /could not be verified/);
  assert.deepEqual(await requested.completion, unconfirmed);
  assert.equal(runs.requestCancel(identity.runId, "repeat").result.status, "cancellation_requested");
  const terminal = runs.claimTerminal(identity, "sensitive prompt", { processOutcome: "exited", exitCode: 0, signal: null, stopReason: "stop" }, "done")!.result;
  assert.equal(runs.completeCleanup(identity), true);
  assert.equal(runs.settle(terminal), true);
  assert.ok(runs.batch("mismatch"));
  assert.equal(runs.compactBatch("mismatch"), true);
  assert.equal(runs.batches.has("mismatch"), false);
  const retained = runs.children.get(identity.runId)! as any;
  assert.equal(retained.templateTask, undefined);
  assert.equal(retained.resolvedTask, undefined);
  assert.equal(retained.cleanupPromise, undefined);
  const terminalRepeat = runs.requestCancel(identity.runId, "after-terminal").result;
  assert.equal(terminalRepeat.status, "already_terminal");
  assert.equal(terminalRepeat.cancellationInitiator, "tool_cancel");

  const cleanupRuns = new ChildRuns("owner", "session");
  const cleanupIdentity = cleanupRuns.admit("cleanup", [{ agent: "worker", task: "prompt" }], cwd).children[0]!.identity;
  cleanupRuns.start(cleanupIdentity);
  const cleanupTerminal = cleanupRuns.claimTerminal(cleanupIdentity, "prompt", { processOutcome: "exited", exitCode: 0, signal: null, stopReason: "stop" }, "done")!.result;
  const pendingCleanupCancellation = cleanupRuns.requestCancel(cleanupIdentity.runId, "late-cancel");
  assert.equal(pendingCleanupCancellation.result.status, "cancellation_requested");
  assert.equal(pendingCleanupCancellation.waitForCleanup, true);
  cleanupRuns.markCancellationUnconfirmed(cleanupIdentity.runId, "temporary prompt cleanup could not be verified");
  const failedCleanupCancellation = await pendingCleanupCancellation.completion;
  assert.equal(failedCleanupCancellation.status, "cancellation_requested");
  assert.equal(failedCleanupCancellation.cancellationInitiator, undefined);
  assert.match(failedCleanupCancellation.reason ?? "", /cleanup could not be verified/);
  cleanupRuns.settle(cleanupTerminal);
  cleanupRuns.compactBatch("cleanup");
  const cleanupRepeat = cleanupRuns.requestCancel(cleanupIdentity.runId, "late-cancel").result;
  assert.equal(cleanupRepeat.status, "cancellation_requested");
  assert.equal(cleanupRepeat.cancellationInitiator, undefined);
  assert.match(cleanupRepeat.reason ?? "", /cleanup could not be verified/);
});

test("bulk shutdown excludes deferred chain remainder from explicit cancellation", () => {
  const runs = new ChildRuns("owner", "session");
  const ack = runs.admit("shutdown-chain", [{ agent: "worker", task: "first" }, { agent: "worker", task: "after {previous}" }], cwd);
  const first = ack.children[0]!.identity;
  const remainder = ack.children[1]!.identity;
  runs.defer(remainder);
  runs.start(first);
  assert.deepEqual(runs.shutdownActive().map((child) => child.identity.runId), [first.runId]);
  runs.requestCancel(first.runId, "session_shutdown");
  runs.resolveTask(remainder, "after cancelled predecessor");
  const result = runs.claimNoSpawn(remainder)!;
  assert.equal(result.processOutcome, "not_started");
  assert.equal(result.cancellationInitiator, undefined);
});

test("deferred chain cancellation waits for the actual resolved task and protocol errors win payload classification", async () => {
  const runs = new ChildRuns("owner", "session");
  const identity = runs.admit("chain-cancel", [{ agent: "worker", task: "after {previous}" }], cwd).children[0]!.identity;
  assert.equal(runs.defer(identity), true);
  const request = runs.requestCancel(identity.runId, "tool_cancel");
  assert.equal(request.waitForCleanup, false);
  assert.equal(request.result.status, "cancellation_requested");
  assert.equal(runs.claimed(identity), undefined);
  const resolved = "after actual predecessor output";
  assert.equal(runs.resolveTask(identity, resolved), true);
  const result = runs.claimNoSpawn(identity)!;
  assert.equal(result.actualTaskHash, (await import("../src/subagent-runs.ts")).sha256(resolved));
  assert.notEqual(result.actualTaskHash, identity.taskHash);
  runs.completeCleanup(identity);
  assert.equal(runs.settle(result), true);

  const protocolRuns = new ChildRuns("owner", "session");
  const protocolIdentity = protocolRuns.admit("protocol", [{ agent: "worker", task: "work" }], cwd).children[0]!.identity;
  protocolRuns.start(protocolIdentity);
  const cancel = protocolRuns.requestCancel(protocolIdentity.runId, "shutdown");
  const protocol = protocolRuns.claimTerminal(protocolIdentity, "work", { processOutcome: "signaled", exitCode: null, signal: "SIGTERM", protocolError: true }, "late")!.result;
  assert.equal(protocol.processOutcome, "cancelled");
  assert.equal(protocol.payloadOutcome, "protocol_error");
  protocolRuns.completeCleanup(protocolIdentity);
  assert.equal((await cancel.completion).status, "cancelled");
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
