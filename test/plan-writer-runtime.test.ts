import assert from "node:assert/strict";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Socket } from "node:net";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DefaultResourceLoader, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openDb } from "../src/db.ts";
import { sha256, type ResultEnvelope } from "../src/subagent-runs.ts";
import { readRecordedPlanBinding } from "../src/plan-binding.ts";
import { acceptScoutArtifact, readPublicationArtifact } from "../src/plan-publication-state.ts";
import { recordWriterDraft, writerDraftFor, type WriterDraftRow } from "../src/workflow-incident-state.ts";

const source = join(import.meta.dirname, "..");

const cases = [
  { name: "YM-221 write-empty-final-record ordinary", final: (path: string) => path, valid: true, writeEmpty: true },
  { name: "YM-221 empty-no-artifact", final: (path: string) => path, valid: false, empty: true, expected: "missing_final", reason: "artifact_not_found" },
  { name: "YM-221 multiple-artifacts", final: (path: string) => path, valid: false, empty: true, multiple: true, expected: "invalid_plan_result", reason: "ambiguous_artifact" },
  { name: "YM-221 writer nonzero", final: (path: string) => path, valid: false, runtimeFault: "nonzero", expected: "incomplete", processOutcome: "exited", exitCode: 7 },
  { name: "YM-221 writer error", final: (path: string) => path, valid: false, runtimeFault: "error", expected: "incomplete", processOutcome: "exited" },
  { name: "YM-221 writer aborted", final: (path: string) => path, valid: false, runtimeFault: "aborted", expected: "incomplete", processOutcome: "exited" },
  { name: "YM-221 writer length", final: (path: string) => path, valid: false, runtimeFault: "length", expected: "incomplete", processOutcome: "exited" },
  { name: "YM-221 writer signal", final: (path: string) => path, valid: false, runtimeFault: "signal", expected: "incomplete", processOutcome: "signaled", signal: "SIGKILL" },
  { name: "YM-221 writer cancellation", final: (path: string) => path, valid: false, runtimeFault: "cancel", expected: "incomplete", processOutcome: "cancelled" },
  { name: "YM-221 writer malformed JSONL", final: (path: string) => path, valid: false, runtimeFault: "protocol_invalid", expected: "protocol_error", processOutcome: "exited" },
  { name: "YM-221 writer partial JSONL", final: (path: string) => path, valid: false, runtimeFault: "protocol_partial", expected: "protocol_error", processOutcome: "exited" },
  { name: "YM-221 writer oversized JSONL", final: (path: string) => path, valid: false, runtimeFault: "protocol_overflow", expected: "protocol_error", processOutcome: "exited" },
  { name: "observed canary path", final: (path: string) => `[k7x2] ${path}`, valid: true },
  { name: "bare path", final: (path: string) => path, valid: true },
  { name: "bare path with spaces", final: (path: string) => path, valid: true, spaced: true },
  { name: "decorated path with spaces", final: (path: string) => `[k7x2] ${path}`, valid: true, spaced: true },
  { name: "bare path with outer whitespace", final: (path: string) => `  ${path}  `, valid: true, spaced: true },
  { name: "decorated path with LF", final: (path: string) => `[k7x2] ${path}\n`, valid: true, spaced: true },
  { name: "decorated path with CRLF", final: (path: string) => `\r\n[k7x2] ${path}\r\n`, valid: true, spaced: true },
  { name: "two paths", final: (path: string) => `${path} ${path}`, valid: false },
  { name: "two lines", final: (path: string) => `[k7x2] ${path}\n${path}`, valid: false },
  { name: "prose prefix", final: (path: string) => `Saved plan: ${path}`, valid: false },
  { name: "prose suffix", final: (path: string) => `[k7x2] ${path} ready`, valid: false },
  { name: "unknown marker", final: (path: string) => `[other] ${path}`, valid: false },
  { name: "repeated marker", final: (path: string) => `[k7x2] [k7x2] ${path}`, valid: false },
  { name: "markdown link", final: (path: string) => `[k7x2] [plan](${path})`, valid: false },
  { name: "code fence", final: (path: string) => `\`\`\`\n${path}\n\`\`\``, valid: false },
  { name: "relative path", final: () => "home/knowledge/org/repo/ai/YM-1/plan.md", valid: false },
  { name: "outside knowledge", final: (path: string) => `[k7x2] ${path}`, valid: false, fault: "outside" },
  { name: "symlink file", final: (path: string) => `[k7x2] ${path}`, valid: false, fault: "symlink" },
  { name: "symlink escape", final: (path: string) => `[k7x2] ${path}`, valid: false, fault: "escape" },
  { name: "foreign ticket", final: (path: string) => `[k7x2] ${path}`, valid: false, fault: "ticket" },
  { name: "foreign writer", final: (path: string) => `[k7x2] ${path}`, valid: false, fault: "writer" },
  { name: "stale writer hash", final: (path: string) => `[k7x2] ${path}`, valid: false, fault: "hash" },
  { name: "foreign accepted input", final: (path: string) => `[k7x2] ${path}`, valid: false, fault: "input" },
  { name: "draft persistence unavailable", final: (path: string) => `[k7x2] ${path}`, valid: false, fault: "draft_unavailable", reason: "artifact_unavailable" },
];

