import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildReportDisplay, isReportDisplay, reportBrief, reportDisplayBudgets, reportFailureReason, reportTaskExcerpt, SubagentReportLine, subagentReportRenderer } from "../src/subagent-report.ts";
import { SubagentReportStore } from "../src/subagent-report-store.ts";
import { ChildRuns, resultEnvelope, sha256 } from "../src/subagent-runs.ts";

const cwd = process.cwd();
const task = { agent: "worker", task: "inspect\nfull\tchange\u001b[31m privately", cwd };
const clean = { processOutcome: "exited" as const, exitCode: 0, signal: null, stopReason: "stop" };

function result(text = "first line\nsecond line") {
  const identity = new ChildRuns("owner", "session").admit("batch", [task], cwd).children[0]!.identity;
  return resultEnvelope(identity, task.task, clean, text);
}

initTheme("dark", false);
const theme = { fg: (_color: string, text: string) => text } as any;

test("briefs and concrete failure reasons are display-only and bounded", () => {
  const finding = (severity: "blocking" | "advice") => ({ severity, lens: 1, file: "src/a.ts", line: 1, problem: "problem", evidence: "evidence", fix: "fix" });
  assert.equal(reportBrief(JSON.stringify({ status: "changes_required", findings: [finding("blocking"), finding("advice")] })), "2 findings, 1 blocking");
  assert.equal(reportBrief("\u001b[31mfirst\r\nsecond"), "first");
  const base = result();
  const classes = [
    [{ ...base, processOutcome: "cancelled" as const, payloadOutcome: "incomplete" as const }, { cancellationInitiator: "parent" }, "cancelled by parent"],
    [{ ...base, processOutcome: "signaled" as const, signal: "SIGTERM", payloadOutcome: "incomplete" as const }, {}, "signal SIGTERM"],
    [{ ...base, processOutcome: "spawn_error" as const, payloadOutcome: "incomplete" as const }, { spawnError: { class: "ENOENT" } }, "spawn ENOENT"],
    [{ ...base, processOutcome: "exited" as const, exitCode: 7, payloadOutcome: "incomplete" as const }, {}, "exit 7"],
    [{ ...base, payloadOutcome: "protocol_error" as const }, { stream: { parserErrors: 2, lastParserError: { kind: "invalid_json", offset: 12 } } }, "protocol_error: invalid_json at byte 12 (2 parser errors)"],
    [{ ...base, payloadOutcome: "output_limit" as const, outputLimit: "batch_transport" as const }, {}, "output limit: batch_transport"],
    [{ ...base, processOutcome: "not_started" as const, payloadOutcome: "incomplete" as const }, {}, "not started"],
  ] as const;
  for (const [envelope, facts, expected] of classes) assert.equal(reportFailureReason(envelope, facts), expected);
  const recovery = { ...base, recovery: { sourceTransport: "failed" as const, state: "candidate" as const, candidateId: "candidate-id", failureHash: "a".repeat(64), payloadHash: "b".repeat(64), bytes: 42 } };
  assert.equal(buildReportDisplay(recovery, new Map(), Date.now()).brief, "transport failed; recovery candidate candidate-id; publication not-started");
});

test("display snapshots preserve envelopes, normalize controls and fit JSON budgets", () => {
  const envelope = result("🙂".repeat(1000));
  const before = structuredClone(envelope);
  const admission = new Map([[envelope.identity.runId, { startedAt: 100, taskExcerpt: task.task }]]);
  const display = buildReportDisplay(envelope, admission, 4100, { state: "available", reportPath: "/tmp/report.txt", diagnosticsPath: "/tmp/diagnostics.json", reportBytes: 10, reportHash: "a".repeat(64), retentionDays: 7 });
  assert.deepEqual(envelope, before);
  assert.equal(display.durationMs, 4000);
  assert.doesNotMatch(display.taskExcerpt!, /\n|\t|\x1b/);
  assert.ok(Buffer.byteLength(JSON.stringify({ display: { ...display, members: [] } })) <= reportDisplayBudgets.base);
  assert.ok((display.members ?? []).every((member) => Buffer.byteLength(JSON.stringify(member)) <= reportDisplayBudgets.member));
  assert.equal(isReportDisplay(display), true);
  assert.equal(isReportDisplay({ version: 1, kind: "result", archive: { state: "broken" } }), false);
});

