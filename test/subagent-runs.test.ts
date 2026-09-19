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

test("plan scouts require an explicit or stamped ticket and keep it in correlation identity", () => {
  assert.throws(() => new ChildRuns("owner", "session").admit("missing", [{ agent: "plan-scout", task: "scout" }], cwd), /ticket binding/);
  const stamped = new ChildRuns("owner", "session", "YM-1");
  const identity = stamped.admit("stamped", [{ agent: "plan-scout", task: "scout" }], cwd).children[0]!.identity;
  assert.equal(identity.ticket, "YM-1");
  assert.throws(() => stamped.admit("foreign", [{ agent: "plan-scout", task: "scout", ticket: "YM-2" }], cwd), /differs/);
  const problem = new ChildRuns("owner", "session").admit("problem", [{ agent: "plan-scout", task: "scout", ticket: "YM-3" }], cwd);
  assert.equal(problem.children[0]!.identity.ticket, "YM-3");
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

test("oversized aggregate validator accepts complete JSON only", async () => {
  const { JsonlAggregateValidator } = await import("../src/jsonl-aggregate.ts");
  const validate = (input: string | Buffer, split = 1) => {
    const validator = new JsonlAggregateValidator();
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
    for (let offset = 0; offset < bytes.length; offset += split) validator.write(Buffer.from(bytes.subarray(offset, offset + split)));
    return { accepted: validator.finish(), rejected: validator.rejected };
  };
  for (const input of [
    '{"type":"agent_end"}',
    '{"payload":{"array":[true,false,null,-12.5e+2]},"t\\u0079pe":"agent\\u005fend"}',
    '{"x":"\\ud800","type":"agent_end"}',
    '{"x":"é日🙂","type":"agent_end"}',
  ]) assert.deepEqual(validate(input), { accepted: true, rejected: false }, input);
  for (const input of [
    '[]', '{"nested":{"type":"agent_end"}}', '{"x":"type agent_end"}', '{"type":1}',
    '{"type":"unknown"}', '{"type":"agent_end","type":"agent_end"}', '{"type":"unknown","t\\u0079pe":"agent_end"}',
    '{"type":"agent_end",}', '{"type":"agent_end"}x', '{"x":01,"type":"agent_end"}',
    '{"x":1.,"type":"agent_end"}', '{"x":1e,"type":"agent_end"}', '{"x":tru,"type":"agent_end"}',
    '{"x":"bad\\q","type":"agent_end"}', '{"x":"bad\u0001","type":"agent_end"}', '{"type":"agent_end"',
  ]) assert.equal(validate(input).accepted, false, input);
  for (const invalid of [Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc0, 0x80, 0x22, 0x7d]), Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xf4, 0x90, 0x80, 0x80, 0x22, 0x7d])]) {
    assert.equal(validate(invalid, 2).accepted, false);
  }
  const depth256 = '{"x":' + '['.repeat(255) + '0' + ']'.repeat(255) + ',"type":"agent_end"}';
  const depth257 = '{"x":' + '['.repeat(256) + '0' + ']'.repeat(256) + ',"type":"agent_end"}';
  assert.equal(validate(depth256, 3).accepted, true);
  assert.equal(validate(depth257, 3).accepted, false);
});

test("oversized aggregate validator retains bounded state", async () => {
  const { JsonlAggregateValidator } = await import("../src/jsonl-aggregate.ts");
  for (const size of [1024 * 1024 + 1, 10 * 1024 * 1024 + 1]) {
    const validator = new JsonlAggregateValidator();
    validator.write(Buffer.from('{"payload":"'));
    const reusable = Buffer.alloc(8191, 0x78);
    let written = 0;
    while (written < size) { validator.write(reusable); written += reusable.length; }
    const retained = Object.values(validator as any);
    assert.ok(((validator as any).stack as unknown[]).length <= 256);
    assert.ok(retained.every((value) => !Buffer.isBuffer(value) && !Array.isArray(value) || value === (validator as any).stack));
    assert.ok(!retained.includes(reusable));
    assert.ok(retained.filter((value) => typeof value === "string").every((value) => (value as string).length < 32));
    validator.write(Buffer.from('","type":"agent_end"}'));
    assert.equal(validator.finish(), true);
  }
});

