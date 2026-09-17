import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildReportDisplay, isReportDisplay, reportBrief, reportDisplayBudgets, reportFailureReason, SubagentReportLine, subagentReportRenderer } from "../src/subagent-report.ts";
import { ChildRuns, resultEnvelope } from "../src/subagent-runs.ts";

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
    [{ ...base, payloadOutcome: "protocol_error" as const }, { stream: { parserErrors: 2, lastParserError: { kind: "invalid_json", offset: 12 } } }, "parser invalid_json at 12 (2)"],
    [{ ...base, payloadOutcome: "output_limit" as const, outputLimit: "batch_transport" as const }, {}, "output limit: batch_transport"],
    [{ ...base, processOutcome: "not_started" as const, payloadOutcome: "incomplete" as const }, {}, "not started"],
  ] as const;
  for (const [envelope, facts, expected] of classes) assert.equal(reportFailureReason(envelope, facts), expected);
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

test("renderer handles typed, legacy and malformed reports without changing canonical content", () => {
  const envelope = result("canonical\nbody\nTAIL");
  const canonical = `[subagent worker] ${JSON.stringify({ envelope })}`;
  const display = buildReportDisplay(envelope, new Map([[envelope.identity.runId, { startedAt: 0, taskExcerpt: "same-name sibling" }]]), 5000, { state: "unavailable", code: "EIO" });
  const message = { role: "custom", customType: "subagent-report", content: canonical, display: true, timestamp: 0, details: { envelope, display } } as any;
  const collapsed = subagentReportRenderer(message, { expanded: false, outputPad: 1 }, theme)!;
  assert.match(collapsed.render(120)[0]!, /worker.*done.*same-name sibling/);
  const expanded = subagentReportRenderer(message, { expanded: true, outputPad: 1 }, theme)!;
  assert.match(expanded.render(120).join("\n"), /canonical.*body.*TAIL/s);
  assert.equal(message.content, canonical);
  for (const details of [undefined, { display: { broken: true } }, { envelope: { version: 1, kind: "broken" } }, { envelope: { version: 1, kind: "batch", batchId: "batch", results: [null] } }]) {
    const legacy = { ...message, details };
    assert.doesNotThrow(() => subagentReportRenderer(legacy, { expanded: false, outputPad: 0 }, theme)!.render(40));
    assert.doesNotThrow(() => subagentReportRenderer(legacy, { expanded: true, outputPad: 0 }, theme)!.render(80));
  }
});
