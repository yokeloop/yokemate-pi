import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { DefaultResourceLoader, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { currentControlOrigin, requestReviewControl, resolveCoordinatorParent } from "../src/coordinator-control.ts";
import { openDb } from "../src/db.ts";
import { socketDir } from "../src/inbox.ts";

const source = join(import.meta.dirname, "..");
const planText = (ticket: string, goal: string) => `# ${ticket} — rework\n\n## Goal\n${goal}\n\n## Affected repositories\n- \`org/repo\` — app\n\n## Steps\n1. Fix the agreed remark.\n\n## Assumptions\n- Existing stand.\n\n## Out of scope\n- Other work.\n\n## Acceptance\nThe agreed remark is fixed.\n`;

async function loadExtension(root: string, agentDir: string) {
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: SettingsManager.create(root, agentDir), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [join(root, ".pi", "extensions", "subagent", "index.ts")] });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  loaded.runtime.appendEntry = () => undefined;
  loaded.runtime.sendMessage = () => undefined;
  return loaded.extensions[0]!;
}

async function runCase(workflowApproval: boolean, entry: "node" | "package") {
  const dir = mkdtempSync(join(import.meta.dirname, "fixtures", "review-rework-runtime-"));
  const runtime = mkdtempSync(join(tmpdir(), "ym-review-rework-"));
  const savedEnv = { ...process.env };
  const savedArgv = process.argv[1];
  let mainShutdown: (() => Promise<void>) | undefined;
  let workerShutdown: (() => Promise<void>) | undefined;
  try {
    cpSync(join(source, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(source, ".pi", "extensions", "subagent"), join(dir, ".pi", "extensions", "subagent"), { recursive: true });
    cpSync(join(source, ".pi", "agents", "do"), join(dir, ".pi", "agents", "do"), { recursive: true });
    cpSync(join(source, "package.json"), join(dir, "package.json"));
    mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
    writeFileSync(join(dir, ".pi", "agents", "do-coordinator.md"), "fixture");
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ guardPolicy: { workflowApproval, guards: { duplicateDo: false, duplicateMode: false } } }));
    writeFileSync(join(dir, ".env.local"), "");
    const oldPlanDir = join(dir, "home", "knowledge", "org", "repo", "ai", "YM-1-old");
    const reworkDir = join(dir, "home", "knowledge", "org", "repo", "ai", "YM-1-rework");
    mkdirSync(oldPlanDir, { recursive: true });
    mkdirSync(reworkDir, { recursive: true });
    const oldPlan = join(oldPlanDir, "plan.md");
    const reworkPlan = join(reworkDir, "plan.md");
    writeFileSync(oldPlan, planText("YM-1", "Exercise the original implementation."));
    writeFileSync(reworkPlan, planText("YM-1", "Apply the accepted review rework."));
    const clone = join(dir, "clone");
    mkdirSync(clone);
    execFileSync("git", ["init", "-b", "main", clone], { stdio: "pipe" });
    const db = openDb(join(dir, "yokemate.db"));
    db.prepare("INSERT INTO project (org,repo,path,tracker,tracker_key,model,mode_models) VALUES ('org','repo',?,'github','YM','test/model',?)").run(clone, JSON.stringify({ review: "test/review", do: "test/model" }));
    db.prepare("INSERT INTO work (ticket,url,stage,folder,plan) VALUES ('YM-1','u','review',?,?)").run(join(dir, "work", "YM-1"), oldPlan);
    const work = db.prepare("SELECT id FROM work WHERE ticket='YM-1'").get() as { id: number };
    db.prepare("INSERT INTO part (work_id,repo,role,branch,pr) VALUES (?, 'org/repo','app','YM-1','https://example/pr')").run(work.id);
    db.close();
    const shim = join(dir, "shim");
    const closeLog = join(dir, "close.jsonl");
    mkdirSync(shim);
    writeFileSync(closeLog, "");
    writeFileSync(join(shim, "herdr"), `#!${process.execPath}\nimport fs from "node:fs"; const args=process.argv.slice(2); fs.appendFileSync(process.env.REVIEW_CLOSE_LOG,JSON.stringify(args)+"\\n"); console.log(JSON.stringify({result:{}}));\n`, { mode: 0o755 });
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir, { recursive: true });
    Object.assign(process.env, { XDG_RUNTIME_DIR: runtime, PATH: `${shim}:${savedEnv.PATH ?? ""}`, REVIEW_CLOSE_LOG: closeLog, HERDR_PANE_ID: "main-pane", PI_SESSION_ID: "parent-session", PI_CODING_AGENT_DIR: agentDir });
    for (const key of ["YOKEMATE_MODE", "YOKEMATE_ROLE", "YOKEMATE_TICKET", "YOKEMATE_REVIEW_RUN_ID", "YOKEMATE_REVIEW_RUNTIME_ID", "YOKEMATE_PARENT_PANE"]) delete process.env[key];
    process.argv[1] = join(source, "test", "fixtures", "workflow-rpc-child.mjs");
    const runtimeDir = socketDir(process.env, process.getuid!());
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, "main-pane.json"), JSON.stringify({ pid: process.pid, cwd: dir, mode: "main", ticket: null }));
    writeFileSync(join(runtimeDir, "review-pane.json"), JSON.stringify({ pid: process.pid, cwd: dir, mode: "review", ticket: "YM-1" }));
    const notifications: string[] = [];
    let confirms = 0;
    const modelRegistry = {
      getAll: () => [{ provider: "test", id: "review", name: "review" }, { provider: "test", id: "model", name: "model" }],
      hasConfiguredAuth: () => true,
      complete: async (_model: unknown, context: { messages: { content: string }[] }) => {
        const raw = JSON.parse(context.messages[0]!.content).raw as string;
        return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ kind: "rework", evidence: [{ start: 0, end: raw.length, text: raw }] }) }] };
      },
    };
    const ui = { setWidget() {}, notify(message: string) { notifications.push(message); }, confirm: async () => { confirms++; return true; } };
    const mainCtx = { cwd: dir, mode: "rpc", hasUI: true, sessionManager: { getSessionId: () => "parent-session" }, model: { provider: "test", id: "review" }, modelRegistry, ui } as unknown as ExtensionContext;
    const main = await loadExtension(dir, agentDir);
    for (const handler of main.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" } as never, mainCtx);
    mainShutdown = async () => { for (const handler of main.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" } as never, mainCtx); };
    const parent = resolveCoordinatorParent(dir, process.env);
    const registered = await requestReviewControl(dir, "register-review", { ticket: "YM-1" }, currentControlOrigin(dir, "parent-session"), parent, process.env);
    assert.equal(registered.state, "accepted", registered.reason ?? "review registration refused");
    const reviewRunId = registered.runId!;
    const bound = await requestReviewControl(dir, "bind-review", { ticket: "YM-1", runId: reviewRunId, pane: "review-pane", surface: "tab", tabId: "review-tab" }, currentControlOrigin(dir, "parent-session"), parent, process.env);
    assert.equal(bound.state, "accepted", bound.reason ?? "review binding refused");
    Object.assign(process.env, { YOKEMATE_MODE: "review", YOKEMATE_ROLE: "coordinator", YOKEMATE_TICKET: "YM-1", YOKEMATE_REVIEW_RUN_ID: reviewRunId, YOKEMATE_REVIEW_RUNTIME_ID: "review-runtime", YOKEMATE_PARENT_PANE: "main-pane", HERDR_PANE_ID: "review-pane", PI_SESSION_ID: "review-session" });
    const workerCtx = { ...mainCtx, mode: "tui", sessionManager: { getSessionId: () => "review-session" } } as unknown as ExtensionContext;
    const worker = await loadExtension(dir, agentDir);
    for (const handler of worker.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" } as never, workerCtx);
    workerShutdown = async () => { for (const handler of worker.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" } as never, workerCtx); };
    const command = entry === "package" ? "pnpm" : process.execPath;
    const args = entry === "package" ? ["accept", "YM-1", "--rework", reworkPlan] : ["--experimental-strip-types", "--no-warnings", "src/accept.ts", "YM-1", "--rework", reworkPlan];
    const accept = () => promisify(execFile)(command, args, { cwd: dir, env: { ...process.env }, timeout: 30000 });
    const parseOutput = (stdout: unknown, stderr: unknown = "") => {
      for (const line of `${String(stdout ?? "")}\n${String(stderr ?? "")}`.trim().split("\n").reverse()) {
        try { return JSON.parse(line); } catch {}
      }
      throw new Error(`no JSON outcome in accept output: ${String(stdout)} ${String(stderr)}`);
    };
    for (const handler of worker.handlers.get("input") ?? []) await handler({ type: "input", source: "extension", text: "Итог: отправляй на доработку" } as never, workerCtx);
    await assert.rejects(accept, (error: any) => /approval is missing|stale/.test(String(error.stderr)));
    for (const handler of worker.handlers.get("input") ?? []) await handler({ type: "input", source: "interactive", text: "Итог: отправляй на доработку" } as never, { ...workerCtx, mode: "rpc" } as ExtensionContext);
    await assert.rejects(accept, (error: any) => /approval is missing|stale/.test(String(error.stderr)));
    if (workflowApproval) {
      const failedDb = openDb(join(dir, "yokemate.db"));
      failedDb.prepare("UPDATE project SET mode_models=? WHERE tracker_key='YM'").run(JSON.stringify({ review: "test/review", do: "missing/model" }));
      failedDb.close();
      for (const handler of worker.handlers.get("input") ?? []) await handler({ type: "input", source: "interactive", text: "Итог: отправляй на доработку" } as never, workerCtx);
      let failed: any;
      try { await accept(); assert.fail("missing do model must refuse startup"); } catch (error) { failed = error; }
      const failure = parseOutput(failed.stdout, failed.stderr) as { state: string; recorded: boolean; reason: string; stage: string; plan: string; contentHash: string };
      assert.equal(failure.state, "refused");
      assert.equal(failure.recorded, true);
      assert.equal(failure.stage, "planned");
      assert.equal(failure.plan, reworkPlan);
      assert.match(failure.reason, /missing\/model/);
      assert.equal(readFileSync(closeLog, "utf8"), "");
      const repairedDb = openDb(join(dir, "yokemate.db"));
      repairedDb.prepare("UPDATE project SET mode_models=? WHERE tracker_key='YM'").run(JSON.stringify({ review: "test/review", do: "test/model" }));
      repairedDb.close();
      let repeated: any;
      try { await accept(); assert.fail("old verdict must not retry"); } catch (error) { repeated = error; }
      assert.deepEqual(parseOutput(repeated.stdout, repeated.stderr), failure);
      for (const handler of worker.handlers.get("input") ?? []) await handler({ type: "input", source: "interactive", text: "После исправления снова отправляй на доработку" } as never, workerCtx);
    } else {
      for (const handler of worker.handlers.get("input") ?? []) await handler({ type: "input", source: "interactive", text: "Итог: отправляй на доработку" } as never, workerCtx);
    }
    const result = await accept();
    const outcome = parseOutput(result.stdout, result.stderr) as { state: string; recorded: boolean; runId: string; model: string; plan: string; contentHash: string; close: { state: string } };
    assert.equal(outcome.state, "started");
    assert.equal(outcome.recorded, true);
    assert.equal(outcome.plan, reworkPlan);
    assert.equal(outcome.model, "test/model");
    assert.equal(outcome.close.state, "closed");
    const current = openDb(join(dir, "yokemate.db"));
    assert.equal(current.prepare("SELECT stage FROM work WHERE ticket='YM-1'").get()!.stage, "running");
    assert.equal(current.prepare("SELECT plan FROM work WHERE ticket='YM-1'").get()!.plan, reworkPlan);
    assert.equal(current.prepare("SELECT COUNT(*) AS count FROM part WHERE work_id=?").get(work.id)!.count, 1);
    current.close();
    assert.equal(readFileSync(join(dir, "work", "YM-1", "fixture-runs"), "utf8").trim(), outcome.runId);
    assert.deepEqual(readFileSync(closeLog, "utf8").trim().split("\n").map((line) => JSON.parse(line)), [["tab", "close", "review-tab"]]);
    assert.equal(confirms, 0);
    assert.match(notifications.join("\n"), new RegExp(`YM-1: rework .* \\(${outcome.contentHash}\\) recorded; do ${outcome.runId} started with test/model`));
  } finally {
    await workerShutdown?.();
    await mainShutdown?.();
    process.argv[1] = savedArgv;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(dir, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
}

test("owned review verdict records, starts and closes for both workflowApproval values", { timeout: 120000 }, async () => {
  await runCase(false, "node");
  await runCase(true, "package");
});