test("JSONL discards oversized agent_end and continues", async () => {
  const { JsonlObservation } = await import("../src/subagent-runs.ts");
  for (const [record, chunkSize] of [
    ['{"type":"agent_end","payload":"' + 'x'.repeat(1024 * 1024) + '"}', 1],
    ['{"payload":"' + 'é'.repeat(5 * 1024 * 1024) + '","t\\u0079pe":"agent\\u005fend"}', 8191],
  ] as const) {
    const callbacks: any[] = [];
    const observed = new JsonlObservation((event) => callbacks.push(event));
    const suffix = [
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final" }], stopReason: "stop" } },
      { type: "agent_settled" }, { type: "response", id: "next", success: true },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n";
    const bytes = Buffer.from(record + "\n" + suffix);
    for (let offset = 0; offset < bytes.length; offset += chunkSize) observed.write(bytes.subarray(offset, offset + chunkSize));
    observed.end();
    assert.equal(observed.protocolError, false);
    assert.equal(observed.finalText, "final");
    assert.equal(observed.metadata().events.agent_end, 1);
    assert.equal(observed.metadata().parserErrors, 0);
    assert.deepEqual(callbacks.map((event) => event.type), ["message_end", "agent_settled", "response"]);
  }
});

test("JSONL oversized exception is fail closed", async () => {
  const { JsonlObservation } = await import("../src/subagent-runs.ts");
  const padding = '"x":"' + "x".repeat(1024 * 1024) + '"';
  const records = [
    `{"type":"unknown",${padding}}`, `{"type":"response",${padding}}`, `{"type":"message_end",${padding}}`,
    `{"type":"entry_appended",${padding}}`, `{"nested":{"type":"agent_end"},${padding}}`,
    `{"type":"agent_end",${padding},"type":"agent_end"}`, `{"type":"agent_end",${padding}}garbage`,
    `{"type":"agent_end",${padding.slice(0, -1)}}`, '[' + '"x",'.repeat(600000) + '0]',
  ];
  for (const record of records) {
    const callbacks: any[] = [];
    const observed = new JsonlObservation((event) => callbacks.push(event));
    observed.write(Buffer.from(record + "\n" + JSON.stringify({ type: "agent_settled" }) + "\n"));
    observed.end();
    assert.equal(observed.protocolError, true, record.slice(0, 80));
    assert.equal(observed.metadata().lastParserError?.kind, "record_limit");
    assert.deepEqual(callbacks.map((event) => event.type), ["agent_settled"]);
  }
});

test("JSONL oversized framing preserves metadata and bounded storage", async () => {
  const { JsonlObservation } = await import("../src/subagent-runs.ts");
  const sentinel = "private-oversized-sentinel";
  const record = Buffer.from(JSON.stringify({ payload: sentinel + "x".repeat(1024 * 1024), type: "agent_end" }));
  const expectedHash = (await import("node:crypto")).createHash("sha256").update(record).digest("hex");
  const observed = new JsonlObservation();
  for (let offset = 0; offset < record.length; offset += 8191) {
    observed.write(Buffer.from(record.subarray(offset, offset + 8191)));
    const state = observed as any;
    assert.ok((state.prefix?.length ?? 0) <= 1024 * 1024);
    if (state.aggregate) assert.equal(state.prefix, undefined);
  }
  assert.equal(observed.metadata().partialBytes, record.length);
  assert.equal(observed.metadata().partialHash, expectedHash);
  observed.end();
  assert.equal(observed.protocolError, true);
  assert.equal(observed.metadata().lastParserError?.kind, "partial_record");
  assert.doesNotMatch(JSON.stringify(observed.metadata()), new RegExp(sentinel));

  for (const size of [1024 * 1024 - 1, 1024 * 1024, 1024 * 1024 + 1]) {
    const value = '{"type":"agent_end","x":"' + "x".repeat(Math.max(0, size - 27)) + '"}';
    const exact = Buffer.from(value.length > size ? value.slice(0, size) : value.padEnd(size, " "));
    const sample = new JsonlObservation();
    sample.write(Buffer.concat([exact, Buffer.from("\n")]));
    sample.end();
    assert.equal(sample.metadata().stdoutBytes, size + 1);
  }
  const small = new JsonlObservation();
  small.write(Buffer.from('{"type":"unknown","type":"agent_end"}\n'));
  small.write(Buffer.from('{"type":"unknown","x":"\ud800"}\n'));
  small.end();
  assert.equal(small.protocolError, false);
  assert.equal(small.metadata().events.agent_end, 1);
  assert.equal(small.metadata().events.other, 1);
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

test("metadata snapshots are private, bounded, retain active runs and survive write/rename/prune faults", async () => {
  const fs = (await import("node:fs")).default;
  const path = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { RunSnapshots, errorMetadata } = await import("../src/subagent-runs.ts");
  const root = fs.mkdtempSync(path.join(tmpdir(), "ym204-snapshots-"));
  const folder = path.join(root, "home/knowledge/org/repo/ai/task");
  fs.mkdirSync(folder, { recursive: true });
  const plan = path.join(folder, "plan.md");
  fs.writeFileSync(plan, "plan");
  const dir = path.join(folder, "reviewer-runs");
  try {
    const snapshots = new RunSnapshots(root, plan);
    assert.equal(snapshots.write("owner", "active", { error: errorMetadata(new Error("private credentials")) }, false), true);
    for (let i = 0; i < 24; i++) assert.equal(snapshots.write("owner", `run-${i}`, {}, true), true);
    assert.equal(fs.readdirSync(dir).length, 21);
    const active = fs.readFileSync(path.join(dir, "owner-active.json"), "utf8");
    assert.doesNotMatch(active, /private credentials/);
    assert.equal(fs.statSync(path.join(dir, "owner-active.json")).mode & 0o777, 0o600);
    for (const method of ["writeFileSync", "renameSync", "unlinkSync"] as const) {
      const writer = new RunSnapshots(root, plan);
      assert.equal(writer.write("owner", `fill-${method}`, {}, true), true);
      const original = fs[method];
      (fs as any)[method] = () => { throw new Error("injected private failure"); };
      try { assert.equal(writer.write("owner", `fault-${method}`, {}, true), false); }
      finally { (fs as any)[method] = original; }
    }
    assert.equal(fs.existsSync(path.join(dir, "owner-active.json")), true);
    assert.throws(() => new RunSnapshots(root, path.join(root, "plan.md")), /invalid reviewer/);
    const limit = new RunSnapshots(root, plan);
    assert.equal(limit.write("owner", "oversize", { tooLarge: "x".repeat(PAYLOAD_LIMIT) }, true), false);
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
    assert.ok(results.every((result) => result.payloadOutcome === (character === "x" ? "valid" : "output_limit")));
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
  assert.equal(runs.children.size, 0);
  assert.equal(runs.batches.size, 0);
});
