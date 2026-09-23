import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Socket } from "node:net";
import { convertToLlm, CustomMessageComponent, DefaultResourceLoader, initTheme, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { reportContent, sha256, type ReportDelivery, type ReportEnvelope } from "../src/subagent-runs.ts";
import { openDb } from "../src/db.ts";
import { acknowledgeFixtureReports, createFixtureEngine, loadFixtureExtension, shutdownFixture, withFixtureEnvironment } from "./fixtures/subagent-fixture-engine.ts";

const root = resolve(import.meta.dirname, "..");
const extension = join(root, ".pi/extensions/subagent/index.ts");
const child = join(root, "test/fixtures/subagent-report-child.js");
const coordinatorChild = join(root, "test/fixtures/coordinator-report-child.ts");

async function waitFor(predicate: () => boolean, timeout = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("report fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function coordinatorTerminalScenario(scenario: "verified" | "blocked" | "local") {
  const dir = mkdtempSync(join(root, "test/fixtures", `ym217-coordinator-${scenario}-`));
  const previousArgv = process.argv[1];
  const previousScenario = process.env.YOKEMATE_COORDINATOR_REPORT_SCENARIO;
  const previousMode = process.env.YOKEMATE_MODE;
  const previousRole = process.env.YOKEMATE_ROLE;
  const previousRunId = process.env.YOKEMATE_RUN_ID;
  const previousRelay = process.env.YOKEMATE_SUBAGENT_TEST_RELAY;
  const previousTarget = process.env.YOKEMATE_SUBAGENT_TEST_TARGET;
  let shutdown: (() => Promise<void>) | undefined;
  try {
    delete process.env.YOKEMATE_MODE;
    delete process.env.YOKEMATE_ROLE;
    process.env.YOKEMATE_COORDINATOR_REPORT_SCENARIO = scenario;
    process.env.YOKEMATE_SUBAGENT_TEST_RELAY = join(root, "test/fixtures/subagent-json-relay.mjs");
    process.env.YOKEMATE_SUBAGENT_TEST_TARGET = coordinatorChild;
    cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(root, ".pi/extensions/subagent"), join(dir, ".pi/extensions/subagent"), { recursive: true });
    symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
    mkdirSync(join(dir, ".pi/agents/do"), { recursive: true });
    mkdirSync(join(dir, "home/knowledge/org/repo/ai/YM-1-work"), { recursive: true });
    writeFileSync(join(dir, ".pi/settings.json"), "{}");
    writeFileSync(join(dir, ".pi/agents/do-coordinator.md"), "fixture");
    const plan = join(dir, "home/knowledge/org/repo/ai/YM-1-work/plan.md");
    writeFileSync(plan, "# YM-1 — compact coordinator report\n\n## Goal\nExercise coordinator terminal reporting.\n\n## Affected repositories\n- `org/repo` — app\n\n## Steps\n1. Run the coordinator report fixture and verify the terminal envelope.\n\n## Assumptions\n- The fixture repository is available locally.\n\n## Out of scope\n- Changes to the fixture repository.\n\n## Acceptance\nThe parent receives exactly one compact coordinator terminal report.\n");
    const db = openDb(join(dir, "yokemate.db"));
    db.prepare("INSERT INTO project (org, repo, path, tracker, tracker_key, model) VALUES ('org','repo', ?, 'github', 'YM', 'test/model')").run(join(dir, "clone"));
    db.prepare("INSERT INTO work (ticket,url,stage,plan) VALUES ('YM-1','u','planned',?)").run(plan);
    db.close();
    const agentDir = join(dir, "agent");
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir, settingsManager: SettingsManager.create(dir, agentDir), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [join(dir, ".pi/extensions/subagent/index.ts")] });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    const sent: { message: any; options: any }[] = [];
    loaded.runtime.appendEntry = () => undefined;
    loaded.runtime.getCommands = (() => [{ name: "skill:do-worker" }]) as any;
    loaded.runtime.sendMessage = ((message: any, options: any) => { sent.push({ message, options }); }) as any;
    const ctx = { cwd: dir, mode: "rpc", hasUI: true, isProjectTrusted: () => true, sessionManager: { getSessionId: () => `parent-${scenario}` }, ui: { notify: () => undefined, setWidget: () => undefined }, modelRegistry: { getAll: () => [{ provider: "test", id: "model", name: "model" }], hasConfiguredAuth: () => true } } as unknown as ExtensionContext;
    const loadedExtension = loaded.extensions.find((entry) => entry.path.endsWith("subagent/index.ts"))!;
    for (const handler of loadedExtension.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" } as never, ctx);
    shutdown = async () => { for (const handler of loadedExtension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" } as never, ctx); };
    for (const handler of loadedExtension.handlers.get("input") ?? []) await handler({ type: "input", source: "interactive", text: "/do YM-1" } as never, { ...ctx, mode: "tui" });
    const tool = loaded.extensions.flatMap((entry) => [...entry.tools.values()]).find((entry) => entry.definition.name === "subagent");
    assert.ok(tool);
    const accepted = await tool.definition.execute(`coordinator-${scenario}`, { coordinator: { mode: "do", tickets: ["YM-1"] } }, undefined, () => undefined, ctx);
    assert.equal("isError" in accepted && accepted.isError, false, JSON.stringify(accepted));
    if (scenario === "local") {
      const runId = (accepted.details as { runId: string }).runId;
      process.env.YOKEMATE_MODE = "do";
      process.env.YOKEMATE_ROLE = "coordinator";
      process.env.YOKEMATE_RUN_ID = runId;
      const ready = loadedExtension.commands.get("yokemate-coordinator-ready")!;
      const payload = Buffer.from(JSON.stringify({ identity: { runId, role: "coordinator", cwd: dir }, prepared: { cwd: dir } })).toString("base64");
      await ready.handler(payload, ctx as any);
      assert.equal(sent.at(-1)?.message.details.ok, true, JSON.stringify(sent.at(-1)?.message.details));
      const finish = loaded.extensions.flatMap((entry) => [...entry.tools.values()]).find((entry) => entry.definition.name === "coordinator_finish")!;
      const result = await finish.definition.execute("local-finish", { outcome: "blocked", summary: "local summary", reason: "local blocked" }, undefined, () => undefined, ctx);
      assert.equal((result.content[0] as any).text, "blocked verified");
    }
    const terminalReports = () => sent.filter((entry) => entry.message.customType === "subagent-report");
    await waitFor(() => terminalReports().length === 1);
    const terminal = terminalReports()[0]!;
    assert.equal(terminal.options.deliverAs, "followUp");
    assert.equal(terminal.options.triggerTurn, true);
    assert.equal(terminal.message.customType, "subagent-report");
    assert.equal(terminal.message.display, true);
    assert.equal(terminal.message.details.mode, "do");
    assert.equal(terminal.message.details.outcome, "blocked");
    assert.equal(terminal.message.details.tickets[0], "YM-1");
    assert.equal(terminal.message.details.display.kind, "coordinator");
    assert.doesNotMatch(terminal.message.content, /nested child report/);
    const expected = scenario === "verified" ? "[coordinator do YM-1] blocked: verified summary" : scenario === "blocked" ? "[coordinator do YM-1] blocked: coordinator RPC exited without outcome" : "[coordinator do YM-1] blocked: local summary";
    assert.equal(terminal.message.content, expected);
    assert.equal(readFileSync(terminal.message.details.display.archive.reportPath, "utf8"), expected);
    await waitFor(() => {
      try {
        const diagnostics = JSON.parse(readFileSync(terminal.message.details.display.archive.diagnosticsPath, "utf8"));
        return diagnostics.diagnostics.process.exitCode !== undefined;
      } catch { return false; }
    });
    assert.equal(terminalReports().length, 1);
    return terminal.message;
  } finally {
    await shutdown?.();
    process.argv[1] = previousArgv;
    if (previousScenario === undefined) delete process.env.YOKEMATE_COORDINATOR_REPORT_SCENARIO; else process.env.YOKEMATE_COORDINATOR_REPORT_SCENARIO = previousScenario;
    if (previousMode === undefined) delete process.env.YOKEMATE_MODE; else process.env.YOKEMATE_MODE = previousMode;
    if (previousRole === undefined) delete process.env.YOKEMATE_ROLE; else process.env.YOKEMATE_ROLE = previousRole;
    if (previousRunId === undefined) delete process.env.YOKEMATE_RUN_ID; else process.env.YOKEMATE_RUN_ID = previousRunId;
    if (previousRelay === undefined) delete process.env.YOKEMATE_SUBAGENT_TEST_RELAY; else process.env.YOKEMATE_SUBAGENT_TEST_RELAY = previousRelay;
    if (previousTarget === undefined) delete process.env.YOKEMATE_SUBAGENT_TEST_TARGET; else process.env.YOKEMATE_SUBAGENT_TEST_TARGET = previousTarget;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("ordinary ACK UUID cancellation proves TERM and KILL cleanup without closing the runtime", { timeout: 30000 }, async () => {
  const engine = createFixtureEngine({ label: "cancel", agents: { worker: "---\nname: worker\ndescription: cancellation fixture\n---\nReturn only after release.\n" } });
  const socketPath = join(engine.runtimeDir, "cancel.sock");
  const sockets = new Set<Socket>();
  const events: any[] = [];
  const waiters: Array<() => void> = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        events.push({ ...JSON.parse(buffer.slice(0, newline)), socket });
        buffer = buffer.slice(newline + 1);
        for (const wake of waiters.splice(0)) wake();
      }
    });
  });
  const waitEvent = async (predicate: (event: any) => boolean) => {
    while (!events.some(predicate)) await new Promise<void>((resolve) => waiters.push(resolve));
    return events.find(predicate)!;
  };
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    await withFixtureEnvironment(engine, { RUNTIME_SETTINGS_TEST_SOCKET: socketPath, SUBAGENT_CANCEL_MODE: "term", YOKEMATE_SUBAGENT_TEST_TARGET: engine.resources["runtime-settings-child.mjs"] }, async () => {
      const widgets: unknown[] = [];
      const fixture = await loadFixtureExtension(engine, { sessionId: "cancel-owner", hasUI: true, ui: { setWidget: (_key: string, value: unknown) => widgets.push(value) } });
      const promptsBefore = new Set(readdirSync(engine.tmpDir).filter((name) => name.startsWith("pi-subagent-")));
      const termStart = fixture.sent.length;
      const launched = await fixture.tool.execute("cancel-term", { agent: "worker", task: "held TERM child" }, undefined, () => undefined, fixture.ctx);
      const runId = (launched.details as any).children[0].identity.runId;
      const child = await waitEvent((event) => event.task?.includes("held TERM child"));
      const foreign = await fixture.tool.execute("foreign", { cancelRun: runId }, undefined, () => undefined, { ...fixture.ctx, sessionManager: { getSessionId: () => "foreign" } } as ExtensionContext);
      assert.equal((foreign.details as any).status, "not_owned");
      assert.doesNotThrow(() => process.kill(child.pid, 0));
      const cancelling = fixture.tool.execute("cancel", { cancelRun: runId }, undefined, () => undefined, fixture.ctx);
      await waitEvent((event) => event.pid === child.pid && event.phase === "term");
      assert.notEqual(widgets.at(-1), undefined);
      const cancelled = await cancelling;
      assert.equal((cancelled.details as any).status, "cancelled");
      assert.equal((cancelled.details as any).targetKind, "ordinary");
      assert.equal((cancelled.details as any).processOutcome, "cancelled");
      assert.equal((cancelled.details as any).exitCode, 0);
      assert.equal((cancelled.details as any).signal, null);
      assert.equal((cancelled.details as any).cancellationInitiator, "tool_cancel");
      assert.throws(() => process.kill(child.pid, 0));
      await waitFor(() => fixture.sent.length === termStart + 2);
      const termReports = fixture.sent.slice(termStart);
      assert.equal(termReports.find(({ message }) => message.details?.envelope?.identity?.runId === runId)!.message.details.envelope.processOutcome, "cancelled");
      await acknowledgeFixtureReports(fixture, termReports);
      assert.equal((await fixture.tool.execute("repeat", { cancelRun: runId }, undefined, () => undefined, fixture.ctx) as any).details.status, "already_terminal");
      assert.equal((await fixture.tool.execute("unknown", { cancelRun: "11111111-1111-4111-8111-111111111111" }, undefined, () => undefined, fixture.ctx) as any).details.status, "unknown");
      const mixed = await fixture.tool.execute("mixed", { cancelRun: "11111111-1111-4111-8111-111111111111", agent: "worker", task: "must not launch" }, undefined, () => undefined, fixture.ctx);
      assert.equal("isError" in mixed && mixed.isError, true);
      assert.match((mixed.content[0] as any).text, /cannot be combined/);
      await waitFor(() => widgets.at(-1) === undefined);
      assert.deepEqual(readdirSync(engine.tmpDir).filter((name) => name.startsWith("pi-subagent-") && !promptsBefore.has(name)), []);

      process.env.SUBAGENT_CANCEL_MODE = "kill";
      const killStart = fixture.sent.length;
      const killLaunch = await fixture.tool.execute("cancel-kill", { agent: "worker", task: "held KILL child" }, undefined, () => undefined, fixture.ctx);
      const killRunId = (killLaunch.details as any).children[0].identity.runId;
      const killChild = await waitEvent((event) => event.task?.includes("held KILL child"));
      const killed = await fixture.tool.execute("kill", { cancelRun: killRunId }, undefined, () => undefined, fixture.ctx);
      assert.ok(events.some((event) => event.pid === killChild.pid && event.phase === "term-ignored"));
      assert.equal((killed.details as any).status, "cancelled");
      assert.equal((killed.details as any).signal, "SIGKILL");
      assert.equal((killed.details as any).exitCode, null);
      assert.throws(() => process.kill(killChild.pid, 0));
      await waitFor(() => fixture.sent.length === killStart + 2);
      await acknowledgeFixtureReports(fixture, fixture.sent.slice(killStart));
      const states = fixture.entries.filter((entry) => entry.type === "yokemate-child-state").map((entry) => entry.data);
      assert.ok(states.some((state) => state.children?.some((entry: any) => entry.identity.runId === killRunId)));
      assert.ok(states.some((state) => state.children?.length === 0));

      process.env.SUBAGENT_CANCEL_MODE = "term";
      const parallelStart = fixture.sent.length;
      const parallel = await fixture.tool.execute("cancel-parallel", { tasks: [{ agent: "worker", task: "parallel survivor" }, { agent: "worker", task: "parallel selected cancel" }] }, undefined, () => undefined, fixture.ctx);
      const parallelRuns = (parallel.details as any).children.map((entry: any) => entry.identity.runId);
      const survivor = await waitEvent((event) => event.task?.includes("parallel survivor"));
      const selected = await waitEvent((event) => event.task?.includes("parallel selected cancel"));
      const selectedCancellation = fixture.tool.execute("cancel-parallel-selected", { cancelRun: parallelRuns[1] }, undefined, () => undefined, fixture.ctx);
      await waitEvent((event) => event.pid === selected.pid && event.phase === "term");
      assert.equal(((await selectedCancellation) as any).details.status, "cancelled");
      survivor.socket.end("release\n");
      await waitFor(() => fixture.sent.length === parallelStart + 3);
      const parallelReports = fixture.sent.slice(parallelStart);
      const parallelBatch = parallelReports.find(({ message }) => message.details?.envelope?.kind === "batch")!.message.details.envelope;
      assert.deepEqual(parallelBatch.results.map((result: any) => result.processOutcome), ["exited", "cancelled"]);
      await acknowledgeFixtureReports(fixture, parallelReports);

      const chainStart = fixture.sent.length;
      const chain = await fixture.tool.execute("cancel-chain", { chain: [{ agent: "worker", task: "chain survivor" }, { agent: "worker", task: "chain selected cancel {previous}" }, { agent: "worker", task: "chain deferred tail {previous}" }] }, undefined, () => undefined, fixture.ctx);
      const chainRuns = (chain.details as any).children.map((entry: any) => entry.identity.runId);
      const chainSurvivor = await waitEvent((event) => event.task?.includes("chain survivor"));
      const deferredCancellation = await fixture.tool.execute("cancel-chain-selected", { cancelRun: chainRuns[1] }, undefined, () => undefined, fixture.ctx);
      assert.equal((deferredCancellation as any).details.status, "cancellation_requested");
      chainSurvivor.socket.end("release\n");
      await waitFor(() => fixture.sent.length === chainStart + 2);
      const chainReports = fixture.sent.slice(chainStart);
      const chainEnvelope = chainReports.find(({ message }) => message.details?.envelope?.kind === "chain")!.message.details.envelope;
      assert.deepEqual(chainEnvelope.results.map((result: any) => result.processOutcome), ["exited", "cancelled", "not_started"]);
      await acknowledgeFixtureReports(fixture, chainReports);

      Object.assign(process.env, { YOKEMATE_MODE: "plan", YOKEMATE_ROLE: "coordinator", YOKEMATE_RUN_ID: "22222222-2222-4222-8222-222222222222", YOKEMATE_PLAN_RUN_ID: "22222222-2222-4222-8222-222222222222", YOKEMATE_TICKET: "YM-1" });
      delete process.env.PI_SESSION_ID;
      const planFinish = fixture.extension.tools.get("plan_finish")!.definition;
      const stopped = await planFinish.execute("finish", { outcome: "cancelled", reason: "fixture stop" }, undefined, () => undefined, fixture.ctx);
      assert.equal("isError" in stopped && stopped.isError, true);
      assert.doesNotMatch((stopped.content[0] as any).text, /PI_SESSION_ID/);
      const fenced = await fixture.tool.execute("after-stop", { agent: "worker", task: "must stay conversational" }, undefined, () => undefined, fixture.ctx);
      assert.equal("isError" in fenced && fenced.isError, true);
      assert.match((fenced.content[0] as any).text, /plan run is stopped/);
      await shutdownFixture(fixture);
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("real loader sends one compact parent terminal for every coordinator terminal path", async () => {
  const verified = await coordinatorTerminalScenario("verified");
  const blocked = await coordinatorTerminalScenario("blocked");
  const local = await coordinatorTerminalScenario("local");
  assert.equal(new Set([verified.details.runId, blocked.details.runId, local.details.runId]).size, 3);
});

test("D01 ordinary descendants inherit isolation and retain default session behavior", async () => {
  const engine = createFixtureEngine({ label: "isolation", agents: { worker: "---\nname: worker\ndescription: isolation fixture\n---\nReturn output.\n" } });
  await withFixtureEnvironment(engine, { YM217_REPORT_SCENARIO: "isolation", YOKEMATE_SUBAGENT_TEST_TARGET: engine.resources["subagent-report-child.js"] }, async () => {
    const fixture = await loadFixtureExtension(engine, { sessionId: "isolation-session" });
    for (const coordinator of [false, true]) for (const isolated of [false, true]) {
      if (coordinator) process.env.YOKEMATE_ROLE = "coordinator"; else delete process.env.YOKEMATE_ROLE;
      if (isolated) process.env.PI_CODING_AGENT_SESSION_DIR = join(engine.root, "isolated sessions"); else delete process.env.PI_CODING_AGENT_SESSION_DIR;
      const before = fixture.sent.length;
      await fixture.tool.execute(`isolation-${coordinator}-${isolated}`, { agent: "worker", task: "inspect safe fixture configuration" }, undefined, () => undefined, fixture.ctx);
      await waitFor(() => fixture.sent.length === before + 2);
      const reports = fixture.sent.slice(before);
      const observed = JSON.parse(reports[0]!.message.details.envelope.payload);
      assert.equal(observed.agentDir, engine.agentDir);
      assert.equal(observed.sessionDir, isolated ? join(engine.root, "isolated sessions") : undefined);
      assert.equal(observed.role, "executor");
      assert.equal(observed.args.includes("--no-session"), !coordinator);
      assert.equal(observed.args.includes("--session-dir"), coordinator && !isolated);
      if (coordinator && !isolated) assert.equal(observed.args[observed.args.indexOf("--session-dir") + 1], engine.sessionDir);
      await acknowledgeFixtureReports(fixture, reports);
    }
    await shutdownFixture(fixture);
  });
});

test("owned loader uses steer and fences terminal reviewer replacement until matching observation", async () => {
  const engine = createFixtureEngine({ label: "owned-review", gitRepository: true, agents: { "task-reviewer": "---\nname: task-reviewer\ndescription: review fixture\n---\nReturn reviewer JSON.\n" } });
  const ownerRunId = "11111111-1111-4111-8111-111111111111";
  await withFixtureEnvironment(engine, { YOKEMATE_MODE: "do", YOKEMATE_ROLE: "coordinator", YOKEMATE_RUN_ID: ownerRunId, YOKEMATE_SUBAGENT_TEST_TARGET: engine.resources["subagent-report-child.js"] }, async () => {
    const fixture = await loadFixtureExtension(engine, { sessionId: "owned-review-session" });
    fixture.loader.getExtensions().runtime.getCommands = (() => [{ name: "skill:do-worker" }]) as any;
    const ready = fixture.extension.commands.get("yokemate-coordinator-ready")!;
    const payload = Buffer.from(JSON.stringify({ identity: { runId: ownerRunId, role: "coordinator", cwd: engine.root }, prepared: { cwd: engine.root } })).toString("base64");
    await ready.handler(payload, fixture.ctx as any);
    const readyMessage = fixture.sent.at(-1)!;
    assert.equal(readyMessage.message.customType, "yokemate-coordinator-ready");
    assert.equal(readyMessage.options.deliverAs, "followUp");
    const head = execFileSync("git", ["-C", engine.repository!, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const review = { baseSha: head, headSha: head };
    const first = await fixture.tool.execute("owned-first", { agent: "task-reviewer", task: "first wording", cwd: engine.repository, review }, undefined, () => undefined, fixture.ctx);
    assert.equal("isError" in first && first.isError, false);
    await waitFor(() => fixture.sent.filter((entry) => entry.message.customType === "subagent-report").length === 2);
    const firstReports = fixture.sent.filter((entry) => entry.message.customType === "subagent-report");
    assert.ok(firstReports.every((entry) => entry.options.deliverAs === "steer" && entry.options.triggerTurn === true));
    await assert.rejects(() => fixture.tool.execute("owned-replacement", { agent: "task-reviewer", task: "different wording", cwd: engine.repository, review }, undefined, () => undefined, fixture.ctx), new RegExp(`reviewer ${(first.details as any).children[0].identity.runId}.*terminal without matching observed delivery`));
    const secondRepository = join(engine.root, "repository-copy");
    cpSync(engine.repository!, secondRepository, { recursive: true });
    const independent = await fixture.tool.execute("owned-independent", { agent: "task-reviewer", task: "independent cwd", cwd: secondRepository, review }, undefined, () => undefined, fixture.ctx);
    assert.equal("isError" in independent && independent.isError, false);
    await waitFor(() => fixture.sent.filter((entry) => entry.message.customType === "subagent-report").length === 4);
    const allBeforeObservation = fixture.sent.filter((entry) => entry.message.customType === "subagent-report");
    const firstResult = allBeforeObservation.find((entry) => entry.message.details.envelope.kind === "result" && entry.message.details.envelope.identity.runId === (first.details as any).children[0].identity.runId)!;
    await acknowledgeFixtureReports(fixture, [firstResult]);
    const firstBatchId = firstResult.message.details.envelope.identity.batchId;
    const partiallyObserved = fixture.entries.filter((entry) => entry.type === "yokemate-child-state").map((entry) => entry.data).at(-1);
    assert.equal(partiallyObserved.deliveries.find((delivery: any) => delivery.deliveryId === firstResult.message.details.deliveryId)?.state, "observed");
    assert.ok(partiallyObserved.deliveries.some((delivery: any) => delivery.batchId === firstBatchId && delivery.state === "enqueued"));
    const afterObservation = await fixture.tool.execute("owned-after-observed", { agent: "task-reviewer", task: "review after observation", cwd: engine.repository, review }, undefined, () => undefined, fixture.ctx);
    assert.equal("isError" in afterObservation && afterObservation.isError, false);
    await waitFor(() => fixture.sent.filter((entry) => entry.message.customType === "subagent-report").length === 6);
    await acknowledgeFixtureReports(fixture, fixture.sent.filter((entry) => entry.message.customType === "subagent-report"));
    await shutdownFixture(fixture);
  });
});

test("local coordinator finish rechecks exact generation queue, retry and compaction readiness", async () => {
  const engine = createFixtureEngine({ label: "owned-local-finish", agents: { worker: "---\nname: worker\ndescription: finish fixture\n---\nReturn output.\n" } });
  const owner = "77777777-7777-4777-8777-777777777777";
  await withFixtureEnvironment(engine, { YOKEMATE_MODE: "do", YOKEMATE_ROLE: "coordinator", YOKEMATE_RUN_ID: owner }, async () => {
    const fixture = await loadFixtureExtension(engine, { sessionId: "owned-local-finish-session" });
    fixture.loader.getExtensions().runtime.getCommands = (() => [{ name: "skill:do-worker" }]) as any;
    const ready = fixture.extension.commands.get("yokemate-coordinator-ready")!;
    const payload = Buffer.from(JSON.stringify({ identity: { runId: owner, role: "coordinator", cwd: engine.root }, prepared: { cwd: engine.root } })).toString("base64");
    await ready.handler(payload, fixture.ctx as any);
    const finish = fixture.extension.tools.get("coordinator_finish")!.definition;
    const params = { outcome: "blocked" as const, summary: "fixture", reason: "fixture" };
    const queued = await finish.execute("finish-queued", params, undefined, () => undefined, { ...fixture.ctx, hasPendingMessages: () => true } as any) as any;
    assert.equal(queued.isError, true);
    assert.match(queued.content[0].text, /active child batches/);
    for (const handler of fixture.extension.handlers.get("session_before_compact") ?? []) await handler({ type: "session_before_compact" } as never, fixture.ctx);
    const compacting = await finish.execute("finish-compacting", params, undefined, () => undefined, { ...fixture.ctx, hasPendingMessages: () => false } as any) as any;
    assert.equal(compacting.isError, true);
    for (const handler of fixture.extension.handlers.get("session_compact") ?? []) await handler({ type: "session_compact" } as never, fixture.ctx);
    for (const handler of fixture.extension.handlers.get("agent_end") ?? []) await handler({ type: "agent_end", willRetry: true } as never, fixture.ctx);
    const retrying = await finish.execute("finish-retrying", params, undefined, () => undefined, { ...fixture.ctx, hasPendingMessages: () => false } as any) as any;
    assert.equal(retrying.isError, true);
    for (const handler of fixture.extension.handlers.get("agent_start") ?? []) await handler({ type: "agent_start" } as never, fixture.ctx);
    await ready.handler(payload, fixture.ctx as any);
    const accepted = await finish.execute("finish-ready", params, undefined, () => undefined, { ...fixture.ctx, hasPendingMessages: () => false } as any);
    assert.equal("isError" in accepted && accepted.isError, false);
    assert.equal(accepted.terminate, true);
    await shutdownFixture(fixture);
  });
});

test("owned replacement rejects a launch paused before admission", async () => {
  const engine = createFixtureEngine({ label: "owned-pre-admission-replacement", agents: { worker: "---\nname: worker\ndescription: pre-admission fixture\n---\nReturn output.\n" } });
  const owner = "66666666-6666-4666-8666-666666666666";
  await withFixtureEnvironment(engine, { YOKEMATE_MODE: "do", YOKEMATE_ROLE: "coordinator", YOKEMATE_RUN_ID: owner, YOKEMATE_SUBAGENT_TEST_TARGET: engine.resources["subagent-report-child.js"] }, async () => {
    const fixture = await loadFixtureExtension(engine, { sessionId: "owned-pre-admission-session" });
    fixture.loader.getExtensions().runtime.getCommands = (() => [{ name: "skill:do-worker" }]) as any;
    const ready = fixture.extension.commands.get("yokemate-coordinator-ready")!;
    const payload = Buffer.from(JSON.stringify({ identity: { runId: owner, role: "coordinator", cwd: engine.root }, prepared: { cwd: engine.root } })).toString("base64");
    await ready.handler(payload, fixture.ctx as any);
    const pending = fixture.tool.execute("pre-admission", { agent: "worker", task: "must not cross generation" }, undefined, () => undefined, fixture.ctx);
    await ready.handler(payload, fixture.ctx as any);
    await assert.rejects(() => pending, /parent session changed before subagent admission/);
    assert.equal(fixture.sent.filter((entry) => entry.message.customType === "subagent-report").length, 0);
    await shutdownFixture(fixture);
  });
});

test("owned replacement fences late producer delivery from the previous generation", async () => {
  const engine = createFixtureEngine({ label: "owned-replacement", agents: { worker: "---\nname: worker\ndescription: replacement fixture\n---\nReturn after release.\n" } });
  const socketPath = join(engine.runtimeDir, "replacement.sock");
  const sockets = new Set<Socket>();
  let childPid = 0;
  let childStarted!: () => void;
  const started = new Promise<void>((resolve) => { childStarted = resolve; });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      childPid = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))).pid;
      childStarted();
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const firstOwner = "11111111-1111-4111-8111-111111111111";
    const secondOwner = firstOwner;
    await withFixtureEnvironment(engine, { RUNTIME_SETTINGS_TEST_SOCKET: socketPath, YOKEMATE_MODE: "do", YOKEMATE_ROLE: "coordinator", YOKEMATE_RUN_ID: firstOwner, YOKEMATE_SUBAGENT_TEST_TARGET: engine.resources["runtime-settings-child.mjs"] }, async () => {
      const fixture = await loadFixtureExtension(engine, { sessionId: "owned-replacement-session" });
      fixture.loader.getExtensions().runtime.getCommands = (() => [{ name: "skill:do-worker" }]) as any;
      const ready = fixture.extension.commands.get("yokemate-coordinator-ready")!;
      const readyOwner = async (runId: string) => {
        process.env.YOKEMATE_RUN_ID = runId;
        const payload = Buffer.from(JSON.stringify({ identity: { runId, role: "coordinator", cwd: engine.root }, prepared: { cwd: engine.root } })).toString("base64");
        await ready.handler(payload, fixture.ctx as any);
      };
      await readyOwner(firstOwner);
      const launch = await fixture.tool.execute("old-generation", { agent: "worker", task: "finish after owner replacement" }, undefined, () => undefined, fixture.ctx);
      assert.equal("isError" in launch && launch.isError, false);
      await started;
      await readyOwner(secondOwner);
      assert.throws(() => process.kill(childPid, 0));
      const oldStates = fixture.entries.filter((entry) => entry.type === "yokemate-child-state" && entry.data.ownerRunId === firstOwner).map((entry) => entry.data);
      assert.ok(oldStates.some((state) => state.deliveries.length > 0 && state.deliveries.every((delivery: any) => delivery.state === "delivery_unknown")), JSON.stringify(oldStates.map((state) => ({ children: state.children.length, deliveries: state.deliveries.map((delivery: any) => delivery.state) }))));
      assert.equal(fixture.sent.filter((entry) => entry.message.customType === "subagent-report").length, 0);
      process.env.YOKEMATE_SUBAGENT_TEST_TARGET = engine.resources["subagent-report-child.js"];
      const reused = await fixture.tool.execute("old-generation", { agent: "worker", task: "new generation reuses batch id" }, undefined, () => undefined, fixture.ctx);
      assert.equal("isError" in reused && reused.isError, false);
      await waitFor(() => fixture.sent.filter((entry) => entry.message.customType === "subagent-report").length === 2);
      const replacementReports = fixture.sent.filter((entry) => entry.message.customType === "subagent-report");
      assert.deepEqual(replacementReports.map((entry) => entry.message.details.envelope.kind).sort(), ["batch", "result"]);
      await acknowledgeFixtureReports(fixture, replacementReports);
      await shutdownFixture(fixture, { expectedDeliveryState: "terminal" });
      assert.equal(fixture.sent.filter((entry) => entry.message.customType === "yokemate-coordinator-ready").length, 2);
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("owned turn boundary releases for a ready sibling and waits again for remaining work", async () => {
  const engine = createFixtureEngine({ label: "owned-sibling-boundary", agents: { worker: "---\nname: worker\ndescription: sibling boundary fixture\n---\nReturn after release.\n" } });
  const socketPath = join(engine.runtimeDir, "sibling-boundary.sock");
  const sockets = new Set<Socket>();
  const started: Socket[] = [];
  let wake!: () => void;
  const changed = () => new Promise<void>((resolve) => { wake = resolve; });
  let nextChange = changed();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const message = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      started.push(socket);
      wake();
      nextChange = changed();
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const owner = "33333333-3333-4333-8333-333333333333";
    await withFixtureEnvironment(engine, { RUNTIME_SETTINGS_TEST_SOCKET: socketPath, YOKEMATE_MODE: "do", YOKEMATE_ROLE: "coordinator", YOKEMATE_RUN_ID: owner, YOKEMATE_SUBAGENT_TEST_TARGET: engine.resources["runtime-settings-child.mjs"] }, async () => {
      const fixture = await loadFixtureExtension(engine, { sessionId: "owned-sibling-session" });
      fixture.loader.getExtensions().runtime.getCommands = (() => [{ name: "skill:do-worker" }]) as any;
      const ready = fixture.extension.commands.get("yokemate-coordinator-ready")!;
      await ready.handler(Buffer.from(JSON.stringify({ identity: { runId: owner, role: "coordinator", cwd: engine.root }, prepared: { cwd: engine.root } })).toString("base64"), fixture.ctx as any);
      await fixture.tool.execute("siblings", { tasks: [{ agent: "worker", task: "first sibling" }, { agent: "worker", task: "second sibling" }] }, undefined, () => undefined, fixture.ctx);
      while (started.length < 2) await nextChange;
      const controller = new AbortController();
      const invokeTurnEnd = () => Promise.all((fixture.extension.handlers.get("turn_end") ?? []).map((handler) => handler({ type: "turn_end" } as never, { ...fixture.ctx, signal: controller.signal } as any)));
      let released = false;
      const waiting = invokeTurnEnd().then(() => { released = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(released, false);
      started[0]!.end("release\n");
      await waitFor(() => fixture.sent.filter((entry) => entry.message.customType === "subagent-report" && entry.message.details.envelope.kind === "result").length === 1);
      await waiting;
      assert.equal(released, true);
      await invokeTurnEnd();
      const firstResult = fixture.sent.find((entry) => entry.message.customType === "subagent-report" && entry.message.details.envelope.kind === "result")!;
      await acknowledgeFixtureReports(fixture, [firstResult]);
      let waitingAgainReleased = false;
      const waitingAgain = invokeTurnEnd().then(() => { waitingAgainReleased = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(waitingAgainReleased, false);
      started[1]!.end("release\n");
      await waitingAgain;
      await waitFor(() => fixture.sent.filter((entry) => entry.message.customType === "subagent-report").length === 3);
      await acknowledgeFixtureReports(fixture, fixture.sent.filter((entry) => entry.message.customType === "subagent-report"));
      await shutdownFixture(fixture);
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("owned turn boundary abort releases the waiter without starting another delivery turn", async () => {
  const engine = createFixtureEngine({ label: "owned-abort-boundary", agents: { worker: "---\nname: worker\ndescription: abort boundary fixture\n---\nReturn after release.\n" } });
  const socketPath = join(engine.runtimeDir, "abort-boundary.sock");
  const sockets = new Set<Socket>();
  let started!: () => void;
  const childStarted = new Promise<void>((resolve) => { started = resolve; });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", () => started());
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const owner = "55555555-5555-4555-8555-555555555555";
    await withFixtureEnvironment(engine, { RUNTIME_SETTINGS_TEST_SOCKET: socketPath, YOKEMATE_MODE: "do", YOKEMATE_ROLE: "coordinator", YOKEMATE_RUN_ID: owner, YOKEMATE_SUBAGENT_TEST_TARGET: engine.resources["runtime-settings-child.mjs"] }, async () => {
      const fixture = await loadFixtureExtension(engine, { sessionId: "owned-abort-session" });
      fixture.loader.getExtensions().runtime.getCommands = (() => [{ name: "skill:do-worker" }]) as any;
      const ready = fixture.extension.commands.get("yokemate-coordinator-ready")!;
      await ready.handler(Buffer.from(JSON.stringify({ identity: { runId: owner, role: "coordinator", cwd: engine.root }, prepared: { cwd: engine.root } })).toString("base64"), fixture.ctx as any);
      await fixture.tool.execute("abort-child", { agent: "worker", task: "held until abort" }, undefined, () => undefined, fixture.ctx);
      await childStarted;
      const controller = new AbortController();
      let released = false;
      const waiting = Promise.all((fixture.extension.handlers.get("turn_end") ?? []).map((handler) => handler({ type: "turn_end" } as never, { ...fixture.ctx, signal: controller.signal } as any))).then(() => { released = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(released, false);
      controller.abort();
      await waiting;
      assert.equal(released, true);
      assert.equal(fixture.sent.filter((entry) => entry.message.customType === "subagent-report").length, 0);
      await shutdownFixture(fixture, { expectedDeliveryState: "delivery_unknown" });
      assert.equal(fixture.sent.filter((entry) => entry.message.customType === "subagent-report").length, 0);
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("owned turn boundary stays held through chain progression until the chain report is ready", async () => {
  const engine = createFixtureEngine({ label: "owned-chain-boundary", agents: { worker: "---\nname: worker\ndescription: chain boundary fixture\n---\nReturn after release.\n" } });
  const socketPath = join(engine.runtimeDir, "chain-boundary.sock");
  const sockets = new Set<Socket>();
  const started: Array<{ task: string; socket: Socket }> = [];
  const waiters: Array<() => void> = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const message = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      started.push({ task: message.task, socket });
      for (const waiter of waiters.splice(0)) waiter();
    });
  });
  const waitStarted = async (count: number) => { while (started.length < count) await new Promise<void>((resolve) => waiters.push(resolve)); };
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const owner = "44444444-4444-4444-8444-444444444444";
    await withFixtureEnvironment(engine, { RUNTIME_SETTINGS_TEST_SOCKET: socketPath, YOKEMATE_MODE: "do", YOKEMATE_ROLE: "coordinator", YOKEMATE_RUN_ID: owner, YOKEMATE_SUBAGENT_TEST_TARGET: engine.resources["runtime-settings-child.mjs"] }, async () => {
      const fixture = await loadFixtureExtension(engine, { sessionId: "owned-chain-session" });
      fixture.loader.getExtensions().runtime.getCommands = (() => [{ name: "skill:do-worker" }]) as any;
      const ready = fixture.extension.commands.get("yokemate-coordinator-ready")!;
      await ready.handler(Buffer.from(JSON.stringify({ identity: { runId: owner, role: "coordinator", cwd: engine.root }, prepared: { cwd: engine.root } })).toString("base64"), fixture.ctx as any);
      await fixture.tool.execute("chain-boundary", { chain: [{ agent: "worker", task: "chain first" }, { agent: "worker", task: "chain second {previous}" }] }, undefined, () => undefined, fixture.ctx);
      await waitStarted(1);
      const controller = new AbortController();
      let released = false;
      const waiting = Promise.all((fixture.extension.handlers.get("turn_end") ?? []).map((handler) => handler({ type: "turn_end" } as never, { ...fixture.ctx, signal: controller.signal } as any))).then(() => { released = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(released, false);
      started[0]!.socket.end("release\n");
      await waitStarted(2);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(released, false);
      assert.equal(fixture.sent.filter((entry) => entry.message.customType === "subagent-report").length, 0);
      started[1]!.socket.end("release\n");
      await waiting;
      await waitFor(() => fixture.sent.filter((entry) => entry.message.customType === "subagent-report").length >= 2);
      const reports = fixture.sent.filter((entry) => entry.message.customType === "subagent-report");
      assert.deepEqual(reports.map((entry) => entry.message.details.envelope.kind).sort(), ["batch", "chain"]);
      await acknowledgeFixtureReports(fixture, reports);
      await shutdownFixture(fixture);
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("real loader keeps canonical reports byte-equivalent while renderer collapses and expands", async () => {
  const engine = createFixtureEngine({ label: "loader", agents: { worker: "---\nname: worker\ndescription: report fixture\n---\nReturn output.\n" } });
  await withFixtureEnvironment(engine, { YOKEMATE_SUBAGENT_TEST_TARGET: engine.resources["subagent-report-child.js"] }, async () => {
    const fixture = await loadFixtureExtension(engine, { sessionId: "loader-session" });
    const sent = fixture.sent;
    const tool = fixture.tool;
    const ctx = fixture.ctx;
    const ack = await tool.execute("loader-batch", { agent: "worker", task: "produce multiline canonical output" }, undefined, () => undefined, ctx);
    assert.match((ack.content[0] as any).text, /^Detached, not terminal: /);
    const parsedAck = JSON.parse((ack.content[0] as any).text.slice("Detached, not terminal: ".length));
    assert.deepEqual(parsedAck, { version: 1, kind: "ack", terminal: false, batchId: "loader-batch", children: (ack.details as any).children });
    assert.equal((ack.details as any).display.members[0].taskExcerpt, "produce multiline canoni");
    await waitFor(() => sent.length === 2);
    assert.equal(sent.length, 2);
    assert.ok(sent.every((entry) => entry.options.deliverAs === "followUp" && entry.options.triggerTurn === true && typeof entry.options.yokemateSendId === "string" && typeof entry.options.onYokemateSendError === "function"));
    const assertCanonicalReports = (entries: typeof sent) => {
      for (const { message, options } of entries) {
        const envelope = message.details.envelope as ReportEnvelope;
        const delivery = { deliveryId: message.details.deliveryId, envelopeHash: message.details.envelopeHash } as ReportDelivery;
        assert.equal(message.content, reportContent(envelope, delivery));
        assert.equal(message.details.envelopeHash, sha256(JSON.stringify(envelope)));
        assert.equal(message.customType, "subagent-report");
        assert.equal(message.display, true);
        assert.equal(message.details.display.version, 1);
        assert.equal(options.deliverAs, "followUp");
        assert.equal(options.triggerTurn, true);
        assert.equal(options.yokemateSendId, delivery.deliveryId);
        assert.equal(typeof options.onYokemateSendError, "function");
        assert.equal(readFileSync(message.details.display.archive.reportPath, "utf8"), message.content);
        assert.equal(message.details.display.archive.reportBytes, Buffer.byteLength(message.content));
        assert.equal(message.details.display.archive.reportHash, sha256(message.content));
        const diagnostics = readFileSync(message.details.display.archive.diagnosticsPath, "utf8");
        assert.doesNotMatch(diagnostics, /requestedTask|produce multiline canonical output|parallel one|parallel two|chain one|after \{previous\}/);
        const llm = convertToLlm([{ role: "custom", timestamp: 0, ...message }]);
        assert.equal((llm[0]!.content[0] as any).text, message.content);
      }
    };
    assertCanonicalReports(sent);
    assert.equal(sent[0]!.message.details.envelope.kind, "result");
    assert.equal(sent[1]!.message.details.envelope.kind, "batch");
    assert.equal(sent[0]!.message.details.envelope.identity.runId, parsedAck.children[0].identity.runId);

    initTheme("dark", false);
    const renderer = [...fixture.extension.messageRenderers.entries()].find(([name]) => name === "subagent-report")?.[1];
    assert.ok(renderer);
    const component = new CustomMessageComponent({ role: "custom", timestamp: 0, ...sent[0]!.message }, renderer, undefined, 1);
    const collapsed = component.render(80).map(stripTerminalSequences);
    assert.equal(collapsed.filter((line) => line.trim()).length, 1);
    assert.match(collapsed.join("\n"), /worker.*result.*done.*produce multiline/);
    for (const width of [1, 2, 3, 40, 80, 120]) assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
    const sendsBefore = sent.length;
    component.setExpanded(true);
    const expanded = component.render(120).map(stripTerminalSequences).map((line) => line.trim()).join("\n");
    assert.match(expanded, /line one\nline two\ncanonical tail/);
    assert.doesNotMatch(expanded, /"envelope"/);
    assert.match(expanded, /report\.txt:/);
    const batchComponent = new CustomMessageComponent({ role: "custom", timestamp: 0, ...sent[1]!.message }, renderer, undefined, 1);
    batchComponent.setExpanded(true);
    const expandedBatch = batchComponent.render(160).map(stripTerminalSequences).map((line) => line.trim()).join("\n");
    assert.match(expandedBatch, /member #1 · worker · .* · done · .*produce multiline canoni$/m);
    assert.doesNotMatch(expandedBatch, /canonical tail|"envelope"/);
    assert.equal(`${expanded}\n${expandedBatch}`.split("canonical tail").length - 1, 1);
    component.setExpanded(false);
    component.setOutputPad(2);
    component.invalidate();
    component.render(40);
    batchComponent.setExpanded(false);
    batchComponent.invalidate();
    batchComponent.render(40);
    assert.equal(sent.length, sendsBefore);

    await acknowledgeFixtureReports(fixture, sent.slice(0));
    const parallelStart = sent.length;
    const parallelAck = await tool.execute("loader-parallel", { tasks: [{ agent: "worker", task: "parallel one" }, { agent: "worker", task: "parallel two" }] }, undefined, () => undefined, ctx);
    await waitFor(() => sent.length === parallelStart + 3);
    const parallelReports = sent.slice(parallelStart);
    assert.deepEqual(parallelReports.map((entry) => entry.message.details.envelope.kind), ["result", "result", "batch"]);
    assert.deepEqual(new Set(parallelReports.slice(0, 2).map((entry) => entry.message.details.envelope.identity.runId)), new Set((parallelAck.details as any).children.map((child: any) => child.identity.runId)));
    assertCanonicalReports(parallelReports);
    await acknowledgeFixtureReports(fixture, parallelReports);

    const chainStart = sent.length;
    await tool.execute("loader-chain", { chain: [{ agent: "worker", task: "chain one" }, { agent: "worker", task: "after {previous}" }] }, undefined, () => undefined, ctx);
    await waitFor(() => sent.length === chainStart + 2);
    const chainReports = sent.slice(chainStart);
    assert.deepEqual(chainReports.map((entry) => entry.message.details.envelope.kind), ["chain", "batch"]);
    assert.equal(chainReports[0]!.message.details.envelope.results.length, 2);
    assertCanonicalReports(chainReports);
    await acknowledgeFixtureReports(fixture, chainReports);

    const controlledTask = `${"\0".repeat(24)}visible unknown task`;
    const unknownSingleStart = sent.length;
    const unknownAck = await tool.execute("unknown-single", { agent: "missing", task: controlledTask }, undefined, () => undefined, ctx);
    assert.equal((unknownAck.details as any).display.members[0].taskExcerpt, "visible unknown task");
    await waitFor(() => sent.length === unknownSingleStart + 2);
    assert.equal(sent[unknownSingleStart]!.message.details.envelope.processOutcome, "not_started");
    assert.equal(sent[unknownSingleStart]!.message.details.display.diagnosticCode, "unknown_agent");
    assertCanonicalReports(sent.slice(unknownSingleStart));
    await acknowledgeFixtureReports(fixture, sent.slice(unknownSingleStart));
    const unknownChainStart = sent.length;
    await tool.execute("unknown-chain", { chain: [{ agent: "missing", task: controlledTask }, { agent: "worker", task: "after {previous}" }] }, undefined, () => undefined, ctx);
    await waitFor(() => sent.length === unknownChainStart + 2);
    assert.equal(sent[unknownChainStart]!.message.details.envelope.kind, "chain");
    assert.deepEqual(sent[unknownChainStart]!.message.details.envelope.results.map((entry: any) => entry.processOutcome), ["not_started", "not_started"]);
    assert.equal(sent[unknownChainStart]!.message.details.display.diagnosticCode, "unknown_agent");
    assertCanonicalReports(sent.slice(unknownChainStart));
    await acknowledgeFixtureReports(fixture, sent.slice(unknownChainStart));

    const legacy = { ...sent[0]!.message, details: { envelope: sent[0]!.message.details.envelope } };
    const legacyComponent = new CustomMessageComponent({ role: "custom", timestamp: 0, ...legacy }, renderer, undefined, 1);
    assert.doesNotThrow(() => legacyComponent.render(40));
    legacyComponent.setExpanded(true);
    assert.match(legacyComponent.render(120).map(stripTerminalSequences).join("\n"), /canonical tail/);
    await shutdownFixture(fixture);
  });
});
