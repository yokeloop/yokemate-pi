import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DefaultResourceLoader, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const root = join(import.meta.dirname, "..");
const coordinatorOriginKeys = ["YOKEMATE_MODE", "YOKEMATE_ROLE", "YOKEMATE_TICKET", "YOKEMATE_PARENT_PANE", "HERDR_PANE_ID"] as const;
const reviewPaneStamp = {
  YOKEMATE_MODE: "review",
  YOKEMATE_ROLE: "coordinator",
  YOKEMATE_TICKET: "YM-999",
  YOKEMATE_PARENT_PANE: "fixture-main-pane",
  HERDR_PANE_ID: "fixture-review-pane",
};
const clearCoordinatorOrigin = () => {
  for (const key of coordinatorOriginKeys) delete process.env[key];
};
const runtimeCases = (keys: readonly string[], surfaces: readonly string[]) => {
  for (const key of keys) for (const surface of surfaces) for (const variant of ["on", "off", "neighbor"]) console.log(`RUNTIME_CASE ${surface}:${key}:${variant}`);
};

test("public guard hook rereads one strict snapshot before any tool and preserves system context", async () => {
  const dir = mkdtempSync(join(import.meta.dirname, "fixtures", "runtime-settings-"));
  const env = { ...process.env };
  try {
    cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, ".pi"));
    const file = join(dir, ".pi", "settings.json");
    const set = (settings: unknown) => writeFileSync(file, JSON.stringify(settings));
    set({});
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, "agent"), settingsManager: SettingsManager.create(dir, join(dir, "agent")), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [join(dir, "src", "guards.ts")] });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    const hook = loaded.extensions[0]!.handlers.get("tool_call")![0]!;
    const before = loaded.extensions[0]!.handlers.get("before_agent_start")![0]!;
    const ctx = { cwd: dir, hasUI: true, ui: { confirm: async () => { throw new Error("unexpected confirmation"); } } } as unknown as ExtensionContext;
    process.env.YOKEMATE_MODE = "do";
    process.env.YOKEMATE_TICKET = "YM-1";
    const call = (toolName: string, input: Record<string, unknown>, context = ctx) => hook({ type: "tool_call", toolCallId: "fixture", toolName, input } as never, context);
    assert.deepEqual(await call("bash", { command: "sleep 1" }), { block: true, reason: "Waiting is forbidden: a finished subagent returns its result as the tool result, and completion comes to the session on its own. Check the condition once, without sleep, and keep working." });
    const task = join(dir, "work", "YM-1");
    mkdirSync(join(task, ".pi"), { recursive: true });
    writeFileSync(join(task, ".pi", "settings.json"), JSON.stringify({ guardPolicy: { guards: { wait: false } } }));
    assert.equal((await call("bash", { command: "sleep 1" }, { ...ctx, cwd: task } as ExtensionContext) as { block: boolean }).block, true);
    set({ guardPolicy: { guards: { wait: false } } });
    assert.equal(await call("bash", { command: "sleep 1" }), undefined);
    assert.equal((await call("bash", { command: "pnpm dev" }) as { block: boolean }).block, true);
    set({ guardPolicy: { yolo: true } });
    process.env.YOKEMATE_MODE = "ship";
    const merge = await call("bash", { command: `gh pr merge https://example.invalid/pull/1 --match-head-commit ${"a".repeat(40)}` }) as { block: boolean; reason: string };
    assert.equal(merge.block, true);
    assert.match(merge.reason, /parent coordinator/);
    for (const command of [
      `command gh pr merge https://example.invalid/pull/1 --match-head-commit ${"a".repeat(40)}`,
      `sh -c 'gh pr merge https://example.invalid/pull/1 --match-head-commit ${"a".repeat(40)}'`,
      `gh pr merge https://example.invalid/pull/1 --match-head-commit ${"a".repeat(40)}; gh pr merge https://example.invalid/pull/2`,
    ]) {
      const wrapped = await call("bash", { command }) as { block: boolean; reason: string };
      assert.equal(wrapped.block, true);
      assert.match(wrapped.reason, /ship merge/);
    }
    assert.equal(await call("bash", { command: "sleep 1" }), undefined);
    process.env.YOKEMATE_MODE = "do";
    const context = await before({ type: "before_agent_start", prompt: "task", systemPrompt: "original system" } as never, ctx) as { systemPrompt: string };
    assert.ok(context.systemPrompt.startsWith("original system"));
    assert.ok(context.systemPrompt.includes(file));
    assert.match(context.systemPrompt, /maxDetached=8/);
    set({ subagent: { maxDetached: "8" } });
    for (const [name, input] of [["bash", { command: "true" }], ["write", { path: "safe.txt" }], ["read", { path: "safe.txt" }]] as const) {
      const verdict = await call(name, input) as { block: boolean; reason: string };
      assert.equal(verdict.block, true);
      assert.ok(verdict.reason.includes(file));
      assert.match(verdict.reason, /subagent.maxDetached/);
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("typed runtime context renders every applicable setting on off and neighbor", async () => {
  const { GUARD_IDS, RUNTIME_SETTING_KEYS, RUNTIME_SETTINGS_MATRIX } = await import("../src/guard-policy.ts");
  const dir = mkdtempSync(join(import.meta.dirname, "fixtures", "runtime-typed-"));
  try {
    cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, ".pi"));
    const file = join(dir, ".pi", "settings.json");
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, "agent"), settingsManager: SettingsManager.create(dir, join(dir, "agent")), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [join(dir, "src", "guards.ts")] });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const before = loader.getExtensions().extensions[0]!.handlers.get("before_agent_start")![0]!;
    const ctx = { cwd: dir, hasUI: false } as ExtensionContext;
    const context = async (settings: unknown) => {
      writeFileSync(file, JSON.stringify(settings));
      return (await before({ type: "before_agent_start", prompt: "task", systemPrompt: "original" } as never, ctx) as { systemPrompt: string }).systemPrompt;
    };
    for (const key of RUNTIME_SETTING_KEYS.filter((key) => RUNTIME_SETTINGS_MATRIX[key].typed !== "not-applicable")) {
      if (key.startsWith("guards.")) {
        const guard = key.slice("guards.".length) as typeof GUARD_IDS[number];
        const neighbor = GUARD_IDS.find((id) => id !== guard)!;
        const off = await context({ guardPolicy: { guards: { [guard]: false } } });
        assert.match(off, new RegExp(`disabled=[^.]*\\b${guard}\\b`), `${key}/off`);
        assert.match(off, new RegExp(`enabled=[^.]*\\b${neighbor}\\b`), `${key}/neighbor`);
        const on = await context({ guardPolicy: { yolo: true, workflowApproval: true, guards: { [guard]: true } } });
        assert.match(on, new RegExp(`enabled=[^.]*\\b${guard}\\b`), `${key}/on`);
        assert.match(on, new RegExp(`disabled=[^.]*\\b${neighbor}\\b`), `${key}/inverse-neighbor`);
      } else if (key === "guardPolicy.yolo") {
        assert.match(await context({ guardPolicy: { yolo: true } }), /yolo=true/);
        assert.match(await context({ guardPolicy: { yolo: false, guards: { wait: false } } }), /yolo=false.*disabled=[^.]*\bwait\b/);
      } else if (key === "guardPolicy.workflowApproval") {
        assert.match(await context({ guardPolicy: { workflowApproval: false } }), /workflowApproval=false.*enabled=[^.]*\bwait\b/);
        assert.match(await context({ guardPolicy: { yolo: true, workflowApproval: true } }), /workflowApproval=true/);
      } else {
        const limit = key.slice("subagent.".length);
        const value = limit === "maxParallelTasks" ? 2 : limit === "maxConcurrency" ? 2 : 9;
        const settings = limit === "maxConcurrency" ? { subagent: { maxParallelTasks: 3, maxConcurrency: value } } : { subagent: { [limit]: value } };
        assert.match(await context(settings), new RegExp(`${limit}=${value}`), `${key}/value`);
        assert.match(await context({}), /maxParallelTasks=8.*maxConcurrency=4.*maxDetached=8/, `${key}/neighbor`);
      }
      runtimeCases([key], ["typed"]);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("public file and Bash guards disable only their named refusal", async () => {
  const dir = mkdtempSync(join(import.meta.dirname, "fixtures", "runtime-guards-"));
  const env = { ...process.env };
  try {
    cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, ".pi"));
    const file = join(dir, ".pi", "settings.json");
    writeFileSync(file, "{}");
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, "agent"), settingsManager: SettingsManager.create(dir, join(dir, "agent")), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [join(dir, "src", "guards.ts")] });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const hook = loader.getExtensions().extensions[0]!.handlers.get("tool_call")![0]!;
    const ctx = { cwd: dir, hasUI: false } as ExtensionContext;
    const rows = [
      ["settingsWrite", "do", "write", { path: file }],
      ["settingsWrite", "do", "edit", { path: file }],
      ["settingsWrite", "do", "notebook_edit", { notebook_path: file }],
      ["noteFileWrite", "note", "write", { path: "source.ts" }],
      ["noteFileWrite", "note", "edit", { path: "source.ts" }],
      ["noteFileWrite", "note", "notebook_edit", { notebook_path: "source.ipynb" }],
      ["wait", "do", "bash", { command: "sleep 1" }],
      ["noteShellWrite", "note", "bash", { command: "touch source.ts" }],
      ["codingLaunch", "do", "bash", { command: "pnpm dev" }],
      ["massKill", "do", "bash", { command: "pkill fixture-never-executed" }],
      ["homeDelete", "do", "bash", { command: "rm -rf ~/fixture-never-executed" }],
    ] as const;
    process.env.YOKEMATE_MODE = "do";
    const yoloCall = (command: string) => hook({ type: "tool_call", toolCallId: "yolo", toolName: "bash", input: { command } } as never, ctx);
    for (const role of [undefined, "executor", "coordinator"] as const) {
      if (role) process.env.YOKEMATE_ROLE = role; else delete process.env.YOKEMATE_ROLE;
      writeFileSync(file, JSON.stringify({ guardPolicy: { yolo: true } }));
      assert.equal(await yoloCall("sleep 1"), undefined);
      assert.equal(await yoloCall("pnpm dev"), undefined);
      writeFileSync(file, JSON.stringify({ guardPolicy: { yolo: true, guards: { wait: true } } }));
      assert.equal((await yoloCall("sleep 1") as { block: boolean }).block, true);
      assert.equal(await yoloCall("pnpm dev"), undefined);
    }
    delete process.env.YOKEMATE_ROLE;
    const { spawnSync } = await import("node:child_process");
    writeFileSync(file, JSON.stringify({ guardPolicy: { yolo: true } }));
    const yoloCli = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(dir, "src", "bash-guard.ts")], { cwd: dir, env: { PATH: process.env.PATH, YOKEMATE_MODE: "do", YOKEMATE_TICKET: "YM-1" }, input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "sleep 1" } }), encoding: "utf8" });
    assert.equal(yoloCli.stdout.trim(), "");
    writeFileSync(file, JSON.stringify({ guardPolicy: { yolo: true, guards: { wait: true } } }));
    const selectedCli = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(dir, "src", "bash-guard.ts")], { cwd: dir, env: { PATH: process.env.PATH, YOKEMATE_MODE: "do", YOKEMATE_TICKET: "YM-1" }, input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "sleep 1" } }), encoding: "utf8" });
    assert.match(selectedCli.stdout, /permissionDecision":"deny/);
    runtimeCases(["guardPolicy.yolo"], ["tool", "cli", "pane", "ordinary", "coordinator"]);
    for (const [key, mode, toolName, input] of rows) {
      process.env.YOKEMATE_MODE = mode;
      const call = (name = toolName as string, args: Record<string, unknown> = input) => hook({ type: "tool_call", toolCallId: key, toolName: name, input: args } as never, ctx);
      for (const role of [undefined, "executor", ...(["noteFileWrite", "noteShellWrite"].includes(key) ? [] : ["coordinator"])] as const) {
        if (role) process.env.YOKEMATE_ROLE = role; else delete process.env.YOKEMATE_ROLE;
        writeFileSync(file, "{}");
        assert.equal((await call() as { block: boolean }).block, true, `${key}/${role ?? "pane"}`);
        writeFileSync(file, JSON.stringify({ guardPolicy: { guards: { [key]: false } } }));
        assert.equal(await call(), undefined, `${key}/${role ?? "pane"}`);
        const neighbor = key === "wait" ? { command: "pnpm dev" } : { command: "sleep 1" };
        assert.equal((await call("bash", neighbor) as { block: boolean }).block, true, `${key}/${role ?? "pane"}/neighbor`);
        writeFileSync(file, JSON.stringify({ guardPolicy: { yolo: true, guards: { [key]: true }, workflowApproval: true } }));
        assert.equal((await call() as { block: boolean }).block, true, `${key}/${role ?? "pane"}/explicit-on`);
      }
      delete process.env.YOKEMATE_ROLE;
      const cliEvent = toolName === "bash"
        ? { tool_name: "Bash", tool_input: input }
        : { tool_name: toolName === "write" ? "Write" : toolName === "edit" ? "Edit" : "NotebookEdit", tool_input: { file_path: "path" in input ? input.path : input.notebook_path } };
      const cli = () => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(dir, "src", "bash-guard.ts")], { cwd: dir, env: { PATH: process.env.PATH, YOKEMATE_MODE: mode, YOKEMATE_TICKET: "YM-1" }, input: JSON.stringify(cliEvent), encoding: "utf8" }).stdout;
      writeFileSync(file, "{}");
      assert.match(cli(), /permissionDecision":"deny/, `${key}/cli/on`);
      writeFileSync(file, JSON.stringify({ guardPolicy: { guards: { [key]: false } } }));
      assert.equal(cli().trim(), "", `${key}/cli/off`);
      const neighborEvent = { tool_name: "Bash", tool_input: key === "wait" ? { command: "pnpm dev" } : { command: "sleep 1" } };
      const neighbor = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(dir, "src", "bash-guard.ts")], { cwd: dir, env: { PATH: process.env.PATH, YOKEMATE_MODE: mode, YOKEMATE_TICKET: "YM-1" }, input: JSON.stringify(neighborEvent), encoding: "utf8" }).stdout;
      assert.match(neighbor, /permissionDecision":"deny/, `${key}/cli/neighbor`);
      runtimeCases([`guards.${key}`], ["tool", "cli", "pane", "ordinary", ...(["noteFileWrite", "noteShellWrite"].includes(key) ? [] : ["coordinator"])]);
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("public CLI decisions reread settings and refuse malformed blocks before repair", async () => {
  const { spawn, spawnSync } = await import("node:child_process");
  const { once } = await import("node:events");
  const { openDb } = await import("../src/db.ts");
  const { coordinatorSocketPath } = await import("../src/coordinator-control.ts");
  const { readCandidatePlanSnapshot } = await import("../src/plan-binding.ts");
  const { acceptPlanRecord, acceptPublication, acceptPublicationDelivery } = await import("../src/plan-publication-state.ts");
  const { sha256 } = await import("../src/subagent-runs.ts");
  const dir = mkdtempSync(join(import.meta.dirname, "fixtures", "runtime-cli-"));
  const runtime = mkdtempSync(join(tmpdir(), "runtime-cli-control-"));
  let parent: ReturnType<typeof spawn> | undefined;
  try {
    cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, ".pi"));
    const file = join(dir, ".pi", "settings.json");
    const set = (guardPolicy: unknown, subagent?: unknown) => writeFileSync(file, JSON.stringify({ guardPolicy, subagent }));
    const run = (script: string, args: string[], env: Record<string, string> = {}, input?: string) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(dir, "src", script), ...args], { cwd: dir, env: { PATH: process.env.PATH, XDG_RUNTIME_DIR: runtime, PI_SESSION_ID: "parent", ...env }, input, encoding: "utf8" });
    const stamp = { YOKEMATE_MODE: "review", YOKEMATE_TICKET: "YM-1" };
    set({});
    assert.equal(run("mode-guard.ts", ["do", "YM-1"], stamp).status, 1);
    set({ guards: { modeOwnership: false } });
    assert.equal(run("mode-guard.ts", ["do", "YM-1"], stamp).stdout.trim(), "launch");
    const db = openDb(join(dir, "yokemate.db"));
    db.close();
    const planDir = join(dir, "home", "knowledge", "org", "repo", "ai", "YM-1-work");
    mkdirSync(planDir, { recursive: true });
    const plan = join(planDir, "plan.md");
    writeFileSync(plan, "# YM-1\n\n## Goal\nFixture.\n\n## Affected repositories\n- `org/repo` — app\n\n## Steps\n1. Fixture.\n\n## Assumptions\n- Fixture.\n\n## Out of scope\n- Other work.\n\n## Acceptance\nFixture completes.\n");
    const snapshot = readCandidatePlanSnapshot(dir, "YM-1", plan);
    const publicationDb = openDb(join(dir, "yokemate.db"));
    const target = "github:org/repo#1";
    const scout = acceptPublication(publicationDb, dir, { target, targetHash: sha256(target), ticket: "YM-1", kind: "scout", bytes: Buffer.from("# Scout\n"), runId: "scout" });
    const acceptance = acceptPublicationDelivery(publicationDb, scout.id, { ownerRunId: "owner", ownerSessionId: "parent", batchId: "batch", runId: "scout", agent: "plan-scout", taskHash: "a".repeat(64), cwd: dir, ticket: "YM-1" });
    const publication = acceptPublication(publicationDb, dir, { target, targetHash: sha256(target), ticket: "YM-1", kind: "plan", bytes: snapshot.bytes, runId: "plan" });
    const record = acceptPlanRecord(publicationDb, { ticket: "YM-1", publicationId: publication.id, planPath: snapshot.path, contentHash: snapshot.contentHash, scopeHash: snapshot.scopeHash, artifactPath: publication.artifact_path, bytes: publication.bytes, scoutPublication: scout.id, scoutAcceptance: acceptance.id });
    publicationDb.close();
    const socket = coordinatorSocketPath(dir, { ...process.env, XDG_RUNTIME_DIR: runtime });
    parent = spawn(process.execPath, [join(root, "test/fixtures/plan-control-server.mjs")], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PLAN_CONTROL_SOCKET: socket, PLAN_CONTROL_ROOT: dir, PLAN_PUBLICATION_ID: String(publication.id), PLAN_RECORD_ID: String(record.id), PLAN_SCOUT_ID: String(scout.id), PLAN_SCOUT_ACCEPTANCE: String(acceptance.id), PLAN_SNAPSHOT: publication.artifact_path, PLAN_REVISION: publication.content_hash } });
    await once(parent.stdout!, "data");
    const review = { YOKEMATE_MODE: "review", YOKEMATE_TICKET: "YM-1" };
    set({});
    assert.match(run("plan-ticket.ts", ["YM-1", plan], review).stderr, /not review's move/);
    set({ guards: { transitionCaller: false } });
    assert.match(run("plan-ticket.ts", ["YM-1", plan], { ...review, YOKEMATE_TICKET: "YM-2" }).stderr, /stamped YM-2, not YM-1/);
    set({ guards: { transitionCaller: false, transitionTicket: false } });
    const ticketGuardOff = run("plan-ticket.ts", ["YM-1", plan], { ...review, YOKEMATE_TICKET: "YM-2" });
    assert.equal(ticketGuardOff.status, 0, ticketGuardOff.stderr);
    const afterTicketGuard = openDb(join(dir, "yokemate.db"));
    assert.equal(afterTicketGuard.prepare("SELECT stage FROM work WHERE ticket='YM-1'").get()?.stage, "planned");
    afterTicketGuard.prepare("UPDATE work SET stage='running' WHERE ticket='YM-1'").run();
    afterTicketGuard.close();
    set({});
    assert.match(run("plan-ticket.ts", ["YM-1", plan], { YOKEMATE_MODE: "plan", YOKEMATE_TICKET: "YM-1" }).stderr, /plan moves from/);
    set({ guards: { transitionSource: false } });
    const sourceGuardOff = run("plan-ticket.ts", ["YM-1", plan], { YOKEMATE_MODE: "plan", YOKEMATE_TICKET: "YM-1" });
    assert.equal(sourceGuardOff.status, 0, sourceGuardOff.stderr);
    const afterSourceGuard = openDb(join(dir, "yokemate.db"));
    assert.equal(afterSourceGuard.prepare("SELECT stage FROM work WHERE ticket='YM-1'").get()?.stage, "planned");
    afterSourceGuard.close();
    set({});
    assert.match(run("stage.ts", ["YM-1", "planned", "--force"], stamp).stderr, /main chat's repair/);
    set({ guards: { stageCaller: false } });
    assert.equal(run("stage.ts", ["YM-1", "planned", "--force"], stamp).status, 0);
    assert.match(run("stage.ts", ["YM-1", "planned"], stamp).stderr, /add --force/);
    set({ guards: { stageForce: false } });
    assert.equal(run("stage.ts", ["YM-1", "planned"]).status, 0);
    assert.match(run("stage.ts", ["YM-1", "planned"], stamp).stderr, /main chat's repair/);
    set({ yolo: true }, { maxConcurrency: "bad" });
    for (const [script, args] of [["mode-guard.ts", ["do", "YM-1"]], ["stage.ts", ["YM-1", "review"]]] as const) {
      const result = run(script, [...args]);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(file));
      assert.match(result.stderr, /subagent.maxConcurrency/);
    }
    const stdin = run("bash-guard.ts", [], stamp, JSON.stringify({ tool_name: "Bash", tool_input: { command: "true" } }));
    assert.equal(JSON.parse(stdin.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.ok(stdin.stdout.includes(file));
    const stop = run("report-guard.ts", [], { YOKEMATE_MODE: "do", YOKEMATE_TICKET: "YM-1" });
    assert.equal(JSON.parse(stop.stdout).decision, "block");
    assert.ok(stop.stdout.includes(file));
    const finalDb = openDb(join(dir, "yokemate.db"));
    assert.equal(finalDb.prepare("SELECT stage FROM work WHERE ticket = 'YM-1'").get()?.stage, "planned");
    finalDb.close();
    runtimeCases(["guards.modeOwnership", "guards.transitionCaller", "guards.transitionTicket", "guards.transitionSource"], ["cli", "pane", "ordinary", "coordinator"]);
    runtimeCases(["guards.stageCaller", "guards.stageForce"], ["cli", "pane", "ordinary", "coordinator"]);
  } finally {
    if (parent && parent.exitCode === null) {
      parent.kill("SIGTERM");
      await once(parent, "exit").catch(() => undefined);
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("loaded completion and report hooks reread only their named settings", async () => {
  const { openDb } = await import("../src/db.ts");
  const dir = mkdtempSync(join(import.meta.dirname, "fixtures", "runtime-events-"));
  const env = { ...process.env };
  try {
    cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, ".pi"));
    const file = join(dir, ".pi", "settings.json");
    writeFileSync(file, "{}");
    const db = openDb(join(dir, "yokemate.db"));
    db.prepare("INSERT INTO work (ticket,url,stage) VALUES ('YM-1','u','running')").run();
    db.close();
    process.env.YOKEMATE_MODE = "do";
    process.env.YOKEMATE_TICKET = "YM-1";
    delete process.env.YOKEMATE_ROLE;
    const guardLoader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, "agent"), settingsManager: SettingsManager.create(dir, join(dir, "agent")), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [join(dir, "src", "guards.ts")] });
    await guardLoader.reload();
    assert.deepEqual(guardLoader.getExtensions().errors, []);
    const messages: unknown[] = [];
    guardLoader.getExtensions().runtime.sendMessage = (message, options) => { messages.push({ message, options }); };
    const extension = guardLoader.getExtensions().extensions[0]!;
    const ctx = { cwd: dir, hasUI: false } as ExtensionContext;
    await extension.handlers.get("agent_settled")![0]!({ type: "agent_settled" } as never, ctx);
    assert.match(JSON.stringify(messages), /stage is still running/);
    writeFileSync(file, JSON.stringify({ guardPolicy: { guards: { doCompletion: false } } }));
    await extension.handlers.get("agent_settled")![0]!({ type: "agent_settled" } as never, ctx);
    assert.equal(messages.length, 1);
    const wait = await extension.handlers.get("tool_call")![0]!({ type: "tool_call", toolCallId: "wait", toolName: "bash", input: { command: "sleep 1" } } as never, ctx);
    assert.equal((wait as { block: boolean }).block, true);
    const busLoader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, "agent"), settingsManager: SettingsManager.create(dir, join(dir, "agent")), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [join(dir, "src", "bus.ts")] });
    await busLoader.reload();
    assert.deepEqual(busLoader.getExtensions().errors, []);
    const report = busLoader.getExtensions().extensions[0]!.handlers.get("tool_call")![0]!;
    process.env.YOKEMATE_MODE = "review";
    process.env.YOKEMATE_PARENT_PANE = "parent";
    writeFileSync(file, "{}");
    assert.equal((await report({ type: "tool_call", toolCallId: "report", toolName: "send_message", input: { to: "foreign" } } as never, ctx) as { block: boolean }).block, true);
    writeFileSync(file, JSON.stringify({ guardPolicy: { guards: { reportTarget: false } } }));
    assert.equal(await report({ type: "tool_call", toolCallId: "report", toolName: "send_message", input: { to: "foreign" } } as never, ctx), undefined);
    const { pathToFileURL } = await import("node:url");
    const { continueOwnedCoordinator } = await import(`${pathToFileURL(join(dir, "src", "coordinator-rpc.ts")).href}?runtime-events`);
    let prompts = 0;
    const blocked: string[] = [];
    const rpc = { childState: { deliveryFailureReason: () => undefined, settled: () => "nudge" }, request: async () => { prompts++; return {}; } };
    writeFileSync(file, "{}");
    continueOwnedCoordinator(rpc as never, { type: "agent_settled" }, (reason: string) => blocked.push(reason));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(prompts, 1);
    assert.equal(blocked.length, 0);
    writeFileSync(file, JSON.stringify({ guardPolicy: { guards: { doCompletion: false } } }));
    continueOwnedCoordinator(rpc as never, { type: "agent_settled" }, (reason: string) => blocked.push(reason));
    assert.deepEqual(blocked, ["coordinator stopped without outcome"]);
    assert.equal(prompts, 1);
    runtimeCases(["guards.doCompletion"], ["tool", "cli", "pane", "ordinary", "coordinator"]);
    runtimeCases(["guards.reportTarget"], ["tool", "pane", "ordinary", "coordinator"]);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ordinary public dispatch pins its snapshot and independently enforces all caps and opt-in confirmation", { timeout: 15000 }, async () => {
  const net = await import("node:net");
  const { once } = await import("node:events");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(import.meta.dirname, "fixtures", "runtime-ordinary-"));
  const sockDir = mkdtempSync(join(tmpdir(), "ym-caps-"));
  const env = { ...process.env };
  const script = process.argv[1];
  const connections: import("node:net").Socket[] = [];
  const arrived = new (await import("node:events")).EventEmitter();
  const server = net.createServer((socket) => socket.once("data", () => { connections.push(socket); arrived.emit("child"); }));
  let shutdown: (() => Promise<void>) | undefined;
  try {
    const sock = join(sockDir, "child.sock");
    server.listen(sock);
    await once(server, "listening");
    process.env.RUNTIME_SETTINGS_TEST_SOCKET = sock;
    delete process.env.YOKEMATE_MODE;
    delete process.env.YOKEMATE_ROLE;
    delete process.env.YOKEMATE_RUN_ID;
    process.argv[1] = join(root, "test", "fixtures", "runtime-settings-child.mjs");
    cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(root, ".pi", "extensions", "subagent"), join(dir, ".pi", "extensions", "subagent"), { recursive: true });
    mkdirSync(join(dir, ".pi", "agents"));
    writeFileSync(join(dir, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: fixture\n---\n");
    const file = join(dir, ".pi", "settings.json");
    const set = (guards = {}, subagent: unknown = { maxParallelTasks: 2, maxConcurrency: 1, maxDetached: 2 }) => writeFileSync(file, JSON.stringify({ guardPolicy: { guards }, subagent }));
    set();
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, "agent"), settingsManager: SettingsManager.create(dir, join(dir, "agent")), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [join(dir, ".pi", "extensions", "subagent", "index.ts")] });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    loaded.runtime.appendEntry = () => undefined;
    const completed = new Map<string, () => void>();
    loaded.runtime.sendMessage = (message) => {
      const envelope = (message.details as { envelope?: { kind: string; batchId: string } })?.envelope;
      if (envelope?.kind === "batch") completed.get(envelope.batchId)?.();
    };
    const tool = loaded.extensions[0]!.tools.get("subagent")!.definition;
    let confirmations = 0;
    const ctx = { cwd: dir, mode: "rpc", hasUI: true, isProjectTrusted: () => false, ui: { setWidget() {}, confirm: async () => { confirmations++; return false; } } } as unknown as ExtensionContext;
    shutdown = async () => { for (const handler of loaded.extensions[0]!.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" } as never, ctx); };
    let serial = 0;
    const task = { agent: "worker", task: "fixture" };
    const dispatch = async (params: Record<string, unknown>) => {
      const id = `caps-${++serial}`;
      const done = new Promise<void>((resolve) => completed.set(id, resolve));
      const result = await tool.execute(id, params as never, undefined, () => undefined, ctx);
      return { result, done };
    };
    const text = (result: Awaited<ReturnType<typeof dispatch>>["result"]) => result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
    const count = async (n: number) => { while (connections.length < n) await once(arrived, "child"); };
    const finish = async (batch: Awaited<ReturnType<typeof dispatch>>, indexes: number[]) => { for (const index of indexes) connections[index]!.write("finish"); await batch.done; await new Promise<void>((resolve) => setImmediate(resolve)); };
    await assert.rejects(() => dispatch({ tasks: [task, task, task] }), /Too many parallel tasks/);
    const denied = await dispatch({ ...task, confirmProjectAgents: true });
    assert.match(text(denied.result), /not approved/);
    assert.equal(confirmations, 1);
    set({ projectAgentConfirmation: false });
    const one = await dispatch({ ...task, confirmProjectAgents: true });
    await count(1);
    assert.equal(confirmations, 1);
    await finish(one, [0]);
    set();
    const pinned = await dispatch({ tasks: [task, task] });
    await count(2);
    set({ parallelConcurrencyLimit: false });
    assert.equal(connections.length, 2);
    await assert.rejects(() => dispatch(task), /Too many detached/);
    connections[1]!.write("finish");
    await count(3);
    await finish(pinned, [2]);
    const wide = await dispatch({ tasks: [task, task] });
    await count(5);
    await finish(wide, [3, 4]);
    set({ parallelTaskLimit: false }, { maxParallelTasks: 2, maxConcurrency: 1, maxDetached: 3 });
    const uncapped = await dispatch({ tasks: [task, task, task] });
    await count(6);
    assert.equal(connections.length, 6);
    await assert.rejects(() => dispatch(task), /Too many detached/);
    connections[5]!.write("finish");
    await count(7);
    connections[6]!.write("finish");
    await count(8);
    await finish(uncapped, [7]);
    set({}, { maxParallelTasks: 1, maxConcurrency: 1, maxDetached: 1 });
    const live = await dispatch(task);
    await count(9);
    await assert.rejects(() => dispatch(task), /Too many detached/);
    set({ detachedLimit: false }, { maxParallelTasks: 1, maxConcurrency: 1, maxDetached: 1 });
    const second = await dispatch(task);
    await count(10);
    await assert.rejects(() => dispatch({ tasks: [task, task] }), /Too many parallel tasks/);
    set({}, { maxDetached: "invalid" });
    assert.match(text((await dispatch(task)).result), /subagent.maxDetached/);
    await finish(live, [8]);
    await finish(second, [9]);
    runtimeCases(["guards.projectAgentConfirmation", "guards.parallelTaskLimit", "guards.parallelConcurrencyLimit", "subagent.maxParallelTasks", "subagent.maxConcurrency"], ["tool", "pane", "ordinary", "coordinator"]);
    runtimeCases(["guards.detachedLimit", "subagent.maxDetached"], ["tool", "pane", "ordinary"]);
  } finally {
    for (const connection of connections) connection.destroy();
    await shutdown?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.argv[1] = script;
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    rmSync(dir, { recursive: true, force: true });
    rmSync(sockDir, { recursive: true, force: true });
  }
});

