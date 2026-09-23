import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { coordinatorArtifactId, DIAGNOSTICS_FILE_LIMIT, REPORT_DIRECTORY_LIMIT, REPORT_FILE_LIMIT, REPORT_RETENTION_MS, SubagentReportStore } from "../src/subagent-report-store.ts";
import { RunSnapshots, sha256 } from "../src/subagent-runs.ts";

function sandbox() {
  const root = fs.mkdtempSync(path.join(tmpdir(), "ym217-store-"));
  const reports = path.join(root, ".pi", "subagent-reports");
  return { root, reports, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const id = (value: string) => sha256(value);
const sizedFacts = (bytes: number) => {
  const child = { actualTaskHash: id("diagnostic-budget") };
  return { children: Array.from({ length: Math.ceil(bytes / (JSON.stringify(child).length + 1)) }, () => child) };
};

test("store preserves canonical bytes, structured diagnostics and private permissions", () => {
  const box = sandbox();
  try {
    const store = new SubagentReportStore(box.reports);
    const canonical = Buffer.from("Unicode 🙂\r\ncanonical\n", "utf8");
    const result = store.writeReport(id("one"), canonical, { identity: { runId: "run" }, stream: { events: { message_end: 1 }, parserErrors: 0 }, stderr: { bytes: 12, hash: id("stderr") }, messages: ["private raw sentinel"], finalText: "private raw sentinel", rpcEvents: ["private raw sentinel"] });
    assert.equal(result.ok, true);
    const stored = store.readReport(id("one"))!;
    assert.deepEqual(stored.report, canonical);
    assert.equal((stored.diagnostics.canonical as any).bytes, canonical.length);
    assert.equal((stored.diagnostics.canonical as any).hash, sha256(canonical));
    assert.doesNotMatch(JSON.stringify(stored.diagnostics), /private raw sentinel/);
    assert.equal((stored.diagnostics.diagnostics as any).stream.events.message_end, 1);
    assert.equal(fs.statSync(box.reports).mode & 0o777, 0o700);
    assert.equal(fs.statSync(result.archive.reportPath!).mode & 0o777, 0o600);
    assert.equal(fs.statSync(result.archive.diagnosticsPath!).mode & 0o777, 0o600);
  } finally { box.cleanup(); }
});

test("D02 diagnostic writes and updates project facts without raw or unknown nested extras", () => {
  const box = sandbox();
  try {
    const store = new SubagentReportStore(box.reports);
    const key = id("projection");
    const raw = "SAFE SENTINEL task prompt tool secret-like content";
    const extras = { requestedTask: raw, prompt: raw, toolArguments: { input: raw }, secret: raw, unknown: { nested: raw } };
    const identity = { ownerRunId: "owner", ownerSessionId: "session", runId: "run", batchId: "batch", agent: "plan-writer", taskHash: id(raw), ticket: "YM-1", acceptedInputId: 1, ...extras };
    const stream = { stdoutBytes: 12, stdoutHash: id("stdout"), events: { message_end: 1 }, parserErrors: 0, parserErrorCounters: { invalid_json: 0, invalid_event: 0, record_limit: 0, partial_record: 0 }, parsedBytes: 11, malformedBytes: 0, ignoredBytes: 0, framingBytes: 1, partialBytes: 0, partialHash: id(""), assistantMessageSeen: true, assistantMessageEndCount: 1, assistantTextBearingCount: 0, textDeltaEvents: 1, textDeltaBytes: 2, finalEventPresent: true, finalTextPresent: false, finalNonWhitespace: false, finalTextBytes: 0, finalTextHash: id(""), activeTools: 0, retry: false, compaction: false, summaryRetry: false, phase: "text" };
    const writerResult = { state: "verified", source: "reconciled", binding: { ticket: "YM-1", path: "/safe/YM-1-plan.md", repositories: ["org/repo"], scopeHash: id("scope"), contentHash: id("content") }, artifactBytes: 42 };
    const metadata = { identity, taskHash: id(raw), actualTaskHash: id(raw), launch: { path: "/local/pi", hash: id("pi"), ...extras },
      terminal: { processOutcome: "cancelled", exitCode: 143, signal: "SIGTERM", ...extras }, stream,
      stderr: { class: "unknown", bytes: 42, hash: id("stderr"), ...extras },
      payload: { outcome: "valid", bytes: 0, hash: id(""), retainedBytes: 19, retainedHash: id("/safe/YM-1-plan.md"), truncated: false }, writerResult,
      scoutCandidate: { id: id("candidate"), hash: id(raw), bytes: 42, failureHash: id("failure"), ...extras },
      deliveries: { [id("delivery")]: { state: "delivery_failed", envelopeHash: id("envelope"), ...extras } }, ...extras };
    const facts = { identity, children: [{ identity, processOutcome: "cancelled", actualTaskHash: id(raw), payloadOutcome: "valid", planResult: writerResult, metadata, ...extras }],
      process: { ...metadata, exitCode: 143 }, terminal: { outcome: "blocked", summary: raw, reason: raw, verification: { state: "blocked", reason: raw }, ...extras },
      delivery: { deliveryId: id("delivery"), state: "delivery_failed", ...extras }, ...extras };
    assert.equal(store.writeReport(key, raw, facts).ok, true);
    for (const state of ["delivery_failed", "observed"]) {
      assert.equal(store.updateDiagnostics(key, { ...facts, delivery: { ...facts.delivery, state } }).ok, true);
      const stored = store.readReport(key)!;
      assert.equal(stored.report.toString(), raw);
      assert.doesNotMatch(JSON.stringify(stored.diagnostics), /SAFE SENTINEL|requestedTask|toolArguments|\"unknown\":|secret|prompt/);
      const projected = stored.diagnostics.diagnostics as any;
      assert.equal(projected.children[0].identity.taskHash, id(raw));
      assert.equal(projected.children[0].metadata.launch.hash, id("pi"));
      assert.equal(projected.children[0].metadata.scoutCandidate.failureHash, id("failure"));
      assert.equal(projected.children[0].planResult.source, "reconciled");
      assert.equal(projected.children[0].metadata.writerResult.binding.contentHash, id("content"));
      assert.equal(projected.children[0].metadata.stream.finalTextBytes, 0);
      assert.equal(projected.children[0].metadata.payload.truncated, false);
      assert.equal(projected.process.exitCode, 143);
      assert.equal(projected.delivery.state, state);
      assert.equal(projected.terminal.outcome, "blocked");
    }
    const snapshots = new RunSnapshots(box.root);
    assert.equal(snapshots.write("owner", "run", metadata, true).state, "available");
    const snapshot = fs.readFileSync(path.join(snapshots.directory, "owner-run.json"), "utf8");
    assert.doesNotMatch(snapshot, /SAFE SENTINEL|requestedTask|toolArguments|secret|prompt/);
    const projectedSnapshot = JSON.parse(snapshot) as any;
    assert.equal(projectedSnapshot.writerResult.source, "reconciled");
    assert.equal(projectedSnapshot.writerResult.contentHash, id("content"));
    assert.equal(projectedSnapshot.stream.textDeltaBytes, 2);
    assert.equal(projectedSnapshot.payload.truncated, false);
  } finally { box.cleanup(); }
});

test("writes are idempotent, conflicts fail, and diagnostics updates never change canonical", () => {
  const box = sandbox();
  try {
    const store = new SubagentReportStore(box.reports);
    const key = id("same");
    assert.equal(store.writeReport(key, "one", { delivery: { state: "pending" } }).ok, true);
    assert.equal(store.writeReport(key, "one", { delivery: { state: "observed" } }).ok, true);
    assert.equal(store.writeReport(key, "two", {}).code, "artifact_conflict");
    assert.equal(store.updateDiagnostics(key, { delivery: { state: "observed" } }).ok, true);
    const read = store.readReport(key)!;
    assert.equal(read.report.toString(), "one");
    assert.equal((read.diagnostics.diagnostics as any).delivery.state, "observed");
    fs.writeFileSync(read.archive.reportPath!, "tampered");
    assert.equal(store.readReport(key), undefined);
  } finally { box.cleanup(); }
});

test("retention removes expired and oldest artifacts without resurrecting updates", () => {
  const box = sandbox();
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  try {
    const store = new SubagentReportStore(box.reports, { now: () => now });
    const expired = id("expired");
    assert.equal(store.writeReport(expired, "old", {}).ok, true);
    now += REPORT_RETENTION_MS + 1;
    assert.equal(store.writeReport(id("fresh"), "fresh", {}).ok, true);
    assert.equal(store.readReport(expired), undefined);
    assert.equal(store.updateDiagnostics(expired, {}).archive.state, "expired");
    for (let index = 0; index < REPORT_DIRECTORY_LIMIT + 1; index++) {
      now += 1;
      assert.equal(store.writeReport(id(`rotation-${index}`), `report-${index}`, {}).ok, true);
    }
    const directories = fs.readdirSync(box.reports).filter((name) => /^[a-f0-9]{64}$/.test(name));
    assert.equal(directories.length, REPORT_DIRECTORY_LIMIT);
    assert.equal(store.readReport(id("fresh")), undefined);
  } finally { box.cleanup(); }
});

test("limits, symlinks, unknown objects and live locks fail closed without partial pairs", () => {
  const box = sandbox();
  try {
    const store = new SubagentReportStore(box.reports, { pid: 123, processStarttime: (pid) => pid === 123 ? "self" : pid === 999 ? "live" : undefined });
    assert.equal(store.writeReport(id("large-report"), Buffer.alloc(REPORT_FILE_LIMIT + 1), {}).code, "storage_limit");
    assert.equal(store.writeReport(id("large-diagnostics"), "ok", sizedFacts(DIAGNOSTICS_FILE_LIMIT)).code, "storage_limit");
    assert.equal(fs.readdirSync(box.reports).filter((name) => name.startsWith(".tmp-")).length, 0);
    fs.writeFileSync(path.join(box.reports, ".lock"), JSON.stringify({ pid: 999, starttime: "live" }));
    assert.equal(store.writeReport(id("busy"), "busy", {}).code, "storage_busy");
    fs.unlinkSync(path.join(box.reports, ".lock"));
    fs.writeFileSync(path.join(box.reports, "foreign"), "do not delete");
    assert.equal(store.writeReport(id("foreign-block"), "report", {}).code, "artifact_invalid");
    assert.equal(fs.readFileSync(path.join(box.reports, "foreign"), "utf8"), "do not delete");
  } finally { box.cleanup(); }

  const linked = sandbox();
  const target = fs.mkdtempSync(path.join(tmpdir(), "ym217-target-"));
  try {
    fs.mkdirSync(path.dirname(linked.reports), { recursive: true });
    fs.symlinkSync(target, linked.reports);
    assert.equal(new SubagentReportStore(linked.reports).writeReport(id("linked"), "report", {}).ok, false);
  } finally { linked.cleanup(); fs.rmSync(target, { recursive: true, force: true }); }

  const linkedParent = sandbox();
  const parentTarget = fs.mkdtempSync(path.join(tmpdir(), "ym217-parent-target-"));
  try {
    fs.symlinkSync(parentTarget, path.join(linkedParent.root, ".pi"));
    assert.equal(new SubagentReportStore(linkedParent.reports).writeReport(id("linked-parent"), "report", {}).code, "artifact_invalid");
    assert.equal(fs.existsSync(path.join(parentTarget, "subagent-reports")), false);
  } finally { linkedParent.cleanup(); fs.rmSync(parentTarget, { recursive: true, force: true }); }
});

test("diagnostics updates evict older artifacts to reserve temporary disk budget", () => {
  const box = sandbox();
  try {
    const store = new SubagentReportStore(box.reports);
    const keys = Array.from({ length: 17 }, (_, index) => id(`budget-${index}`));
    for (const key of keys) assert.equal(store.writeReport(key, Buffer.alloc(REPORT_FILE_LIMIT - 1), sizedFacts(900_000)).ok, true);
    assert.equal(store.updateDiagnostics(keys.at(-1)!, sizedFacts(1_500_000)).ok, true);
    assert.ok(store.readReport(keys.at(-1)!));
    assert.ok(fs.readdirSync(box.reports).filter((name) => /^[a-f0-9]{64}$/.test(name)).length < keys.length);
  } finally { box.cleanup(); }
});

test("stale lock is recovered only with a provably absent owner and coordinator ids are stable", () => {
  const box = sandbox();
  try {
    fs.mkdirSync(box.reports, { recursive: true });
    fs.writeFileSync(path.join(box.reports, ".lock"), JSON.stringify({ pid: 99999999, starttime: "gone" }));
    const store = new SubagentReportStore(box.reports, { pid: 123, processStarttime: (pid) => pid === 123 ? "self" : undefined });
    assert.equal(store.writeReport(id("after-crash"), "ok", {}).ok, true);
    assert.equal(fs.existsSync(path.join(box.reports, ".lock")), false);
    assert.equal(coordinatorArtifactId("parent", "run"), coordinatorArtifactId("parent", "run"));
    assert.notEqual(coordinatorArtifactId("parent", "run"), coordinatorArtifactId("parent", "other"));
  } finally { box.cleanup(); }
});
