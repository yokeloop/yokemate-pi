import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { ChildRuns, resultEnvelope, reviewerVerdict, PAYLOAD_LIMIT } from "../src/subagent-runs.ts";

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