test("live do coordinator keeps single-use approval duplicate policy and detached admission independent", { timeout: 30000 }, async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { openDb } = await import("../src/db.ts");
  const dir = mkdtempSync(join(import.meta.dirname, "fixtures", "runtime-do-"));
  const env = { ...process.env };
  const script = process.argv[1];
  let shutdown: (() => Promise<void>) | undefined;
  try {
    Object.assign(process.env, reviewPaneStamp);
    clearCoordinatorOrigin();
    process.argv[1] = join(root, "test", "fixtures", "workflow-rpc-child.mjs");
    cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(root, ".pi", "extensions", "subagent"), join(dir, ".pi", "extensions", "subagent"), { recursive: true });
    mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
    writeFileSync(join(dir, ".pi", "agents", "do-coordinator.md"), "fixture");
    writeFileSync(join(dir, ".env.local"), "");
    const settings = join(dir, ".pi", "settings.json");
    const set = (guards: Record<string, boolean>, maxDetached = 8) => writeFileSync(settings, JSON.stringify({ guardPolicy: { guards }, subagent: { maxParallelTasks: 1, maxConcurrency: 1, maxDetached } }));
    set({});
    const planDir = join(dir, "home", "knowledge", "org", "repo", "ai", "YM-1-work");
    mkdirSync(planDir, { recursive: true });
    const plan = join(planDir, "plan.md");
    writeFileSync(plan, "# YM-1 — fixture\n\n## Goal\nFixture.\n\n## Affected repositories\n- `org/repo` — app\n\n## Steps\n1. Fixture.\n\n## Assumptions\n- Fixture.\n\n## Out of scope\n- Other work.\n\n## Acceptance\nFixture completes.\n");
    const db = openDb(join(dir, "yokemate.db"));
    db.prepare("INSERT INTO project (org,repo,path,tracker,tracker_key,model) VALUES ('org','repo',?,'x','YM','test/model')").run(join(dir, "clone"));
    db.prepare("INSERT INTO work (ticket,url,stage,plan) VALUES ('YM-1','u','planned',?)").run(plan);
    db.close();
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, "agent"), settingsManager: SettingsManager.create(dir, join(dir, "agent")), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [join(dir, ".pi", "extensions", "subagent", "index.ts")] });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    loaded.runtime.appendEntry = () => undefined;
    loaded.runtime.sendMessage = () => undefined;
    const extension = loaded.extensions[0]!;
    const tool = extension.tools.get("subagent")!.definition;
    const ctx = { cwd: dir, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "main" }, modelRegistry: { getAll: () => [{ provider: "test", id: "model", name: "model" }], hasConfiguredAuth: () => true }, ui: { notify() {}, setWidget() {}, confirm: async () => true } } as unknown as ExtensionContext;
    for (const handler of extension.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" } as never, ctx);
    shutdown = async () => { for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" } as never, ctx); };
    const input = extension.handlers.get("input")![0]!;
    const approve = () => input({ type: "input", source: "interactive", text: "/do YM-1" } as never, ctx);
    const launch = () => tool.execute("do", { coordinator: { mode: "do", tickets: ["YM-1"] } }, undefined, () => undefined, ctx);
    await approve();
    const first = await launch();
    const firstId = (first.details as { runId?: string }).runId;
    assert.ok(firstId, JSON.stringify(first));
    await approve();
    assert.match(JSON.stringify(await launch()), /already runs/);
    set({ duplicateDo: false });
    await approve();
    const second = await launch();
    const secondId = (second.details as { runId?: string }).runId;
    assert.ok(secondId, JSON.stringify(second));
    assert.notEqual(secondId, firstId);
    const cli = () => promisify(execFile)(process.execPath, ["--experimental-strip-types", "--no-warnings", join(dir, "src", "spawn.ts"), "YM-1"], { cwd: dir, env: { PATH: process.env.PATH, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, PI_SESSION_ID: "main" } });
    set({});
    await approve();
    let cliRefusal: Error & { stdout?: string; stderr?: string } | undefined;
    try { await cli(); } catch (error) { cliRefusal = error as Error & { stdout?: string; stderr?: string }; }
    assert.match(`${cliRefusal?.stdout ?? ""}\n${cliRefusal?.stderr ?? ""}\n${cliRefusal?.message ?? ""}`, /already runs/);
    set({ duplicateDo: false });
    await approve();
    const cliAllowed = await cli();
    const cliId = cliAllowed.stdout.match(/background run ([a-f0-9-]+)/)![1]!;
    for (const { stamp, bypass } of [{ stamp: { YOKEMATE_MODE: "plan", YOKEMATE_TICKET: "YM-1" }, bypass: { transitionCaller: false } }, { stamp: { YOKEMATE_ROLE: "executor" }, bypass: {} }] as const) {
      set({ spawnCaller: false, ...bypass });
      await approve();
      Object.assign(process.env, stamp);
      assert.match(JSON.stringify(await launch()), /already runs/);
      for (const key of Object.keys(stamp)) delete process.env[key];
      set({ spawnCaller: false, duplicateDo: false, ...bypass });
      await approve();
      Object.assign(process.env, stamp);
      const allowed = await launch();
      const allowedId = (allowed.details as { runId?: string } | undefined)?.runId;
      assert.ok(allowedId, JSON.stringify(allowed));
      for (const key of Object.keys(stamp)) delete process.env[key];
      await tool.execute("cancel", { cancelRun: allowedId }, undefined, () => undefined, ctx);
    }
    set({ duplicateDo: false }, 1);
    await approve();
    assert.match(JSON.stringify(await launch()), /Too many detached/);
    set({ duplicateDo: false, detachedLimit: false }, 1);
    await approve();
    const uncapped = await launch();
    const uncappedId = (uncapped.details as { runId?: string }).runId;
    assert.ok(uncappedId, JSON.stringify(uncapped));
    for (const runId of [firstId, secondId, cliId, uncappedId]) await tool.execute("cancel", { cancelRun: runId }, undefined, () => undefined, ctx);
    runtimeCases(["guards.duplicateDo"], ["tool", "cli", "pane", "ordinary", "coordinator"]);
    runtimeCases(["guards.detachedLimit", "subagent.maxDetached"], ["cli", "coordinator"]);
  } finally {
    await shutdown?.();
    process.argv[1] = script;
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live ship coordinator keeps permit identity duplicate policy and detached admission independent", { timeout: 30000 }, async () => {
  const { execFile, execFileSync } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { openDb } = await import("../src/db.ts");
  const dir = mkdtempSync(join(import.meta.dirname, "fixtures", "runtime-ship-"));
  const env = { ...process.env };
  const script = process.argv[1];
  let shutdown: (() => Promise<void>) | undefined;
  try {
    Object.assign(process.env, reviewPaneStamp);
    clearCoordinatorOrigin();
    process.argv[1] = join(root, "test", "fixtures", "workflow-rpc-child.mjs");
    cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(root, ".pi", "extensions", "subagent"), join(dir, ".pi", "extensions", "subagent"), { recursive: true });
    mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
    writeFileSync(join(dir, ".pi", "agents", "ship-coordinator.md"), "fixture");
    writeFileSync(join(dir, ".env.local"), "");
    const settings = join(dir, ".pi", "settings.json");
    const set = (guards: Record<string, boolean>, maxDetached = 8) => writeFileSync(settings, JSON.stringify({ guardPolicy: { guards: { shipConfirmation: false, ...guards } }, subagent: { maxParallelTasks: 1, maxConcurrency: 1, maxDetached } }));
    set({});
    const planDir = join(dir, "home", "knowledge", "org", "repo", "ai", "YM-1-work");
    mkdirSync(planDir, { recursive: true });
    const plan = join(planDir, "plan.md");
    writeFileSync(plan, "# YM-1 — fixture\n\n## Goal\nFixture.\n\n## Affected repositories\n- `org/repo` — app\n\n## Steps\n1. Fixture.\n\n## Assumptions\n- Fixture.\n\n## Out of scope\n- Other work.\n\n## Acceptance\nFixture completes.\n");
    const worktree = join(dir, "work", "YM-1", "repo");
    mkdirSync(worktree, { recursive: true });
    execFileSync("git", ["init", "-b", "YM-1", worktree], { stdio: "pipe" });
    execFileSync("git", ["-C", worktree, "remote", "add", "origin", "https://github.com/org/repo.git"]);
    const shim = join(dir, "shim");
    mkdirSync(shim);
    writeFileSync(join(shim, "gh"), `#!/bin/sh\nprintf '{"baseRefName":"main","url":"https://github.com/org/repo/pull/1","headRefOid":"${"a".repeat(40)}","headRefName":"YM-1"}\\n'\n`, { mode: 0o755 });
    process.env.PATH = `${shim}:${process.env.PATH ?? ""}`;
    const db = openDb(join(dir, "yokemate.db"));
    db.prepare("INSERT INTO project (org,repo,path,tracker,tracker_key,model) VALUES ('org','repo',?,'x','YM','test/model')").run(join(dir, "clone"));
    db.prepare("INSERT INTO work (ticket,url,stage,plan,folder) VALUES ('YM-1','u','accepted',?,?)").run(plan, join(dir, "work", "YM-1"));
    db.close();
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, "agent"), settingsManager: SettingsManager.create(dir, join(dir, "agent")), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [join(dir, ".pi", "extensions", "subagent", "index.ts")] });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    loaded.runtime.appendEntry = () => undefined;
    loaded.runtime.sendMessage = () => undefined;
    const extension = loaded.extensions[0]!;
    const tool = extension.tools.get("subagent")!.definition;
    const ctx = { cwd: dir, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "main" }, modelRegistry: { getAll: () => [{ provider: "test", id: "model", name: "model" }], hasConfiguredAuth: () => true }, ui: { notify() {}, setWidget() {}, confirm: async () => true } } as unknown as ExtensionContext;
    for (const handler of extension.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" } as never, ctx);
    shutdown = async () => { for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" } as never, ctx); };
    const input = extension.handlers.get("input")![0]!;
    const permit = () => input({ type: "input", source: "interactive", text: "/ship YM-1" } as never, ctx);
    const launch = (context = ctx) => tool.execute("ship", { coordinator: { mode: "ship", tickets: ["YM-1"] } }, undefined, () => undefined, context);
    await permit();
    const first = await launch();
    const firstId = (first.details as { runId?: string }).runId;
    assert.ok(firstId, JSON.stringify(first));
    await permit();
    assert.match(JSON.stringify(await launch()), /already runs/);
    set({ duplicateMode: false });
    await permit();
    const second = await launch();
    const secondId = (second.details as { runId?: string }).runId;
    assert.ok(secondId, JSON.stringify(second));
    assert.notEqual(secondId, firstId);
    const cli = () => promisify(execFile)(process.execPath, ["--experimental-strip-types", "--no-warnings", join(dir, "src", "mode-tab.ts"), "ship", "YM-1"], { cwd: dir, env: { PATH: process.env.PATH, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, PI_SESSION_ID: "main" } });
    set({});
    await permit();
    let cliRefusal: Error & { stdout?: string; stderr?: string } | undefined;
    try { await cli(); } catch (error) { cliRefusal = error as Error & { stdout?: string; stderr?: string }; }
    assert.match(`${cliRefusal?.stdout ?? ""}\n${cliRefusal?.stderr ?? ""}`, /already runs/);
    set({ duplicateMode: false });
    await permit();
    const cliAllowed = await cli();
    const cliId = cliAllowed.stdout.match(/background run ([a-f0-9-]+)/)![1]!;
    await permit();
    const foreign = { ...ctx, sessionManager: { getSessionId: () => "foreign" } } as ExtensionContext;
    assert.match(JSON.stringify(await launch(foreign)), /current interactive \/ship/);
    set({ duplicateMode: false }, 1);
    await permit();
    assert.match(JSON.stringify(await launch()), /Too many detached/);
    set({ duplicateMode: false, detachedLimit: false }, 1);
    await permit();
    const uncapped = await launch();
    const uncappedId = (uncapped.details as { runId?: string }).runId;
    assert.ok(uncappedId, JSON.stringify(uncapped));
    for (const runId of [firstId, secondId, cliId, uncappedId]) await tool.execute("cancel", { cancelRun: runId }, undefined, () => undefined, ctx);
    runtimeCases(["guards.duplicateMode"], ["tool", "cli", "coordinator"]);
    runtimeCases(["guards.shipConfirmation"], ["cli"]);
  } finally {
    await shutdown?.();
    process.argv[1] = script;
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("coordinator public admission rereads ship confirmation and never manufactures a permit", async () => {
  const dir = mkdtempSync(join(import.meta.dirname, "fixtures", "runtime-coordinator-"));
  const env = { ...process.env };
  let shutdown: (() => Promise<void>) | undefined;
  try {
    Object.assign(process.env, reviewPaneStamp);
    clearCoordinatorOrigin();
    cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(root, ".pi", "extensions", "subagent"), join(dir, ".pi", "extensions", "subagent"), { recursive: true });
    const file = join(dir, ".pi", "settings.json");
    const set = (shipConfirmation: boolean) => writeFileSync(file, JSON.stringify({ guardPolicy: { guards: { shipConfirmation } } }));
    set(true);
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, "agent"), settingsManager: SettingsManager.create(dir, join(dir, "agent")), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [join(dir, ".pi", "extensions", "subagent", "index.ts")] });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    const reportWaiters: Array<(message: string) => void> = [];
    const reportMessages: string[] = [];
    loaded.runtime.sendMessage = (message) => {
      const text = String((message as { content?: string }).content ?? "");
      reportMessages.push(text);
      for (const resolve of reportWaiters.splice(0)) resolve(text);
    };
    const waitForReport = async (pattern: RegExp): Promise<string> => {
      const found = reportMessages.find((message) => pattern.test(message));
      if (found) return found;
      for (;;) {
        const message = await new Promise<string>((resolve) => reportWaiters.push(resolve));
        if (pattern.test(message)) return message;
      }
    };
    const extension = loaded.extensions[0]!;
    const input = extension.handlers.get("input")![0]!;
    const tool = extension.tools.get("subagent")!.definition;
    let confirmations = 0;
    const notifications: string[] = [];
    const ctx = { cwd: dir, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "main" }, ui: { notify(message: string) { notifications.push(message); }, setWidget() {}, confirm: async () => { confirmations++; return true; } } } as unknown as ExtensionContext;
    for (const handler of extension.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" } as never, ctx);
    shutdown = async () => { for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" } as never, ctx); };
    writeFileSync(file, JSON.stringify({ guardPolicy: { yolo: true } }));
    assert.deepEqual(await input({ type: "input", source: "interactive", text: "запусти готовый план YM-1" } as never, ctx), { action: "handled" });
    assert.match(notifications.at(-1) ?? "", /configured model and external authentication/);
    const malformedRequest = await tool.execute("invalid", { coordinator: { mode: "do", tickets: ["../YM-1"] } }, undefined, () => undefined, ctx);
    assert.match(JSON.stringify(malformedRequest), /invalid ticket key/);
    const launch = async (tickets = ["YM-1"]) => {
      const result = await tool.execute("ship", { coordinator: { mode: "ship", tickets } }, undefined, () => undefined, ctx);
      for (const handler of extension.handlers.get("tool_execution_end") ?? []) await handler({ type: "tool_execution_end", toolName: "subagent", toolCallId: "ship", result, isError: Boolean("isError" in result && result.isError) } as never, ctx);
      return result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
    };
    process.env.YOKEMATE_MODE = "plan";
    process.env.YOKEMATE_TICKET = "YM-1";
    writeFileSync(file, "{}");
    const callerOn = await tool.execute("do-caller-on", { coordinator: { mode: "do", tickets: ["YM-1"] } }, undefined, () => undefined, ctx);
    assert.match(JSON.stringify(callerOn), /main chat only/);
    writeFileSync(file, JSON.stringify({ guardPolicy: { guards: { spawnCaller: false } } }));
    const callerOff = await tool.execute("do-caller-off", { coordinator: { mode: "do", tickets: ["YM-1"] } }, undefined, () => undefined, ctx);
    assert.doesNotMatch(JSON.stringify(callerOff), /main chat only/);
    assert.match(JSON.stringify(callerOff), /no current recorded plan/);
    delete process.env.YOKEMATE_MODE;
    delete process.env.YOKEMATE_TICKET;
    set(false);
    await input({ type: "input", source: "interactive", text: "/ship YM-1" } as never, ctx);
    writeFileSync(file, JSON.stringify({ subagent: { maxDetached: 0 } }));
    assert.deepEqual(await input({ type: "input", source: "interactive", text: "replace this permit" } as never, ctx), { action: "handled" });
    assert.match(notifications.at(-1) ?? "", /subagent.maxDetached/);
    set(false);
    assert.match(await launch(), /current interactive \/ship/);
    for (const enabled of [true, false]) {
      set(enabled);
      const before = confirmations;
      assert.match(await launch(), /current interactive \/ship/);
      assert.equal(confirmations, before);
      await input({ type: "input", source: "interactive", text: "/ship YM-1" } as never, ctx);
      assert.match(await launch(["YM-2"]), /current interactive \/ship/);
      assert.equal(confirmations, before);
      assert.match(await launch(), /accepted/);
      assert.match(await waitForReport(/no task folder/), /no task folder/);
      assert.equal(confirmations, before + Number(enabled));
      assert.match(await launch(), /current interactive \/ship/);
    }
    writeFileSync(file, JSON.stringify({ subagent: { maxDetached: 0 } }));
    const failed = await tool.execute("bad-do", { coordinator: { mode: "do", tickets: ["YM-1"] } }, undefined, () => undefined, ctx);
    assert.match(JSON.stringify(failed), /subagent.maxDetached/);
    assert.ok(JSON.stringify(failed).includes(file));
    runtimeCases(["guards.shipConfirmation"], ["tool", "pane", "ordinary", "coordinator"]);
    runtimeCases(["guards.spawnCaller"], ["tool", "cli", "pane", "ordinary", "coordinator"]);
  } finally {
    await shutdown?.();
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    rmSync(dir, { recursive: true, force: true });
  }
});