for (const scenario of cases) test(`${scenario.name.startsWith("YM-221") ? scenario.name : `production writer settle and record: ${scenario.name}`}`, { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "plan-writer-runtime-"));
  const runtime = mkdtempSync(join(tmpdir(), "plan-writer-socket-"));
  const priorEnv = { ...process.env };
  const priorArgv = process.argv[1];
  const sockets = new Set<Socket>();
  let beforeFinal: (() => void) | undefined;
  let priorDraft: WriterDraftRow | undefined;
  let writerLaunched = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
    socket.on("data", (chunk) => {
      if (chunk.toString().includes("\n")) {
        const event = JSON.parse(chunk.toString());
        if (event.phase === "child-working") {
          beforeFinal?.();
          if (writerLaunched && scenario.runtimeFault === "signal") process.kill(event.data.pid, "SIGKILL");
        }
        socket.end("release\n");
      }
    });
  });
  let shutdown: (() => Promise<void>) | undefined;
  try {
    const sock = join(runtime, "provider.sock");
    server.listen(sock);
    await once(server, "listening");
    cpSync(join(source, "src"), join(root, "src"), { recursive: true });
    cpSync(join(source, ".pi/extensions/subagent"), join(root, ".pi/extensions/subagent"), { recursive: true });
    mkdirSync(join(root, "test", "fixtures"), { recursive: true });
    cpSync(join(source, "test/fixtures/subagent-json-relay.mjs"), join(root, "test/fixtures/subagent-json-relay.mjs"));
    symlinkSync(join(source, "node_modules"), join(root, "node_modules"));
    mkdirSync(join(root, ".pi/agents"), { recursive: true });
    writeFileSync(join(root, ".pi/agents/plan-scout.md"), "---\nname: plan-scout\ndescription: fixture scout\ntools: read\n---\nInvestigate.\n");
    writeFileSync(join(root, ".pi/agents/plan-writer.md"), "---\nname: plan-writer\ndescription: fixture writer\ntools: read, write\n---\nWrite a plan.\n");
    writeFileSync(join(root, ".pi/settings.json"), "{}");
    writeFileSync(join(root, ".env.local"), "");
    const clone = join(root, "clone");
    mkdirSync(clone);
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-b", "main", clone], { stdio: "pipe" });
    execFileSync("git", ["-C", clone, "remote", "add", "origin", "https://github.com/org/repo.git"]);
    const db = openDb(join(root, "yokemate.db"));
    db.prepare("INSERT INTO project(org,repo,path,tracker,tracker_key,model) VALUES('org','repo',?,'github','YM','ym204-fixture/deterministic')").run(clone);
    db.close();
    const shim = join(root, "shim");
    mkdirSync(shim);
    writeFileSync(join(shim, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const agentDir = join(root, "agent");
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    symlinkSync(join(source, "test/fixtures/subagent-runtime-provider.ts"), join(agentDir, "extensions/provider.ts"));
    Object.assign(process.env, { PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"), YM204_FIXTURE_SOCKET: sock, YM204_FIXTURE_SCENARIO: "plan_scout", XDG_RUNTIME_DIR: runtime, PATH: `${shim}:${priorEnv.PATH ?? ""}` });
    for (const key of ["YOKEMATE_MODE", "YOKEMATE_TICKET", "YOKEMATE_PLAN_RUN_ID", "YOKEMATE_ROLE", "YOKEMATE_RUN_ID", "HERDR_PANE_ID", "YOKEMATE_PARENT_PANE"]) delete process.env[key];
    process.argv[1] = realpathSync(join(source, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"));
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: SettingsManager.create(root, agentDir), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [join(root, ".pi/extensions/subagent/index.ts")] });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    loaded.runtime.appendEntry = () => undefined;
    let resolveReport!: (value: ResultEnvelope) => void;
    const report = new Promise<ResultEnvelope>((resolve) => { resolveReport = resolve; });
    let resolveWriterBatch!: (value: any) => void;
    const writerBatch = new Promise<any>((resolve) => { resolveWriterBatch = resolve; });
    let resolveScout!: (value: any) => void;
    const scoutReport = new Promise<any>((resolve) => { resolveScout = resolve; });
    loaded.runtime.sendMessage = (message) => {
      const envelope = (message.details as any)?.envelope;
      if (envelope?.identity?.agent === "plan-writer") resolveReport(envelope);
      if (envelope?.kind === "batch" && envelope.results?.some((result: any) => result.identity?.agent === "plan-writer")) resolveWriterBatch(envelope);
      if (envelope?.identity?.agent === "plan-scout") resolveScout(envelope);
    };
    const extension = loaded.extensions[0]!;
    const tool = extension.tools.get("subagent")!.definition;
    const ctx = { cwd: root, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "plan-session" }, model: { provider: "ym204-fixture", id: "deterministic" }, modelRegistry: { hasConfiguredAuth: () => true, complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: '{"kind":"approve","evidence":[{"start":0,"end":8,"text":"approved"}]}' }] }) }, ui: { setWidget() {}, notify() {} } } as unknown as ExtensionContext;
    for (const handler of extension.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" } as never, ctx);
    shutdown = async () => { for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" } as never, ctx); };
    await assert.rejects(() => tool.execute("missing", { agent: "plan-writer", task: "write", ticket: "YM-1" }, undefined, () => undefined, ctx), /acceptedInputId/);
    await tool.execute("scout", { agent: "plan-scout", task: "Investigate the fixture.", ticket: "YM-1" }, undefined, () => undefined, ctx);
    const sourceResult = await scoutReport;
    assert.equal(sourceResult.artifact.state, "accepted");
    assert.equal(sourceResult.publication.state, "pending");
    const scout = { id: sourceResult.artifact.acceptanceId };
    Object.assign(process.env, { YOKEMATE_MODE: "plan", YOKEMATE_ROLE: "coordinator" });
    const approach = extension.tools.get("plan_approach")!.definition;
    await approach.execute("approach", { approachText: "Use the fixture writer contract.", treeHash: sha256("YM-1"), acceptedScouts: [{ ticket: "YM-1", acceptanceId: scout.id, hash: sourceResult.artifact.hash }] }, undefined, () => undefined, ctx);
    for (const handler of extension.handlers.get("input") ?? []) await handler({ type: "input", source: "interactive", text: "approved" } as never, ctx);
    delete process.env.YOKEMATE_MODE;
    delete process.env.YOKEMATE_ROLE;
    const slug = scenario.spaced ? "work with spaces" : "work";
    let folder = join(root, "home/knowledge/org/repo/ai", `YM-1-${slug}`);
    mkdirSync(folder, { recursive: true });
    let planPath = join(folder, `YM-1-${slug}-plan.md`);
    const planText = `# ${scenario.fault === "ticket" ? "YM-2" : "YM-1"} — fixture\n\n## Goal\nExercise writer result.\n\n## Affected repositories\n- \`org/repo\` — app\n\n## Steps\n1. Work\n\n## Assumptions\n- Fixture.\n\n## Out of scope\n- Production.\n\n## Acceptance\nThe fixture records the plan.\n`;
    if (!scenario.writeEmpty && !scenario.empty || scenario.multiple) writeFileSync(planPath, planText);
    if (scenario.multiple) {
      const extra = join(root, "home/knowledge/org/repo/ai/YM-1-extra");
      mkdirSync(extra);
      writeFileSync(join(extra, "YM-1-extra-plan.md"), planText);
    }
    if (scenario.fault === "outside") {
      planPath = join(root, "outside.md");
      writeFileSync(planPath, planText);
    } else if (scenario.fault === "symlink") {
      const target = join(root, "symlink-target.md");
      writeFileSync(target, planText);
      rmSync(planPath);
      symlinkSync(target, planPath);
    } else if (scenario.fault === "escape") {
      const outside = join(root, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, `YM-1-${slug}-plan.md`), planText);
      rmSync(folder, { recursive: true });
      symlinkSync(outside, folder);
    }
    const final = scenario.final(planPath);
    const resultFile = join(root, "writer-final.txt");
    writeFileSync(resultFile, final);
    process.env.YM204_FIXTURE_SCENARIO = scenario.writeEmpty ? "plan_writer_write_empty" : scenario.empty ? "missing" : scenario.runtimeFault ? `plan_writer_${scenario.runtimeFault}` : "plan_writer";
    if (scenario.runtimeFault === "protocol_partial" || scenario.runtimeFault === "protocol_overflow") {
      process.env.YOKEMATE_SUBAGENT_TEST_RELAY = join(root, "test/fixtures/subagent-json-relay.mjs");
      process.env.YOKEMATE_SUBAGENT_TEST_FAULT = scenario.runtimeFault === "protocol_partial" ? "eof_without_lf" : "record_overflow";
      process.env.YOKEMATE_SUBAGENT_TEST_MANIFEST_DIR = join(root, "relay-facts");
      mkdirSync(process.env.YOKEMATE_SUBAGENT_TEST_MANIFEST_DIR);
    }
    process.env.YM204_FIXTURE_READ_FILE = resultFile;
    process.env.YM204_FIXTURE_PLAN_PATH = planPath;
    process.env.YM204_FIXTURE_PLAN_CONTENT = planText;
    beforeFinal = () => {
      const state = openDb(join(root, "yokemate.db"));
      try {
        if (scenario.fault === "draft_unavailable") state.exec("CREATE TRIGGER fail_writer_draft BEFORE INSERT ON workflow_writer_draft BEGIN SELECT RAISE(ABORT, 'fixture unavailable'); END");
        if (["writer", "hash", "input"].includes(scenario.fault ?? "")) {
          const dispatch = state.prepare("SELECT * FROM workflow_writer_dispatch").get()!;
          const acceptedInputId = scenario.fault === "input"
            ? acceptScoutArtifact(state, root, { ...sourceResult.identity, ownerSessionId: "foreign-session", runId: "foreign-scout" }, readPublicationArtifact(root, { artifact_path: sourceResult.artifact.path, content_hash: sourceResult.artifact.hash, bytes: sourceResult.artifact.bytes })).id
            : scout.id;
          priorDraft = recordWriterDraft(state, {
            content_hash: sha256(planText), accepted_input_id: acceptedInputId,
            planning_identity: String(dispatch.planning_identity),
            writer_run_id: scenario.fault === "writer" ? "foreign-writer" : String(dispatch.writer_run_id),
            writer_task_hash: String(dispatch.task_hash),
            writer_actual_task_hash: scenario.fault === "hash" ? sha256("stale") : String(dispatch.actual_task_hash),
            plan_path: planPath, bytes: Buffer.byteLength(planText), result_hash: sha256(final),
          });
        }
      } finally { state.close(); }
    };
    writerLaunched = true;
    const launched = await tool.execute("writer", { agent: "plan-writer", task: "Write from the accepted source.", ticket: "YM-1", acceptedInputId: scout.id }, undefined, () => undefined, ctx);
    assert.match(JSON.stringify(launched), /Detached, not terminal/);
    if (scenario.runtimeFault === "cancel") {
      const runId = (launched.details as any).children[0].identity.runId;
      const cancelled = await tool.execute("cancel-writer", { cancelRun: runId }, undefined, () => undefined, ctx);
      assert.match(JSON.stringify(cancelled), /cancellation_requested|cancelled/);
    }
    const result = await report;
    const batch = await writerBatch;
    beforeFinal = undefined;
    assert.equal(result.processOutcome, scenario.processOutcome ?? "exited");
    assert.equal(result.exitCode, scenario.exitCode ?? (scenario.processOutcome === "signaled" || scenario.processOutcome === "cancelled" ? null : 0));
    assert.equal(result.signal, scenario.signal ?? null);
    assert.equal(result.payloadOutcome, scenario.valid ? "valid" : scenario.expected ?? "invalid_plan_result");
    assert.equal(batch.results[0].payloadOutcome, result.payloadOutcome);
    assert.equal(batch.results[0].processOutcome, result.processOutcome);
    assert.equal(result.payload, scenario.valid ? scenario.writeEmpty ? planPath : final : "");
    if (scenario.runtimeFault) assert.equal(result.planResult, undefined);
    if (scenario.reason) {
      assert.equal(result.planResult?.state, "rejected");
      assert.equal((result.planResult as any).reason, scenario.reason);
    }
    if (scenario.writeEmpty) {
      assert.equal(result.planResult?.state, "verified");
      assert.equal(result.planResult?.source, "reconciled");
      assert.equal(readFileSync(planPath, "utf8"), planText);
    }
    const state = openDb(join(root, "yokemate.db"));
    const dispatch = state.prepare("SELECT * FROM workflow_writer_dispatch").get() as any;
    const draft = writerDraftFor(state, sha256(planText));
    if (scenario.valid) {
      assert.equal(draft?.plan_path, planPath);
      assert.equal(draft?.result_hash, sha256(final));
      assert.equal(draft?.writer_run_id, result.identity.runId);
      assert.equal(draft?.writer_task_hash, result.identity.taskHash);
      assert.equal(draft?.writer_actual_task_hash, result.actualTaskHash);
      assert.equal(draft?.accepted_input_id, scout.id);
      const recordsBefore = state.prepare("SELECT COUNT(*) AS count FROM plan_record").get()!.count;
      await assert.rejects(promisify(execFile)(process.execPath, ["--experimental-strip-types", "--no-warnings", join(root, "src/plan-ticket.ts"), "YM-1", planPath], { cwd: root, env: { ...process.env, PI_SESSION_ID: "plan-session" } }), (error: any) => /--content-hash/.test(error.stderr));
      await assert.rejects(promisify(execFile)(process.execPath, ["--experimental-strip-types", "--no-warnings", join(root, "src/plan-ticket.ts"), "YM-1", planPath, "--content-hash", "0".repeat(64)], { cwd: root, env: { ...process.env, PI_SESSION_ID: "plan-session" } }), (error: any) => /binding_changed/.test(error.stderr));
      assert.equal(state.prepare("SELECT COUNT(*) AS count FROM plan_record").get()!.count, recordsBefore);
      const recorded = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--no-warnings", join(root, "src/plan-ticket.ts"), "YM-1", planPath, "--content-hash", sha256(planText)], { cwd: root, env: { ...process.env, PI_SESSION_ID: "plan-session" } });
      assert.match(recorded.stdout, /plan-only; ready for \/do/);
      assert.equal(readRecordedPlanBinding(root, "YM-1").contentHash, sha256(planText));
      assert.equal(state.prepare("SELECT stage FROM work WHERE ticket='YM-1'").get()?.stage, "planned");
    } else {
      assert.deepEqual(draft, priorDraft);
      assert.equal(state.prepare("SELECT stage FROM work WHERE ticket='YM-1'").get(), undefined);
    }
    assert.equal(dispatch.dispatch_kind, "initial");
    assert.notEqual(dispatch.task_hash, dispatch.actual_task_hash);
    state.prepare("DELETE FROM project WHERE tracker_key='YM'").run();
    process.env.YM204_FIXTURE_SCENARIO = "plan_scout";
    await assert.rejects(() => tool.execute("writer-repeat", { agent: "plan-writer", task: "Write again from the same current source.", ticket: "YM-1" }, undefined, () => undefined, ctx), /scope_not_found/);
    await assert.rejects(() => tool.execute("writer-repeat-parallel", { tasks: [{ agent: "plan-writer", task: "Write in parallel from the same current source.", ticket: "YM-1" }] }, undefined, () => undefined, ctx), /scope_not_found/);
    await assert.rejects(() => tool.execute("writer-repeat-chain", { chain: [{ agent: "plan-writer", task: "Write in chain from the same current source.", ticket: "YM-1" }] }, undefined, () => undefined, ctx), /scope_not_found/);
    assert.equal(state.prepare("SELECT COUNT(*) AS count FROM workflow_writer_dispatch WHERE accepted_input_id=?").get(String(scout.id))!.count, 1);
    assert.equal(state.prepare("SELECT COUNT(*) AS count FROM workflow_writer_dispatch").get()!.count, 1);
    state.close();
  } finally {
    await shutdown?.();
    process.argv[1] = priorArgv;
    for (const key of Object.keys(process.env)) if (!(key in priorEnv)) delete process.env[key];
    Object.assign(process.env, priorEnv);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});
