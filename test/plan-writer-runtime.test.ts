import assert from "node:assert/strict";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Socket } from "node:net";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  { name: "observed canary path", final: (path: string) => `[k7x2] ${path}`, valid: true },
  { name: "bare path", final: (path: string) => path, valid: true },
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
];

for (const scenario of cases) test(`production writer settle and record: ${scenario.name}`, { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "plan-writer-runtime-"));
  const runtime = mkdtempSync(join(tmpdir(), "plan-writer-socket-"));
  const priorEnv = { ...process.env };
  const priorArgv = process.argv[1];
  const sockets = new Set<Socket>();
  let beforeFinal: (() => void) | undefined;
  let priorDraft: WriterDraftRow | undefined;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("data", (chunk) => {
      if (chunk.toString().includes("\n")) {
        if (JSON.parse(chunk.toString()).phase === "child-working") beforeFinal?.();
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
    symlinkSync(join(source, "node_modules"), join(root, "node_modules"));
    mkdirSync(join(root, ".pi/agents"), { recursive: true });
    writeFileSync(join(root, ".pi/agents/plan-scout.md"), "---\nname: plan-scout\ndescription: fixture scout\ntools: read\n---\nInvestigate.\n");
    writeFileSync(join(root, ".pi/agents/plan-writer.md"), "---\nname: plan-writer\ndescription: fixture writer\ntools: read\n---\nWrite a plan.\n");
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
    let report = new Promise<ResultEnvelope>((resolve) => { resolveReport = resolve; });
    let resolveScout!: (value: any) => void;
    const scoutReport = new Promise<any>((resolve) => { resolveScout = resolve; });
    loaded.runtime.sendMessage = (message) => {
      const envelope = (message.details as any)?.envelope;
      if (envelope?.identity?.agent === "plan-writer") resolveReport(envelope);
      if (envelope?.identity?.agent === "plan-scout") resolveScout(envelope);
    };
    const extension = loaded.extensions[0]!;
    const tool = extension.tools.get("subagent")!.definition;
    const ctx = { cwd: root, mode: "rpc", hasUI: false, sessionManager: { getSessionId: () => "plan-session" }, model: { provider: "ym204-fixture", id: "deterministic" }, modelRegistry: { hasConfiguredAuth: () => true }, ui: { setWidget() {}, notify() {} } } as unknown as ExtensionContext;
    for (const handler of extension.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" } as never, ctx);
    shutdown = async () => { for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" } as never, ctx); };
    await assert.rejects(() => tool.execute("missing", { agent: "plan-writer", task: "write", ticket: "YM-1" }, undefined, () => undefined, ctx), /acceptedInputId/);
    await tool.execute("scout", { agent: "plan-scout", task: "Investigate the fixture.", ticket: "YM-1" }, undefined, () => undefined, ctx);
    const sourceResult = await scoutReport;
    assert.equal(sourceResult.artifact.state, "accepted");
    assert.equal(sourceResult.publication.state, "pending");
    const scout = { id: sourceResult.artifact.acceptanceId };
    const folder = join(root, "home/knowledge/org/repo/ai/YM-1");
    mkdirSync(folder, { recursive: true });
    let planPath = join(folder, "plan.md");
    const planText = `# ${scenario.fault === "ticket" ? "YM-2" : "YM-1"} — fixture\n\n## Goal\nExercise writer result.\n\n## Affected repositories\n- \`org/repo\` — app\n\n## Steps\n1. Work\n\n## Assumptions\n- Fixture.\n\n## Out of scope\n- Production.\n\n## Acceptance\nThe fixture records the plan.\n`;
    writeFileSync(planPath, planText);
    if (scenario.fault === "outside") {
      planPath = join(root, "outside.md");
      writeFileSync(planPath, planText);
    } else if (scenario.fault === "symlink") {
      symlinkSync(planPath, join(folder, "link.md"));
      planPath = join(folder, "link.md");
    } else if (scenario.fault === "escape") {
      const outside = join(root, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "plan.md"), planText);
      symlinkSync(outside, join(folder, "escape"));
      planPath = join(folder, "escape/plan.md");
    }
    const final = scenario.final(planPath);
    const resultFile = join(root, "writer-final.txt");
    writeFileSync(resultFile, final);
    process.env.YM204_FIXTURE_SCENARIO = "plan_writer";
    process.env.YM204_FIXTURE_READ_FILE = resultFile;
    beforeFinal = () => {
      const state = openDb(join(root, "yokemate.db"));
      try {
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
    const launched = await tool.execute("writer", { agent: "plan-writer", task: "Write from the accepted source.", ticket: "YM-1", acceptedInputId: scout.id }, undefined, () => undefined, ctx);
    assert.match(JSON.stringify(launched), /Detached, not terminal/);
    const result = await report;
    beforeFinal = undefined;
    assert.equal(result.processOutcome, "exited");
    assert.equal(result.exitCode, 0);
    assert.equal(result.payloadOutcome, scenario.valid ? "valid" : "protocol_error");
    assert.equal(result.payload, scenario.valid ? final : "");
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
      const recorded = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--no-warnings", join(root, "src/plan-ticket.ts"), "YM-1", planPath], { cwd: root, env: { ...process.env, PI_SESSION_ID: "plan-session" } });
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
    report = new Promise<ResultEnvelope>((resolve) => { resolveReport = resolve; });
    const repeated = await tool.execute("writer-repeat", { agent: "plan-writer", task: "Write again from the same current source.", ticket: "YM-1" }, undefined, () => undefined, ctx);
    assert.match(JSON.stringify(repeated), /Detached, not terminal/);
    await report;
    assert.equal(state.prepare("SELECT COUNT(*) AS count FROM workflow_writer_dispatch WHERE accepted_input_id=?").get(String(scout.id))!.count, 2);
    assert.equal(state.prepare("SELECT COUNT(*) AS count FROM workflow_writer_dispatch").get()!.count, 2);
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
