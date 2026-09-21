import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = realpathSync(process.argv[2]);
const plan = path.resolve(process.argv[3]);
const source = realpathSync(process.argv[4]);
const runId = process.argv[5] === "-" ? undefined : process.argv[5];
const pane = process.argv[6] ?? "save-only-pane";
const sessionId = process.argv[7] ?? "save-only-session";
const { socketDir } = await import(pathToFileURL(path.join(root, "src", "inbox.ts")).href);
const { processStarttime, currentControlOrigin, requestPlanControl, resolveCoordinatorParent } = await import(pathToFileURL(path.join(root, "src", "coordinator-control.ts")).href);
writeFileSync(path.join(socketDir(process.env, process.getuid()), `${pane}.json`), JSON.stringify({ pid: process.pid, starttime: processStarttime(process.pid), cwd: root, mode: "plan", ticket: "YM-1", sessionId, parentPane: "main-pane" }));
Object.assign(process.env, {
  PI_SESSION_ID: sessionId,
  PI_SESSION_FILE: path.join(root, "save-only.jsonl"),
  YOKEMATE_MODE: "plan",
  YOKEMATE_TICKET: "YM-1",
  YOKEMATE_ROLE: "coordinator",
  HERDR_PANE_ID: pane,
  YOKEMATE_PARENT_PANE: "main-pane",
});
if (runId) {
  process.env.YOKEMATE_PLAN_RUN_ID = runId;
  process.env.YOKEMATE_RUN_ID = runId;
} else {
  delete process.env.YOKEMATE_PLAN_RUN_ID;
  delete process.env.YOKEMATE_RUN_ID;
}
delete process.env.YOKEMATE_SUBAGENT_TEST_RELAY;
delete process.env.YOKEMATE_SUBAGENT_TEST_TARGET;
const loader = new DefaultResourceLoader({ cwd: root, agentDir: path.join(root, "agent"), settingsManager: SettingsManager.create(root, path.join(root, "agent")), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [path.join(root, ".pi", "extensions", "subagent", "index.ts")] });
await loader.reload();
const loaded = loader.getExtensions();
if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
loaded.runtime.appendEntry = () => undefined;
let resolveScout;
let resolveWriter;
const scoutReport = new Promise((resolve) => { resolveScout = resolve; });
const writerReport = new Promise((resolve) => { resolveWriter = resolve; });
loaded.runtime.sendMessage = (message) => {
  const envelope = message?.details?.envelope;
  if (envelope?.kind === "result" && envelope.identity?.agent === "plan-scout" && envelope.identity.batchId === "save-only-scout") resolveScout(envelope);
  if (envelope?.kind === "result" && envelope.identity?.agent === "plan-writer" && envelope.identity.batchId === "save-only-writer") resolveWriter(envelope);
};
const extension = loaded.extensions[0];
const tool = extension.tools.get("subagent").definition;
const ctx = { cwd: root, mode: "rpc", hasUI: true, sessionManager: { getSessionId: () => sessionId }, model: { provider: "ym204-fixture", id: "deterministic" }, modelRegistry: { getAll: () => [{ provider: "ym204-fixture", id: "deterministic", name: "Deterministic", reasoning: true }], hasConfiguredAuth: () => true }, ui: { setWidget() {}, notify() {}, confirm: async () => true } };
const previousArgv = process.argv[1];
process.argv[1] = realpathSync(path.join(source, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"));
for (const handler of extension.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
for (const handler of extension.handlers.get("turn_start") ?? []) await handler({ type: "turn_start" }, ctx);
await tool.execute("save-only-scout", { agent: "plan-scout", task: "Return the complete fixture investigation.", ticket: "YM-1" }, undefined, () => undefined, ctx);
const scout = await Promise.race([scoutReport, new Promise((_, reject) => setTimeout(() => reject(new Error("plan scout timeout")), 30000))]);
let foreign;
if (process.env.WORKFLOW_FOREIGN_SCOUT === "1" && runId) foreign = await requestPlanControl(root, "publish-plan-scout", { ticket: "YM-1", runId, acceptanceId: scout.artifact.acceptanceId, child: { ...scout.identity, ownerRunId: "foreign-owner" } }, currentControlOrigin(root, sessionId), resolveCoordinatorParent(root));
if (process.env.WORKFLOW_PLAN_WORKER_SCOUT_RESULT && process.env.WORKFLOW_PLAN_WORKER_CONTINUE) {
  writeFileSync(process.env.WORKFLOW_PLAN_WORKER_SCOUT_RESULT, JSON.stringify(scout));
  const deadline = Date.now() + 30000;
  while (!existsSync(process.env.WORKFLOW_PLAN_WORKER_CONTINUE)) {
    if (Date.now() >= deadline) throw new Error("plan worker continuation timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
process.env.YM204_FIXTURE_SCENARIO = "plan_writer_write_empty";
process.env.YM204_FIXTURE_PLAN_PATH = plan;
process.env.YM204_FIXTURE_PLAN_CONTENT = readFileSync(plan, "utf8");
await tool.execute("save-only-writer", { agent: "plan-writer", task: "Write the exact scoped fixture plan.", ticket: "YM-1", acceptedInputId: scout.artifact.acceptanceId }, undefined, () => undefined, ctx);
const writer = await Promise.race([writerReport, new Promise((_, reject) => setTimeout(() => reject(new Error("plan writer timeout")), 30000))]);
if (writer.payloadOutcome !== "valid" || writer.planResult?.state !== "verified") throw new Error(`plan writer failed: ${writer.payloadOutcome}/${writer.planResult?.reason ?? "unknown"}`);
const reviewed = readFileSync(writer.planResult.binding.path);
if (createHash("sha256").update(reviewed).digest("hex") !== writer.planResult.binding.contentHash) throw new Error("reviewed writer binding changed");
process.argv[1] = previousArgv;
const recorded = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--no-warnings", path.join(root, "src", "plan-ticket.ts"), "YM-1", writer.planResult.binding.path, "--content-hash", writer.planResult.binding.contentHash], { cwd: root, env: { ...process.env, PI_SESSION_ID: sessionId } });
for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, ctx);
process.stdout.write(`PLAN_WORKER_RESULT ${JSON.stringify({ scout, writer, foreign, stdout: recorded.stdout, stderr: recorded.stderr })}\n`);
