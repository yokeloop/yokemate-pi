import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { DefaultResourceLoader, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openDb } from "../src/db.ts";
import { acceptScoutArtifact } from "../src/plan-publication-state.ts";
import { readRecordedPlanBinding } from "../src/plan-binding.ts";
import { currentControlOrigin, processStarttime, requestPlanControl, requestPlanLaunch, resolveCoordinatorParent } from "../src/coordinator-control.ts";
import { socketDir } from "../src/inbox.ts";

const source = join(import.meta.dirname, "..");

async function waitForFile(path: string, timeout = 15000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("raw interactive authority flows through real plan CLI and parent control without a second do confirm", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(import.meta.dirname, "fixtures", "workflow-runtime-"));
  const runtime = mkdtempSync(join(tmpdir(), "ym-authority-"));
  const env = { ...process.env };
  const script = process.argv[1];
  const eventConnections: Socket[] = [];
  const eventServer = createServer((socket) => eventConnections.push(socket));
  const providerSockets = new Set<Socket>();
  const providerServer = createServer((socket) => {
    providerSockets.add(socket);
    socket.once("close", () => providerSockets.delete(socket));
    socket.on("data", (chunk) => { if (chunk.toString().includes("\n")) socket.end("release\n"); });
  });
  let shutdown: (() => Promise<void>) | undefined;
  try {
    const eventSocket = join(runtime, "review.sock");
    const providerSocket = join(runtime, "provider.sock");
    eventServer.listen(eventSocket);
    providerServer.listen(providerSocket);
    await Promise.all([once(eventServer, "listening"), once(providerServer, "listening")]);
    process.env.WORKFLOW_EVENT_SOCKET = eventSocket;
    process.env.YM204_FIXTURE_SOCKET = providerSocket;
    process.env.YM204_FIXTURE_SCENARIO = "plan_scout";
    delete process.env.YOKEMATE_MODE;
    delete process.env.YOKEMATE_ROLE;
    delete process.env.YOKEMATE_RUN_ID;
    delete process.env.YOKEMATE_PARENT_RUN_ID;
    delete process.env.HERDR_PANE_ID;
    delete process.env.YOKEMATE_PARENT_PANE;
    process.env.XDG_RUNTIME_DIR = runtime;
    process.argv[1] = join(source, "test", "fixtures", "workflow-rpc-child.mjs");
    cpSync(join(source, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(source, ".pi", "extensions", "subagent"), join(dir, ".pi", "extensions", "subagent"), { recursive: true });
    mkdirSync(join(dir, ".pi", "agents", "do"), { recursive: true });
    writeFileSync(join(dir, ".pi", "agents", "do-coordinator.md"), "fixture");
    writeFileSync(join(dir, ".pi", "agents", "plan-scout.md"), "---\nname: plan-scout\ndescription: fixture scout\ntools: read\n---\nReturn complete scout Markdown.\n");
    const agentDir = join(dir, "agent");
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    symlinkSync(join(source, "test/fixtures/subagent-runtime-provider.ts"), join(agentDir, "extensions/provider.ts"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.PI_SESSION_ID;
    writeFileSync(join(dir, ".env.local"), "");
    const settings = join(dir, ".pi", "settings.json");
    const set = (workflowApproval: boolean, guards = {}) => writeFileSync(settings, JSON.stringify({ guardPolicy: { workflowApproval, guards } }));
    set(false);
    const folder = join(dir, "home", "knowledge", "org", "repo", "ai", "YM-1-work");
    mkdirSync(folder, { recursive: true });
    const plan = join(folder, "plan.md");
    const text = "# YM-1 — fixture\n\n## Goal\nExercise authority.\n\n## Affected repositories\n- `org/repo` — app\n\n## Steps\n1. Work\n\n## Assumptions\n- Fixture.\n\n## Out of scope\n- Production.\n\n## Acceptance\nThe fixture records the plan.\n";
    writeFileSync(plan, text);
    const clone = join(dir, "clone");
    mkdirSync(clone);
    execFileSync("git", ["init", "-b", "main", clone], { stdio: "pipe" });
    execFileSync("git", ["-C", clone, "remote", "add", "origin", "https://github.com/org/repo.git"], { stdio: "pipe" });
    const commentsFile = join(dir, "comments.json");
    writeFileSync(commentsFile, "[]");
    const shim = join(dir, "shim");
    mkdirSync(shim);
    writeFileSync(join(shim, "gh"), `#!${process.execPath}\nimport fs from "node:fs";\nconst args=process.argv.slice(2); const file=process.env.WORKFLOW_COMMENTS; const rows=JSON.parse(fs.readFileSync(file,"utf8"));\nif(args[0]==="api"){const page=Number(/&page=(\\d+)/.exec(args[1])[1]); console.log(JSON.stringify(rows.slice((page-1)*100,page*100)));}\nelse if(args[0]==="issue"&&args[1]==="comment"){let body=""; process.stdin.setEncoding("utf8"); process.stdin.on("data",c=>body+=c); process.stdin.on("end",()=>{const kind=/\"kind\":\"(scout|plan)\"/.exec(body)?.[1]; if(process.env.WORKFLOW_GH_CONFLICT_KIND===kind){const metadata=JSON.parse(body.slice("<!-- yokemate-plan-publication:".length,body.indexOf(" -->"))); const conflict=body.slice(0,"<!-- yokemate-plan-publication:".length)+JSON.stringify({...metadata,run:metadata.run+"-conflict"})+body.slice(body.indexOf(" -->")); for(const text of [body,conflict]) rows.push({id:rows.length+1,body:text,html_url:"https://github.com/org/repo/issues/1#issuecomment-"+(rows.length+1)}); fs.writeFileSync(file,JSON.stringify(rows)); console.error("comment conflict"); process.exit(1);} if(process.env.WORKFLOW_GH_FAIL==="1"||process.env.WORKFLOW_GH_FAIL_KIND===kind){console.error("comment unavailable"); process.exit(1);} rows.push({id:rows.length+1,body,html_url:"https://github.com/org/repo/issues/1#issuecomment-"+(rows.length+1)}); fs.writeFileSync(file,JSON.stringify(rows)); console.log("ok");});}\nelse process.exit(2);\n`, { mode: 0o755 });
    const ownedPlanReady = join(runtime, "owned-plan-ready");
    const ownedPlanFinished = join(runtime, "owned-plan-finished");
    writeFileSync(join(shim, "herdr"), `#!${process.execPath}\nimport fs from "node:fs";\nimport path from "node:path";\nconst args=process.argv.slice(2);\nif(args[0]==="tab"&&args[1]==="create") console.log(JSON.stringify({result:{tab:{tab_id:"owned-tab"},root_pane:{pane_id:"owned-pane"}}}));\nelse if(args[0]==="agent"&&args[1]==="prompt"){fs.writeFileSync(process.env.WORKFLOW_OWNED_PLAN_READY,"ready"); console.log(JSON.stringify({result:{}}));}\nelse if(args[0]==="agent"&&args[1]==="wait"){const file=process.env.WORKFLOW_OWNED_PLAN_FINISHED; const done=()=>{console.log(JSON.stringify({result:{state:"done"}})); process.exit(0);}; if(fs.existsSync(file)) done(); else {const watcher=fs.watch(path.dirname(file),(_event,name)=>{if(name===path.basename(file)&&fs.existsSync(file)){watcher.close(); done();}});}}\nelse console.log(JSON.stringify({result:{}}));\n`, { mode: 0o755 });
    process.env.WORKFLOW_OWNED_PLAN_READY = ownedPlanReady;
    process.env.WORKFLOW_OWNED_PLAN_FINISHED = ownedPlanFinished;
    process.env.PATH = `${shim}:${process.env.PATH ?? ""}`;
    process.env.WORKFLOW_COMMENTS = commentsFile;
    const db = openDb(join(dir, "yokemate.db"));
    db.prepare("INSERT INTO project (org,repo,path,tracker,tracker_key,model) VALUES ('org','repo',?,'github','YM','test/model')").run(clone);
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, "agent"), settingsManager: SettingsManager.create(dir, join(dir, "agent")), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [join(dir, ".pi", "extensions", "subagent", "index.ts")] });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    loaded.runtime.appendEntry = () => undefined;
    const reports: unknown[] = [];
    let reportReady: (() => void) | undefined;
    const scoutWaiters = new Map<string, () => void>();
    const receiveReport = (message: any) => {
      reports.push(message);
      reportReady?.();
      const envelope = message?.details?.envelope;
      if (envelope?.kind === "result") {
        scoutWaiters.get(envelope.identity?.batchId)?.();
        scoutWaiters.delete(envelope.identity?.batchId);
      }
    };
    loaded.runtime.sendMessage = receiveReport;
    const extension = loaded.extensions[0]!;
    const tool = extension.tools.get("subagent")!.definition;
    let extraction: "none" | "advance-plan-do" | "approve-ready-do" | "error" = "none";
    let calls = 0;
    let confirms = 0;
    const notifications: string[] = [];
    const ctx = { cwd: dir, mode: "rpc", hasUI: true, sessionManager: { getSessionId: () => "parent" }, model: { provider: "ym204-fixture", id: "deterministic" }, modelRegistry: {
      getAll: () => [{ provider: "ym204-fixture", id: "deterministic", name: "Deterministic", reasoning: true }, { provider: "test", id: "model", name: "model" }], hasConfiguredAuth: () => true,
      complete: async (_model: unknown, context: { messages: { content: string }[] }) => {
        calls++;
        if (extraction === "error") throw new Error("workflow extraction timed out");
        const { raw, bindings } = JSON.parse(context.messages[0]!.content);
        const value = extraction === "none" ? { kind: "none" } : { kind: extraction, ticket: "YM-1", binding: extraction === "approve-ready-do" ? bindings[0].contentHash : null, actions: extraction === "approve-ready-do" ? ["do"] : ["plan", "do"], evidence: [{ start: 0, end: raw.length, text: raw }] };
        return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify(value) }] };
      },
    }, ui: { setWidget() {}, notify(message: string) { notifications.push(message); }, confirm: async () => { confirms++; return true; } } } as unknown as ExtensionContext;
    for (const handler of extension.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" } as never, ctx);
    shutdown = async () => { for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" } as never, ctx); };
    const input = async (text: string, source = "interactive", mode = "tui") => {
      let outcome: unknown;
      for (const handler of extension.handlers.get("input") ?? []) outcome = await handler({ type: "input", source, text } as never, { ...ctx, mode } as ExtensionContext);
      return outcome;
    };
    const launch = () => tool.execute("launch", { coordinator: { mode: "do", tickets: ["YM-1"] } }, undefined, () => undefined, ctx);
    const output = (result: Awaited<ReturnType<typeof launch>>) => result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
    const cancel = (runId: string) => tool.execute("cancel", { cancelRun: runId }, undefined, () => undefined, ctx);
    const recordProcess = async (extraEnv: NodeJS.ProcessEnv = {}) => promisify(execFile)(process.execPath, ["--experimental-strip-types", "--no-warnings", join(dir, "src", "plan-ticket.ts"), "YM-1", plan], { cwd: dir, env: { PATH: process.env.PATH, WORKFLOW_COMMENTS: commentsFile, XDG_RUNTIME_DIR: runtime, PI_SESSION_ID: "parent", ...extraEnv } });
    const record = async (extraEnv: NodeJS.ProcessEnv = {}) => (await recordProcess(extraEnv)).stdout;
    const reset = () => db.prepare("UPDATE work SET stage='planned' WHERE ticket='YM-1'").run();
    const triggerReview = async () => {
      if (eventConnections.length === 0) await once(eventServer, "connection");
      const socket = eventConnections.at(-1)!;
      const sent = once(socket, "data");
      socket.write("review");
      await sent;
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    const runScout = async (callId: string, scoutTool = tool, scoutContext: ExtensionContext = ctx) => {
      const before = reports.length;
      const delivered = new Promise<void>((resolve) => { scoutWaiters.set(callId, resolve); });
      const ack = await scoutTool.execute(callId, { agent: "plan-scout", task: "Return the complete fixture investigation.", ticket: "YM-1" }, undefined, () => undefined, scoutContext);
      assert.match(JSON.stringify(ack), /YM-1/);
      let timer: NodeJS.Timeout | undefined;
      try { await Promise.race([delivered, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`scout report timeout: ${JSON.stringify({ ack, reports: reports.slice(-4) })}`)), 30000); })]); }
      finally { clearTimeout(timer); }
      return reports.slice(before).map((item: any) => item?.details?.envelope).find((envelope: any) => envelope?.kind === "result" && envelope.identity?.agent === "plan-scout" && envelope.identity.batchId === callId);
    };
    const workflowChild = process.argv[1];
    process.env.YOKEMATE_RUN_ID = "duplicate-mode-owner";
    process.argv[1] = realpathSync(join(source, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"));
    assert.equal(process.env.PI_SESSION_ID, undefined);
    const scoutEnvelope = await runScout("scout-long");
    assert.equal(scoutEnvelope.artifact.state, "accepted", JSON.stringify(scoutEnvelope.artifact));
    assert.equal(scoutEnvelope.publication.state, "complete", JSON.stringify(scoutEnvelope.publication));
    assert.match(readFileSync(scoutEnvelope.artifact.path, "utf8"), /EVIDENCE-TAIL/);
    assert.ok(Buffer.byteLength(scoutEnvelope.payload) <= 50 * 1024 + 32);
    assert.doesNotMatch(scoutEnvelope.payload, /EVIDENCE-TAIL/);
    const scoutRemote = JSON.parse(readFileSync(commentsFile, "utf8")) as { body: string }[];
    assert.ok(scoutRemote.length >= 3);
    const reconstructedScout = scoutRemote.map((comment) => comment.body.slice(comment.body.indexOf("\n\n---\n\n") + 7)).join("");
    assert.match(reconstructedScout, /EVIDENCE-TAIL/);
    assert.match(reconstructedScout, /## Assumptions/);
    assert.match(reconstructedScout, /## Forks and recommendations/);
    const scoutPartCount = scoutRemote.length;
    process.env.YM204_FIXTURE_SCENARIO = "plan_scout_secret";
    const blockedScout = await runScout("scout-secret");
    assert.equal(blockedScout.artifact.state, "blocked");
    assert.equal(blockedScout.artifact.reason, "unsafe_document");
    assert.equal((JSON.parse(readFileSync(commentsFile, "utf8")) as unknown[]).length, scoutPartCount);
    await assert.rejects(record, (error: any) => /current accepted scout/.test(String(error.stderr)));
    assert.equal(db.prepare("SELECT stage FROM work WHERE ticket='YM-1'").get(), undefined);
    assert.equal((JSON.parse(readFileSync(commentsFile, "utf8")) as unknown[]).length, scoutPartCount);
    process.env.YM204_FIXTURE_SCENARIO = "protocol_overflow";
    const invalidScout = await runScout("scout-protocol-overflow");
    assert.equal(invalidScout.payloadOutcome, "protocol_error");
    assert.equal(invalidScout.artifact.state, "blocked");
    assert.equal(invalidScout.publication, undefined);
    assert.equal((JSON.parse(readFileSync(commentsFile, "utf8")) as unknown[]).length, scoutPartCount);
    process.env.YM204_FIXTURE_SCENARIO = "plan_scout";
    process.env.YOKEMATE_MODE = "plan";
    process.env.YOKEMATE_TICKET = "YM-1";
    process.env.YOKEMATE_PLAN_RUN_ID = "foreign-plan-run";
    const refusedScout = await runScout("scout-parent-refusal");
    assert.equal(refusedScout.artifact.state, "blocked");
    assert.equal(refusedScout.artifact.reason, "unavailable");
    assert.equal(db.prepare("SELECT reason FROM plan_publication_block WHERE ticket='YM-1' AND run_id=?").get(refusedScout.identity.runId)?.reason, "unavailable");
    assert.equal((JSON.parse(readFileSync(commentsFile, "utf8")) as unknown[]).length, scoutPartCount);
    delete process.env.YOKEMATE_MODE;
    delete process.env.YOKEMATE_TICKET;
    delete process.env.YOKEMATE_PLAN_RUN_ID;
    const recoveredScout = await runScout("scout-recovery");
    assert.equal(recoveredScout.publication.state, "complete", JSON.stringify(recoveredScout.publication));
    db.prepare("DELETE FROM project WHERE tracker_key='YM'").run();
    const warningsBeforeUnresolved = notifications.length;
    const unresolvedScout = await runScout("scout-unresolved");
    assert.equal(unresolvedScout.artifact.state, "accepted");
    assert.equal(unresolvedScout.publication.state, "pending");
    assert.equal(unresolvedScout.publication.error, "target_unavailable");
    assert.equal(unresolvedScout.publication.target, "unresolved/YM-1");
    assert.match(notifications.slice(warningsBeforeUnresolved).join("\n"), /warning: scout publication → unresolved\/YM-1: target_unavailable/);
    delete process.env.YOKEMATE_RUN_ID;
    process.argv[1] = workflowChild;
    await input("/plan YM-1");
    const unresolvedRecord = await recordProcess();
    assert.match(unresolvedRecord.stdout, /YM-1 → planned/);
    assert.match(unresolvedRecord.stdout, /plan-only; ready for \/do/);
    assert.match(unresolvedRecord.stderr, /warning: scout publication → unresolved\/YM-1: target_unavailable/);
    assert.match(unresolvedRecord.stderr, /warning: plan publication → unresolved\/YM-1: target_unavailable/);
    assert.equal((JSON.parse(readFileSync(commentsFile, "utf8")) as unknown[]).length, scoutPartCount);
    notifications.length = 0;
    db.prepare("INSERT INTO project (org,repo,path,tracker,tracker_key,model) VALUES ('org','repo',?,'github','YM','test/model')").run(clone);
    await input("/plan YM-1");
    assert.match(await record(), /plan-only; ready for \/do/);
    const firstPublications = JSON.parse(readFileSync(commentsFile, "utf8")) as { body: string }[];
    assert.equal(firstPublications.length, scoutPartCount + 1);
    assert.ok(firstPublications.slice(0, scoutPartCount).every((comment) => /YM-1 · scout · revision/.test(comment.body)));
    const planComment = firstPublications.at(-1)!;
    assert.match(planComment.body, /YM-1 · plan · revision/);
    assert.match(planComment.body, /record: planned \(successful local record\)/);
    assert.ok(planComment.body.endsWith(text));
    const recorded = db.prepare("SELECT id,publication_id FROM plan_record WHERE ticket='YM-1' AND successful_record=1 ORDER BY id DESC LIMIT 1").get() as { id: number; publication_id: number };
    const planPublication = db.prepare("SELECT artifact_path FROM plan_publication WHERE id=?").get(recorded.publication_id) as { artifact_path: string };
    const planArtifact = readFileSync(planPublication.artifact_path);
    writeFileSync(planPublication.artifact_path, "tampered");
    const parentTarget = resolveCoordinatorParent(dir, { ...process.env, XDG_RUNTIME_DIR: runtime });
    const artifactReply = await requestPlanControl(dir, "plan-recorded", { ticket: "YM-1", path: plan, recordId: recorded.id }, currentControlOrigin(dir, "parent"), parentTarget, { ...process.env, XDG_RUNTIME_DIR: runtime });
    assert.equal(artifactReply.state, "refused");
    assert.equal(artifactReply.reason, "artifact_invalid");
    writeFileSync(planPublication.artifact_path, planArtifact);
    db.prepare("UPDATE plan_record SET publication_id=NULL WHERE id=?").run(recorded.id);
    db.prepare("DELETE FROM plan_publication WHERE id=?").run(recorded.publication_id);
    const commentsBeforeTargetChange = (JSON.parse(readFileSync(commentsFile, "utf8")) as unknown[]).length;
    execFileSync("git", ["-C", clone, "remote", "set-url", "origin", "https://github.com/other/repo.git"]);
    const targetReply = await requestPlanControl(dir, "plan-recorded", { ticket: "YM-1", path: plan, recordId: recorded.id }, currentControlOrigin(dir, "parent"), parentTarget, { ...process.env, XDG_RUNTIME_DIR: runtime });
    assert.equal(targetReply.state, "accepted");
    assert.deepEqual(targetReply.publications?.map((outcome) => [outcome.kind, outcome.state, outcome.error, outcome.publicationId]), [["scout", "pending", "target_changed", recoveredScout.publication.publicationId], ["plan", "pending", "target_changed", undefined]]);
    assert.equal((JSON.parse(readFileSync(commentsFile, "utf8")) as unknown[]).length, commentsBeforeTargetChange);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM plan_publication WHERE kind='plan' AND target='github:other/repo#1'").get()?.count, 0);
    execFileSync("git", ["-C", clone, "remote", "set-url", "origin", "https://github.com/org/repo.git"]);
    assert.equal(existsSync(join(dir, "work", "YM-1", "fixture-runs")), false);
    assert.equal(calls, 0);
    extraction = "error";
    assert.equal(await input("Исправь обычный баг"), undefined);
    assert.match(notifications.pop() ?? "", /workflow extraction unavailable: workflow extraction timed out; continuing without inferred workflow approval/);
    extraction = "none";
    assert.match(output(await launch()), /current interactive approval/);
    await input("/do YM-1", "extension");
    await input("/do YM-1", "interactive", "rpc");
    assert.match(output(await launch()), /current interactive approval/);
    extraction = "advance-plan-do";
    db.prepare("UPDATE project SET model='missing/model' WHERE tracker_key='YM'").run();
    await input("Спланируй YM-1 и затем выполни");
    await assert.rejects(record, (error: any) => /handoff refused.*missing\/model/s.test(String(error.stderr)));
    assert.equal((JSON.parse(readFileSync(commentsFile, "utf8")) as unknown[]).length, scoutPartCount + 1);
    db.prepare("UPDATE project SET model='test/model' WHERE tracker_key='YM'").run();
    await input("Спланируй YM-1 и затем выполни");
    const auto = await record();
    assert.match(auto, /background run [a-f0-9-]+/);
    assert.equal((JSON.parse(readFileSync(commentsFile, "utf8")) as unknown[]).length, scoutPartCount + 1);
    const autoId = auto.match(/background run ([a-f0-9-]+)/)![1]!;
    await waitForFile(join(dir, "work", "YM-1", "fixture-runs"));
    assert.equal(readFileSync(join(dir, "work", "YM-1", "fixture-runs"), "utf8").trim(), autoId);
    assert.match(output(await launch()), /already consumed/);
    await cancel(autoId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const socket of eventConnections.splice(0)) socket.destroy();
    reset();
    set(true);
    await input("Plan and then do YM-1");
    assert.match(await record(), /plan-only; ready for \/do/);
    assert.match(output(await launch()), /current interactive approval/);
    await input("/do YM-1");
    writeFileSync(plan, text + "\nchanged");
    assert.match(output(await launch()), /approval.*changed/);
    writeFileSync(plan, text);
    await input("/do YM-1");
    writeFileSync(plan, text.replace("1. Work", "1. Changed scope"));
    assert.match(output(await launch()), /approval scope changed/);
    writeFileSync(plan, text);
    await input("/do YM-1");
    writeFileSync(plan, text.replace("org/repo", "org/other"));
    assert.match(output(await launch()), /approval repositories changed/);
    writeFileSync(plan, text);
    await input("/do YM-1");
    await input("/plan YM-1");
    assert.match(output(await launch()), /current interactive approval/);
    await input("/do YM-1 запусти на gpt-6-astra, задача сложная");
    const explicit = await launch();
    const explicitId = (explicit.details as { runId: string }).runId;
    assert.ok(explicitId, output(explicit));
    if (eventConnections.length === 0) await once(eventServer, "connection");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const reportsBeforeReview = reports.length;
    await triggerReview();
    assert.equal(reports.length, reportsBeforeReview);
    const explicitSocket = eventConnections.at(-1);
    await cancel(explicitId);
    explicitSocket?.destroy();
    const explicitIndex = explicitSocket ? eventConnections.indexOf(explicitSocket) : -1;
    if (explicitIndex >= 0) eventConnections.splice(explicitIndex, 1);
    reset();
    extraction = "approve-ready-do";
    await input("План согласован, запускай YM-1");
    const approved = await launch();
    const approvedId = (approved.details as { runId: string }).runId;
    assert.ok(approvedId, output(approved));
    if (eventConnections.length === 0) await once(eventServer, "connection");
    writeFileSync(plan, text + "\ncycle changed");
    const bindingBlocked = new Promise<void>((resolve) => { reportReady = resolve; });
    await triggerReview();
    await bindingBlocked;
    reportReady = undefined;
    assert.match(JSON.stringify(reports.at(-1)), /approval (?:scope|content hash) changed/);
    await cancel(approvedId);
    assert.equal(confirms, 0);
    assert.deepEqual(notifications, []);
    assert.equal(readRecordedPlanBinding(dir, "YM-1").path, plan);
    type ExpectedPublication = "complete" | "unavailable" | "remote_conflict" | "target_unavailable" | "target_changed";
    const configurePublication = (label: string, scout: ExpectedPublication, planOutcome: ExpectedPublication) => {
      for (const key of ["WORKFLOW_GH_FAIL", "WORKFLOW_GH_FAIL_KIND", "WORKFLOW_GH_CONFLICT_KIND"]) delete process.env[key];
      process.env.WORKFLOW_SCOUT_REVISION = `-${label}`;
      if (scout === "unavailable" && planOutcome === "unavailable") process.env.WORKFLOW_GH_FAIL = "1";
      else if (scout === "unavailable") process.env.WORKFLOW_GH_FAIL_KIND = "scout";
      else if (planOutcome === "unavailable") process.env.WORKFLOW_GH_FAIL_KIND = "plan";
      else if (scout === "remote_conflict") process.env.WORKFLOW_GH_CONFLICT_KIND = "scout";
      else if (planOutcome === "remote_conflict") process.env.WORKFLOW_GH_CONFLICT_KIND = "plan";
      writeFileSync(plan, text.replace("Exercise authority.", `Exercise authority for ${label}.`));
      reset();
    };
    const clearPublication = () => {
      for (const key of ["WORKFLOW_GH_FAIL", "WORKFLOW_GH_FAIL_KIND", "WORKFLOW_GH_CONFLICT_KIND", "WORKFLOW_SCOUT_REVISION"]) delete process.env[key];
    };
    const assertPublicationResult = (label: string, result: { stdout: string; stderr: string }, scout: ExpectedPublication, planOutcome: ExpectedPublication, handoff: "plan-only" | "started" = "plan-only") => {
      assert.match(result.stdout, /YM-1 → planned/, label);
      if (handoff === "started") assert.match(result.stdout, /background run [a-f0-9-]+/, label);
      else assert.match(result.stdout, /plan-only; ready for \/do/, label);
      for (const [kind, expected] of [["scout", scout], ["plan", planOutcome]] as const) {
        if (expected === "complete") {
          assert.match(result.stdout, new RegExp(`YM-1: ${kind} published to`), label);
          assert.doesNotMatch(result.stderr, new RegExp(`warning: ${kind} publication`), label);
        } else {
          assert.match(result.stderr, new RegExp(`warning: ${kind} publication .* ${expected}`), label);
          assert.doesNotMatch(result.stdout, new RegExp(`YM-1: ${kind} published to`), label);
        }
      }
      assert.doesNotMatch(result.stderr, /comment unavailable|comment conflict/, label);
    };
    const runLegacyPublicationCase = async (label: string, scoutExpected: ExpectedPublication, planExpected: ExpectedPublication, authority: "none" | "plain" | "advance" | "guarded" = "none") => {
      configurePublication(`legacy-${label}`, scoutExpected, planExpected);
      if (authority === "plain") {
        set(false);
        extraction = "none";
        await input("/plan YM-1");
      } else if (authority === "advance" || authority === "guarded") {
        set(authority === "guarded");
        extraction = "advance-plan-do";
        await input("Plan and then do YM-1");
      }
      process.env.YOKEMATE_RUN_ID = "duplicate-mode-owner";
      process.argv[1] = realpathSync(join(source, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"));
      const before = (JSON.parse(readFileSync(commentsFile, "utf8")) as unknown[]).length;
      const scoutResult = await runScout(`legacy-${label}-scout`);
      assert.equal(scoutResult.artifact.state, "accepted", label);
      assert.equal(scoutResult.publication.state, scoutExpected === "complete" ? "complete" : "pending", label);
      if (scoutExpected !== "complete") assert.equal(scoutResult.publication.error, scoutExpected, label);
      delete process.env.YOKEMATE_RUN_ID;
      process.argv[1] = workflowChild;
      const result = await recordProcess();
      assertPublicationResult(`legacy-${label}`, result, scoutExpected, planExpected, authority === "advance" ? "started" : "plan-only");
      if (authority === "advance") {
        const runId = result.stdout.match(/background run ([a-f0-9-]+)/)![1]!;
        await waitForFile(join(dir, "work", "YM-1", "fixture-runs"));
        await cancel(runId);
        for (const socket of eventConnections.splice(0)) socket.destroy();
      } else if (authority === "plain" || authority === "guarded") {
        const refused = await launch();
        assert.match(output(refused), /approval|consumed|workflowApproval/, label);
        assert.equal((refused.details as { runId?: string }).runId, undefined, label);
      }
      if (authority === "guarded") {
        await input("/do YM-1");
        writeFileSync(plan, readFileSync(plan, "utf8") + "\nstale");
        assert.match(output(await launch()), /approval.*changed/, label);
        writeFileSync(plan, text.replace("Exercise authority.", `Exercise authority for legacy-${label}.`));
        await input("/do YM-2");
        assert.match(output(await launch()), /approval/, label);
        await input("/do YM-1");
        await input("/plan YM-1");
        assert.match(output(await launch()), /approval|consumed/, label);
      }
      set(false);
      extraction = "none";
      const after = (JSON.parse(readFileSync(commentsFile, "utf8")) as unknown[]).length;
      if (scoutExpected === "unavailable" && planExpected === "unavailable") assert.equal(after, before, label);
      else assert.ok(after > before, label);
      clearPublication();
    };
    await runLegacyPublicationCase("scout-pending", "unavailable", "complete", "plain");
    await runLegacyPublicationCase("plan-pending", "complete", "unavailable", "advance");
    await runLegacyPublicationCase("both-pending", "unavailable", "unavailable", "guarded");
    await runLegacyPublicationCase("conflict", "complete", "remote_conflict");
    const launchTarget = resolveCoordinatorParent(dir, { ...process.env, XDG_RUNTIME_DIR: runtime });
    const ownedLoaderExtensions = async () => {
      const ownedLoader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, "agent"), settingsManager: SettingsManager.create(dir, join(dir, "agent")), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [join(dir, ".pi", "extensions", "subagent", "index.ts")] });
      await ownedLoader.reload();
      const ownedLoaded = ownedLoader.getExtensions();
      assert.deepEqual(ownedLoaded.errors, []);
      ownedLoaded.runtime.appendEntry = () => undefined;
      ownedLoaded.runtime.sendMessage = receiveReport;
      const extension = ownedLoaded.extensions[0]!;
      return { extension, tool: extension.tools.get("subagent")!.definition, context: { ...ctx, sessionManager: { getSessionId: () => "parent" } } as unknown as ExtensionContext };
    };
    const runOwnedPublicationCase = async (label: string, scoutExpected: ExpectedPublication, planExpected: ExpectedPublication, authority: "none" | "plain" | "advance" | "guarded" = "none") => {
      configurePublication(`owned-${label}`, scoutExpected, planExpected);
      if (authority === "plain") {
        set(false);
        extraction = "none";
        await input("/plan YM-1");
      } else if (authority === "advance" || authority === "guarded") {
        set(authority === "guarded");
        extraction = "advance-plan-do";
        await input("Plan and then do YM-1");
      }
      rmSync(ownedPlanReady, { force: true });
      rmSync(ownedPlanFinished, { force: true });
      const ownedLaunch = await requestPlanLaunch(dir, { targets: [{ ticket: "YM-1", workerWords: ["YM-1"] }], surface: "tab", literal: [], parentPane: "", parentWorkspace: "workspace" }, { sessionId: "parent", pid: process.pid, starttime: processStarttime(process.pid)!, cwd: dir }, launchTarget, { ...process.env, XDG_RUNTIME_DIR: runtime });
      assert.equal(ownedLaunch.state, "accepted", label);
      const ownedRunId = ownedLaunch.results?.[0]?.keyRunId;
      assert.ok(ownedRunId, label);
      await waitForFile(ownedPlanReady);
      writeFileSync(join(socketDir({ ...process.env, XDG_RUNTIME_DIR: runtime }, process.getuid!()), "owned-pane.json"), JSON.stringify({ pid: process.pid, cwd: dir, mode: "plan", ticket: "YM-1" }));
      Object.assign(process.env, { PI_SESSION_FILE: join(dir, `owned-${label}.jsonl`), YOKEMATE_MODE: "plan", YOKEMATE_TICKET: "YM-1", YOKEMATE_ROLE: "coordinator", YOKEMATE_PLAN_RUN_ID: ownedRunId, YOKEMATE_RUN_ID: ownedRunId, HERDR_PANE_ID: "owned-pane", YOKEMATE_PARENT_PANE: "" });
      const ownedWorker = { sessionId: "parent", pid: process.pid, starttime: processStarttime(process.pid)!, cwd: dir, mode: "plan", ticket: "YM-1", role: "coordinator", pane: "owned-pane" };
      const ownedStarted = await requestPlanControl(dir, "plan-started", { ticket: "YM-1", runId: ownedRunId }, ownedWorker, launchTarget, { ...process.env, XDG_RUNTIME_DIR: runtime });
      assert.equal(ownedStarted.state, "accepted", ownedStarted.reason ?? label);
      if (scoutExpected === "target_unavailable") db.prepare("DELETE FROM project WHERE tracker_key='YM'").run();
      const initialScoutExpected: ExpectedPublication = scoutExpected === "target_changed" ? "complete" : scoutExpected;
      let ownedExtension: Awaited<ReturnType<typeof ownedLoaderExtensions>>["extension"] | undefined;
      let ownedCtx: ExtensionContext | undefined;
      if (label === "scout-pending") {
        process.argv[1] = realpathSync(join(source, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"));
        const loadedOwned = await ownedLoaderExtensions();
        ownedExtension = loadedOwned.extension;
        ownedCtx = loadedOwned.context;
        for (const handler of ownedExtension.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" } as never, ownedCtx);
        const warningsBeforeOwnedScout = notifications.length;
        const ownedScout = await runScout(`owned-${label}-scout`, loadedOwned.tool, ownedCtx);
        assert.equal(ownedScout.artifact.state, "accepted", label);
        assert.equal(ownedScout.publication.state, initialScoutExpected === "complete" ? "complete" : "pending", label);
        if (initialScoutExpected !== "complete") assert.match(notifications.slice(warningsBeforeOwnedScout).join("\n"), new RegExp(`warning: scout publication .* ${initialScoutExpected}`), label);
      } else {
        const identity = { ownerRunId: ownedRunId, ownerSessionId: "parent", batchId: `owned-${label}-batch`, runId: `owned-${label}-run`, agent: "plan-scout", taskHash: "a".repeat(64), cwd: dir, ticket: "YM-1" } as const;
        const acceptance = acceptScoutArtifact(db, dir, identity, Buffer.from(`# Scout\n\n## Facts and sources\n${"owned evidence\n".repeat(5000)}${label}\n\n## Assumptions\n- Fixture.\n\n## Forks and recommendations\n- Fixture.\n`));
        const accepted = await requestPlanControl(dir, "publish-plan-scout", { ticket: "YM-1", runId: ownedRunId, acceptanceId: acceptance.id, child: identity }, ownedWorker, launchTarget, { ...process.env, XDG_RUNTIME_DIR: runtime });
        assert.equal(accepted.state, "accepted", accepted.reason ?? label);
        assert.equal(accepted.artifactAcceptance, "accepted", label);
        assert.equal(accepted.publication, initialScoutExpected === "complete" ? "complete" : "pending", label);
        if (initialScoutExpected !== "complete") assert.equal(accepted.reason, initialScoutExpected, label);
      }
      const commentsBeforeOwnedRecord = (JSON.parse(readFileSync(commentsFile, "utf8")) as unknown[]).length;
      if (scoutExpected === "target_changed") execFileSync("git", ["-C", clone, "remote", "set-url", "origin", "https://github.com/other/repo.git"]);
      process.argv[1] = workflowChild;
      let result: Awaited<ReturnType<typeof recordProcess>>;
      try { result = await recordProcess({ PI_SESSION_ID: "parent", YOKEMATE_MODE: "plan", YOKEMATE_TICKET: "YM-1", YOKEMATE_ROLE: "coordinator", YOKEMATE_PLAN_RUN_ID: ownedRunId, YOKEMATE_RUN_ID: ownedRunId, HERDR_PANE_ID: "owned-pane", YOKEMATE_PARENT_PANE: "" }); }
      finally { writeFileSync(ownedPlanFinished, "done"); }
      assertPublicationResult(`owned-${label}`, result, scoutExpected, planExpected, authority === "advance" ? "started" : "plan-only");
      if (scoutExpected === "target_changed" || scoutExpected === "target_unavailable") assert.equal((JSON.parse(readFileSync(commentsFile, "utf8")) as unknown[]).length, commentsBeforeOwnedRecord, label);
      if (ownedExtension && ownedCtx) for (const handler of ownedExtension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" } as never, ownedCtx);
      for (const key of ["PI_SESSION_FILE", "YOKEMATE_MODE", "YOKEMATE_TICKET", "YOKEMATE_ROLE", "YOKEMATE_PLAN_RUN_ID", "YOKEMATE_RUN_ID", "HERDR_PANE_ID", "YOKEMATE_PARENT_PANE"]) delete process.env[key];
      if (scoutExpected === "target_changed") execFileSync("git", ["-C", clone, "remote", "set-url", "origin", "https://github.com/org/repo.git"]);
      if (scoutExpected === "target_unavailable") db.prepare("INSERT INTO project (org,repo,path,tracker,tracker_key,model) VALUES ('org','repo',?,'github','YM','test/model')").run(clone);
      if (authority === "advance") {
        const runId = result.stdout.match(/background run ([a-f0-9-]+)/)![1]!;
        await waitForFile(join(dir, "work", "YM-1", "fixture-runs"));
        await cancel(runId);
        for (const socket of eventConnections.splice(0)) socket.destroy();
      } else if (authority === "plain" || authority === "guarded") {
        const refused = await launch();
        assert.match(output(refused), /approval|consumed|workflowApproval/, label);
        assert.equal((refused.details as { runId?: string }).runId, undefined, label);
      }
      set(false);
      extraction = "none";
      clearPublication();
    };
    await runOwnedPublicationCase("scout-pending", "unavailable", "complete", "advance");
    await runOwnedPublicationCase("plan-pending", "complete", "unavailable", "guarded");
    await runOwnedPublicationCase("both-pending", "unavailable", "unavailable", "plain");
    await runOwnedPublicationCase("conflict", "complete", "remote_conflict");
    await runOwnedPublicationCase("target-unavailable", "target_unavailable", "target_unavailable");
    await runOwnedPublicationCase("target-changed", "target_changed", "target_changed");
    writeFileSync(plan, text.replace("Exercise authority.", "Exercise save-only admission."));
    reset();
    set(false);
    extraction = "advance-plan-do";
    await input("Plan and then do YM-1");
    const noIdPane = "save-only-pane";
    writeFileSync(join(socketDir({ ...process.env, XDG_RUNTIME_DIR: runtime }, process.getuid!()), `${noIdPane}.json`), JSON.stringify({ pid: process.pid, cwd: dir, mode: "plan", ticket: "YM-1" }));
    Object.assign(process.env, { PI_SESSION_FILE: join(dir, "save-only.jsonl"), YOKEMATE_MODE: "plan", YOKEMATE_TICKET: "YM-1", YOKEMATE_ROLE: "coordinator", HERDR_PANE_ID: noIdPane, YOKEMATE_PARENT_PANE: "" });
    delete process.env.YOKEMATE_PLAN_RUN_ID;
    delete process.env.YOKEMATE_RUN_ID;
    process.argv[1] = realpathSync(join(source, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"));
    const noIdLoaded = await ownedLoaderExtensions();
    for (const handler of noIdLoaded.extension.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" } as never, noIdLoaded.context);
    for (const handler of noIdLoaded.extension.handlers.get("turn_start") ?? []) await handler({ type: "turn_start" } as never, noIdLoaded.context);
    const noIdScout = await runScout("save-only-scout", noIdLoaded.tool, noIdLoaded.context);
    assert.equal(noIdScout.artifact.state, "accepted", JSON.stringify(noIdScout.artifact));
    process.argv[1] = workflowChild;
    const noIdRecord = await recordProcess({ PI_SESSION_ID: "parent", YOKEMATE_MODE: "plan", YOKEMATE_TICKET: "YM-1", YOKEMATE_ROLE: "coordinator", HERDR_PANE_ID: noIdPane, YOKEMATE_PARENT_PANE: "" });
    assert.match(noIdRecord.stdout, /YM-1 → planned/);
    assert.match(noIdRecord.stdout, /plan-only; ready for \/do; automatic handoff unavailable/);
    assert.doesNotMatch(noIdRecord.stdout, /background run/);
    for (const key of ["PI_SESSION_FILE", "YOKEMATE_MODE", "YOKEMATE_TICKET", "YOKEMATE_ROLE", "HERDR_PANE_ID", "YOKEMATE_PARENT_PANE"]) delete process.env[key];
    assert.match(output(await launch()), /waiting for the actual plan record/);
    extraction = "approve-ready-do";
    await input("Запускай YM-1");
    const freshDo = await launch();
    const freshDoId = (freshDo.details as { runId?: string }).runId;
    assert.ok(freshDoId, output(freshDo));
    await cancel(freshDoId!);
    for (const handler of noIdLoaded.extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" } as never, noIdLoaded.context);
    for (const key of ["PI_SESSION_FILE", "YOKEMATE_MODE", "YOKEMATE_TICKET", "YOKEMATE_ROLE", "HERDR_PANE_ID", "YOKEMATE_PARENT_PANE"]) delete process.env[key];
    writeFileSync(plan, text);
    reset();
    for (const surface of ["typed", "tool", "cli", "pane", "ordinary", "coordinator"]) for (const variant of ["on", "off", "neighbor"]) console.log(`RUNTIME_CASE ${surface}:guardPolicy.workflowApproval:${variant}`);
    db.close();
  } finally {
    await shutdown?.();
    for (const socket of eventConnections) socket.destroy();
    for (const socket of providerSockets) socket.destroy();
    await Promise.all([
      new Promise<void>((resolve) => eventServer.close(() => resolve())),
      new Promise<void>((resolve) => providerServer.close(() => resolve())),
    ]);
    process.argv[1] = script;
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    rmSync(dir, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});