test("task excerpts normalize the full input before applying the 24-code-unit bound", () => {
  assert.equal(reportTaskExcerpt(`${"\0".repeat(24)}visible task`), "visible task");
  assert.equal(reportTaskExcerpt(`\u001b[31mline one\nline two`), "line one line two");
});

test("collapsed line stays in every viewport and recalculates after resize", () => {
  const line = new SubagentReportLine("worker · result abcdef12 · approved · 0:04 · 🙂 wide e\u0301 text · to expand", 3);
  for (const width of [0, 1, 2, 3, 40, 80, 120]) {
    const rendered = line.render(width);
    assert.equal(rendered.length, 1);
    assert.ok(visibleWidth(rendered[0]!) <= Math.max(0, width), `${width}: ${JSON.stringify(rendered)}`);
  }
  assert.ok(visibleWidth(line.render(80)[0]!) > visibleWidth(line.render(2)[0]!));
  assert.ok(visibleWidth(line.render(120)[0]!) >= visibleWidth(line.render(40)[0]!));
  line.invalidate();
  assert.ok(visibleWidth(line.render(40)[0]!) <= 40);
});

test("aggregate members retain their own settlement durations", () => {
  const runs = new ChildRuns("owner", "session");
  const ack = runs.admit("batch", [{ ...task, task: "first" }, { ...task, task: "second" }], cwd);
  const results = ack.children.map(({ identity }, index) => resultEnvelope(identity, index ? "second" : "first", clean, "done"));
  const envelope = { version: 1 as const, kind: "batch" as const, ownerRunId: "owner", ownerSessionId: "session", batchId: "batch", results };
  const admissions = new Map(results.map((entry, index) => [entry.identity.runId, { startedAt: index * 100, taskExcerpt: index ? "second" : "first" }]));
  const settlements = new Map([[results[0]!.identity.runId, 1000], [results[1]!.identity.runId, 3000]]);
  const display = buildReportDisplay(envelope, admissions, settlements);
  assert.deepEqual(display.members?.map((member) => member.durationMs), [1000, 2900]);
  assert.equal(display.durationMs, 3000);
});

