import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DefaultResourceLoader, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const root = join(import.meta.dirname, "..");

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
    const call = (toolName: string, input: Record<string, unknown>) => hook({ type: "tool_call", toolCallId: "fixture", toolName, input } as never, ctx);
    assert.deepEqual(await call("bash", { command: "sleep 1" }), { block: true, reason: "Waiting is forbidden: a finished subagent returns its result as the tool result, and completion comes to the session on its own. Check the condition once, without sleep, and keep working." });
    set({ guardPolicy: { guards: { wait: false } } });
    assert.equal(await call("bash", { command: "sleep 1" }), undefined);
    assert.equal((await call("bash", { command: "pnpm dev" }) as { block: boolean }).block, true);
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
    for (const [key, mode, toolName, input] of rows) {
      process.env.YOKEMATE_MODE = mode;
      const call = (name = toolName as string, args: Record<string, unknown> = input) => hook({ type: "tool_call", toolCallId: key, toolName: name, input: args } as never, ctx);
      writeFileSync(file, "{}");
      assert.equal((await call() as { block: boolean }).block, true, key);
      writeFileSync(file, JSON.stringify({ guardPolicy: { guards: { [key]: false } } }));
      assert.equal(await call(), undefined, key);
      const neighbor = key === "wait" ? { command: "pnpm dev" } : { command: "sleep 1" };
      assert.equal((await call("bash", neighbor) as { block: boolean }).block, true, `${key} neighbor`);
      writeFileSync(file, JSON.stringify({ guardPolicy: { yolo: true, guards: { [key]: true }, workflowApproval: true } }));
      assert.equal((await call() as { block: boolean }).block, true, `${key} explicit on`);
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("public CLI decisions reread settings and refuse malformed blocks before repair", async () => {
  const { spawnSync } = await import("node:child_process");
  const { openDb } = await import("../src/db.ts");
  const dir = mkdtempSync(join(import.meta.dirname, "fixtures", "runtime-cli-"));
  try {
    cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, ".pi"));
    const file = join(dir, ".pi", "settings.json");
    const set = (guardPolicy: unknown, subagent?: unknown) => writeFileSync(file, JSON.stringify({ guardPolicy, subagent }));
    const run = (script: string, args: string[], env: Record<string, string> = {}, input?: string) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(dir, "src", script), ...args], { cwd: dir, env: { PATH: process.env.PATH, ...env }, input, encoding: "utf8" });
    const stamp = { YOKEMATE_MODE: "review", YOKEMATE_TICKET: "YM-1" };
    set({});
    assert.equal(run("mode-guard.ts", ["do", "YM-1"], stamp).status, 1);
    set({ guards: { modeOwnership: false } });
    assert.equal(run("mode-guard.ts", ["do", "YM-1"], stamp).stdout.trim(), "launch");
    const db = openDb(join(dir, "yokemate.db"));
    db.close();
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
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
    set({ parallelTaskLimit: false, detachedLimit: false });
    const uncapped = await dispatch({ tasks: [task, task, task] });
    await count(6);
    assert.equal(connections.length, 6);
    connections[5]!.write("finish");
    await count(7);
    connections[6]!.write("finish");
    await count(8);
    await finish(uncapped, [7]);
    set({}, { maxParallelTasks: 1, maxConcurrency: 1, maxDetached: 1 });
    const live = await dispatch(task);
    await count(9);
    await assert.rejects(() => dispatch(task), /Too many detached/);
    set({}, { maxParallelTasks: 1, maxConcurrency: 1, maxDetached: 2 });
    const second = await dispatch(task);
    await count(10);
    set({}, { maxDetached: "invalid" });
    assert.match(text((await dispatch(task)).result), /subagent.maxDetached/);
    await finish(live, [8]);
    await finish(second, [9]);
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
