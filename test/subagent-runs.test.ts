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