test("expanded renderer rejects archive integrity failures but keeps canonical content", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ym217-render-archive-"));
  try {
    const store = new SubagentReportStore(path.join(directory, "reports"));
    const canonical = "canonical body tail";
    const stored = store.writeReport(sha256("renderer archive"), canonical, {});
    assert.equal(stored.ok, true);
    const envelope = result(canonical);
    const display = buildReportDisplay(envelope, new Map([[envelope.identity.runId, { startedAt: 0, taskExcerpt: "task" }]]), 1, stored.archive);
    const message = { role: "custom", customType: "subagent-report", content: canonical, display: true, timestamp: 0, details: { envelope, display } } as any;
    const available = subagentReportRenderer(message, { expanded: true, outputPad: 0 }, theme)!.render(120).join("\n");
    assert.match(available, /report\.txt:/);
    fs.writeFileSync(stored.archive.reportPath!, "tampered");
    const invalid = subagentReportRenderer(message, { expanded: true, outputPad: 0 }, theme)!.render(120).join("\n");
    assert.match(invalid, /diagnostics expired\/unavailable/);
    assert.match(invalid, /canonical body tail/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("expanded result and chain render structured status and multiline payloads without transport JSON", () => {
  const runs = new ChildRuns("owner", "session");
  const ack = runs.admit("chain", [{ ...task, task: "first task" }, { ...task, task: "second task" }, { ...task, task: "skipped task" }], cwd);
  const first = resultEnvelope(ack.children[0]!.identity, "first task", clean, "FIRST UNIQUE\nfirst tail");
  const second = resultEnvelope(ack.children[1]!.identity, "second task", clean, "SECOND UNIQUE\nsecond tail");
  const skipped = resultEnvelope(ack.children[2]!.identity, "skipped task", { processOutcome: "not_started", exitCode: null, signal: null }, "");
  const admissions = new Map(ack.children.map(({ identity }, index) => [identity.runId, { startedAt: index, taskExcerpt: `${index + 1} task`, ordinal: index + 1 }]));

  const resultCanonical = `[subagent worker] ${JSON.stringify({ version: 1, deliveryId: "result-delivery", envelope: first })}`;
  const resultMessage = { role: "custom", customType: "subagent-report", content: resultCanonical, display: true, timestamp: 0, details: { envelope: first, display: buildReportDisplay(first, admissions, 10) } } as any;
  const expandedResult = subagentReportRenderer(resultMessage, { expanded: true, outputPad: 0 }, theme)!.render(120).map((line) => line.trimEnd()).join("\n");
  assert.match(expandedResult, /process: exited · exit 0/);
  assert.match(expandedResult, /payload: valid/);
  assert.match(expandedResult, /FIRST UNIQUE\nfirst tail/);
  assert.doesNotMatch(expandedResult, /result-delivery|"envelope"/);
  assert.equal(resultMessage.content, resultCanonical);

  const chain = { version: 1 as const, kind: "chain" as const, ownerRunId: "owner", ownerSessionId: "session", batchId: "chain", results: [first, second, skipped] };
  const chainCanonical = `[subagent chain] ${JSON.stringify({ version: 1, deliveryId: "chain-delivery", envelope: chain })}`;
  const chainMessage = { role: "custom", customType: "subagent-report", content: chainCanonical, display: true, timestamp: 0, details: { envelope: chain, display: buildReportDisplay(chain, admissions, new Map(ack.children.map(({ identity }, index) => [identity.runId, 10 + index]))) } } as any;
  const expandedChain = subagentReportRenderer(chainMessage, { expanded: true, outputPad: 0 }, theme)!.render(120).map((line) => line.trimEnd()).join("\n");
  assert.match(expandedChain, /step #1 · worker · .* · done/);
  assert.match(expandedChain, /FIRST UNIQUE\nfirst tail/);
  assert.match(expandedChain, /step #2 · worker · .* · done/);
  assert.match(expandedChain, /SECOND UNIQUE\nsecond tail/);
  assert.match(expandedChain, /step #3 · worker · .* · not_started/);
  assert.doesNotMatch(expandedChain, /chain-delivery|"envelope"/);
});

test("expanded batches summarize members without repeating result or chain payloads", () => {
  const runs = new ChildRuns("owner", "session");
  const singleAck = runs.admit("single", [{ ...task, task: "single task" }], cwd);
  const single = resultEnvelope(singleAck.children[0]!.identity, "single task", clean, "EXACT SINGLE PAYLOAD");
  const chainAck = runs.admit("chain-summary", [{ ...task, task: "chain first" }, { ...task, task: "chain skipped" }], cwd);
  const chainFirst = resultEnvelope(chainAck.children[0]!.identity, "chain first", clean, "EXACT CHAIN PAYLOAD");
  const chainSkipped = resultEnvelope(chainAck.children[1]!.identity, "chain skipped", { processOutcome: "not_started", exitCode: null, signal: null }, "");
  const singleBatch = { version: 1 as const, kind: "batch" as const, ownerRunId: "owner", ownerSessionId: "session", batchId: "single", results: [single] };
  const chain = { version: 1 as const, kind: "chain" as const, ownerRunId: "owner", ownerSessionId: "session", batchId: "chain-summary", results: [chainFirst, chainSkipped] };
  const chainBatch = { ...chain, kind: "batch" as const };
  const admissions = new Map([
    [single.identity.runId, { startedAt: 0, taskExcerpt: "single task", ordinal: 1 }],
    [chainFirst.identity.runId, { startedAt: 0, taskExcerpt: "chain first", ordinal: 1 }],
    [chainSkipped.identity.runId, { startedAt: 0, taskExcerpt: "chain skipped", ordinal: 2 }],
  ]);
  const settlements = new Map([[single.identity.runId, 1000], [chainFirst.identity.runId, 2000], [chainSkipped.identity.runId, 3000]]);
  const expand = (envelope: typeof single | typeof singleBatch | typeof chain) => {
    const canonical = `[transport] ${JSON.stringify({ envelope })}`;
    const message = { role: "custom", customType: "subagent-report", content: canonical, display: true, timestamp: 0, details: { envelope, display: buildReportDisplay(envelope, admissions, settlements) } } as any;
    return subagentReportRenderer(message, { expanded: true, outputPad: 0 }, theme)!.render(160).map((line) => line.trimEnd()).join("\n");
  };
  const expanded = [expand(single), expand(singleBatch), expand(chain), expand(chainBatch)].join("\n");
  assert.equal(expanded.split("EXACT SINGLE PAYLOAD").length - 1, 1);
  assert.equal(expanded.split("EXACT CHAIN PAYLOAD").length - 1, 1);
  assert.match(expand(singleBatch), /member #1 · worker · .* · done · 0:01 · single task$/m);
  assert.match(expand(chainBatch), /member #1 · worker · .* · done · 0:02 · chain first$/m);
  assert.match(expand(chainBatch), /member #2 · worker · .* · not_started · 0:03 · chain skipped · not started$/m);
  assert.doesNotMatch(expand(singleBatch), /EXACT SINGLE PAYLOAD|"envelope"/);
  assert.doesNotMatch(expand(chainBatch), /EXACT CHAIN PAYLOAD|"envelope"/);
});

test("renderer handles typed, legacy and malformed reports without changing canonical content", () => {
  const envelope = result("canonical\nbody\nTAIL");
  const canonical = `[subagent worker] ${JSON.stringify({ envelope })}`;
  const display = buildReportDisplay(envelope, new Map([[envelope.identity.runId, { startedAt: 0, taskExcerpt: "same-name sibling" }]]), 5000, { state: "unavailable", code: "EIO" });
  const message = { role: "custom", customType: "subagent-report", content: canonical, display: true, timestamp: 0, details: { envelope, display } } as any;
  const collapsed = subagentReportRenderer(message, { expanded: false, outputPad: 1 }, theme)!;
  assert.match(collapsed.render(120)[0]!, /worker.*done.*same-name sibling/);
  const expanded = subagentReportRenderer(message, { expanded: true, outputPad: 0 }, theme)!;
  assert.match(expanded.render(120).map((line) => line.trimEnd()).join("\n"), /canonical\nbody\nTAIL/);
  assert.doesNotMatch(expanded.render(120).join("\n"), /"envelope"/);
  assert.equal(message.content, canonical);
  for (const details of [undefined, { display: { broken: true } }, { envelope: { version: 1, kind: "broken" } }, { envelope: { version: 1, kind: "batch", batchId: "batch", results: [null] } }]) {
    const legacy = { ...message, details };
    assert.doesNotThrow(() => subagentReportRenderer(legacy, { expanded: false, outputPad: 0 }, theme)!.render(40));
    assert.doesNotThrow(() => subagentReportRenderer(legacy, { expanded: true, outputPad: 0 }, theme)!.render(80));
    assert.match(subagentReportRenderer(legacy, { expanded: true, outputPad: 0 }, theme)!.render(120).join("\n"), /"envelope"/);
  }
});
