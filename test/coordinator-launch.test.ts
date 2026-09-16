import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { bindCoordinatorControl, processStarttime } from "../src/coordinator-control.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { DefaultResourceLoader, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { markDoRunning, prepareDo, prepareShip, splitDoRequest, validateCoordinatorRequest } from "../src/coordinator-launch.ts";

function root(): string {
  const root = mkdtempSync(join(tmpdir(), "coordinator-launch-"));
  mkdirSync(join(root, ".pi", "agents", "do"), { recursive: true });
  mkdirSync(join(root, "home", "knowledge", "org", "repo", "ai", "YM-1-work"), { recursive: true });
  writeFileSync(join(root, ".pi", "settings.json"), "{}");
  writeFileSync(join(root, "home", "knowledge", "org", "repo", "ai", "YM-1-work", "YM-1-work-plan.md"), "# YM-1\n\n## Affected repositories\n- `org/repo` — app\n");
  const db = openDb(join(root, "yokemate.db"));
  db.prepare("INSERT INTO project (org, repo, path, tracker, tracker_key, model) VALUES ('org','repo', ?, 'x', 'YM', 'test/model')").run(join(root, "clone"));
  return root;
}

test("do preparation resolves exact plan parts and CAS prevents stale running write", () => {
  const dir = root();
  try {
    const plan = join(dir, "home", "knowledge", "org", "repo", "ai", "YM-1-work", "YM-1-work-plan.md");
    const prepared = prepareDo(dir, { mode: "do", tickets: ["YM-1"], plan }, {});
    assert.equal(prepared.parts[0]?.repo, "org/repo");
    assert.equal(prepared.model, "test/model");
    const db = openDb(join(dir, "yokemate.db"));
    db.prepare("INSERT INTO work (ticket, url, stage) VALUES ('YM-1','u','review')").run();
    assert.throws(() => markDoRunning(dir, prepared, { YOKEMATE_MODE: "do", YOKEMATE_TICKET: "YM-1", YOKEMATE_ROLE: "coordinator" }), /changed from absent to review/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("do preparation preserves an explicit model without a thinking setting", () => {
  const dir = root();
  try {
    const plan = join(dir, "home", "knowledge", "org", "repo", "ai", "YM-1-work", "YM-1-work-plan.md");
    const prepared = prepareDo(dir, { mode: "do", tickets: ["YM-1"], plan, model: "test/model:high" }, {});
    assert.equal(prepared.model, "test/model:high");
    const settings = JSON.parse(readFileSync(join(prepared.cwd, ".pi", "settings.json"), "utf8"));
    assert.equal("thinkingLevel" in settings, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("failed coordinator starts release duplicate reservations and capacity before retry", async () => {
  const source = join(import.meta.dirname, "..");
  const dir = mkdtempSync(join(import.meta.dirname, "fixtures", "coordinator-start-"));
  const previous = { ...process.env };
  const script = process.argv[1];
  let shutdown: (() => Promise<void>) | undefined;
  delete process.env.YOKEMATE_MODE;
  delete process.env.YOKEMATE_ROLE;
  try {
    cpSync(join(source, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(source, ".pi", "extensions", "subagent"), join(dir, ".pi", "extensions", "subagent"), { recursive: true });
    const agentDir = join(dir, "agent");
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir, settingsManager: SettingsManager.create(dir, agentDir),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [join(dir, ".pi", "extensions", "subagent", "index.ts")],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    const reports: unknown[] = [];
    loaded.runtime.sendMessage = (message) => { reports.push(message); };
    loaded.runtime.appendEntry = () => undefined;
    const tool = loaded.extensions.flatMap((extension) => [...extension.tools.values()]).find((tool) => tool.definition.name === "subagent");
    assert.ok(tool);
    const render = tool.definition.renderResult!;
    const renderTheme = {} as Parameters<typeof render>[2];
    for (const rows of [
      ["accepted run-1, model test/model, cwd /one", "accepted run-2, model test/model, cwd /two"],
      ["refused bad: invalid ticket key", "accepted run-2, model test/model, cwd /two"],
      ["refused bad: invalid ticket key", "refused worse: invalid ticket key"],
    ]) {
      const runs = rows.filter((row) => row.startsWith("accepted")).map((row) => ({ ticket: "YM-1", runId: row.split(" ")[1] }));
      const result = { content: rows.map((text) => ({ type: "text" as const, text })), details: { runs } };
      for (const expanded of [false, true]) {
        const rendered = render(result, { expanded, isPartial: false }, renderTheme, {} as Parameters<typeof render>[3]);
        const text = rendered.render(200).join("\n");
        for (const row of rows) assert.ok(text.includes(row), text);
      }
    }
    const widgets: unknown[] = [];
    const ctx = {
      cwd: dir, mode: "rpc", hasUI: true,
      sessionManager: { getSessionId: () => "fixture-parent" },
      ui: { notify() {}, setWidget: (_key: string, lines: unknown) => { widgets.push(lines); } },
      modelRegistry: { getAll: () => [{ provider: "test", id: "model", name: "model" }], hasConfiguredAuth: () => true },
    } as unknown as ExtensionContext;
    const extension = loaded.extensions[0]!;
    for (const handler of extension.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" } as never, ctx);
    shutdown = async () => { for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" } as never, ctx); };
    const approve = async (text: string) => { for (const handler of extension.handlers.get("input") ?? []) await handler({ type: "input", source: "interactive", text } as never, { ...ctx, mode: "tui" }); };
    for (let attempt = 0; attempt < 10; attempt++) {
      const result: AgentToolResult<unknown> = await tool.definition.execute(`retry-${attempt}`, { coordinator: { mode: "do", tickets: ["YM-1"], plan: join(dir, "missing-plan.md") } }, undefined, () => undefined, ctx);
      assert.equal("isError" in result && result.isError, true);
      const text = result.content[0];
      assert.ok(text?.type === "text");
      assert.match(text.text, /no current recorded plan for approval/);
      assert.doesNotMatch(text.text, /already runs|model pending|accepted|Too many detached/);
    }
    assert.deepEqual(reports, []);
    mkdirSync(join(dir, ".pi", "agents", "do"), { recursive: true });
    writeFileSync(join(dir, ".pi", "agents", "do-coordinator.md"), "Fixture");
    const db = openDb(join(dir, "yokemate.db"));
    db.prepare("INSERT INTO project (org, repo, path, tracker, tracker_key, model) VALUES ('org','repo', ?, 'github', 'YM', 'test/model')").run(join(dir, "clone"));
    const record = (ticket: string) => {
      const folder = join(dir, "home", "knowledge", "org", "repo", "ai", `${ticket}-work`);
      mkdirSync(folder, { recursive: true });
      const plan = join(folder, "plan.md");
      writeFileSync(plan, `# ${ticket} — recovered\n\n## Affected repositories\n- \`org/repo\` — app\n`);
      db.prepare("INSERT INTO work (ticket,url,stage,plan) VALUES (?, 'u','planned',?)").run(ticket, plan);
      return plan;
    };
    const plan = record("YM-1");
    record("YM-2");
    await approve("/do YM-1 YM-2");
    process.argv[1] = join(source, "test", "fixtures", "coordinator-rpc-child.ts");
    const accepted = await tool.definition.execute("recovered", { coordinator: { mode: "do", tickets: ["not-a-key", "YM-1", "YM-2"] } }, undefined, () => undefined, ctx);
    assert.equal("isError" in accepted && accepted.isError, false, JSON.stringify(accepted));
    const { runId } = accepted.details as { runId: string };
    assert.ok(runId);
    const { runs } = accepted.details as { runs: { ticket: string; runId: string }[] };
    assert.deepEqual(runs.map((run) => run.ticket), ["YM-1", "YM-2"]);
    assert.equal(runId, runs[0].runId);
    assert.notEqual(runs[0].runId, runs[1].runId);
    assert.deepEqual(accepted.content.map((part) => part.type === "text" ? part.text.split(",")[0] : ""), [
      'refused not-a-key: invalid ticket key "not-a-key"', `accepted ${runs[0].runId}`, `accepted ${runs[1].runId}`,
    ]);
    const queue = openDb(join(dir, "yokemate.db"));
    assert.deepEqual(queue.prepare("SELECT ticket, stage FROM work ORDER BY ticket").all().map((row) => ({ ...row })), [
      { ticket: "YM-1", stage: "running" }, { ticket: "YM-2", stage: "running" },
    ]);
    queue.close();
    record("YM-3");
    db.close();
    await approve("/do YM-1 YM-3");
    const repeated = await tool.definition.execute("repeated", { coordinator: { mode: "do", tickets: ["YM-1", "YM-3"] } }, undefined, () => undefined, ctx);
    assert.equal("isError" in repeated && repeated.isError, false);
    assert.match((repeated.content[0] as { text: string }).text, /^refused YM-1: .*already runs/);
    const extra = (repeated.details as { runs: { ticket: string; runId: string }[] }).runs;
    assert.deepEqual(extra.map((run) => run.ticket), ["YM-3"]);
    for (const run of [...runs.slice(1), ...extra]) await tool.definition.execute("cancel-sibling", { cancelRun: run.runId }, undefined, () => undefined, ctx);
    const pids = JSON.parse(readFileSync(join(dir, "work", "YM-1", "fixture-pids.json"), "utf8")) as number[];
    try {
      assert.ok(widgets.some((lines) => Array.isArray(lines) && lines.some((line) => /^do YM-1 /.test(line)) && lines.some((line) => /task-reviewer/.test(line))));
      const cancellation = tool.definition.execute("cancel", { cancelRun: runId }, undefined, () => undefined, ctx);
      assert.equal(widgets.at(-1), undefined);
      const cancelled = await cancellation;
      assert.deepEqual(cancelled.content, [{ type: "text", text: `${runId} cancelled` }]);
      for (const pid of pids) assert.throws(() => process.kill(pid, 0));
      const again = await tool.definition.execute("cancel-again", { cancelRun: runId }, undefined, () => undefined, ctx);
      assert.deepEqual(again.content, cancelled.content);
      assert.deepEqual(reports, []);
    } finally {
      await tool.definition.execute("cleanup", { cancelRun: runId }, undefined, () => undefined, ctx);
    }
  } finally {
    await shutdown?.();
    process.argv[1] = script;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("coordinator requests reject malformed keys, duplicate batches and split a do batch per key", () => {
  const request = { mode: "do" as const, tickets: ["YM-1", "YM-2"], plan: "/plan.md", model: "test/model:high" };
  assert.doesNotThrow(() => validateCoordinatorRequest(request));
  assert.deepEqual(splitDoRequest(request), [
    { ...request, tickets: ["YM-1"] }, { ...request, tickets: ["YM-2"] },
  ]);
  assert.deepEqual(request.tickets, ["YM-1", "YM-2"]);
  const ship = { mode: "ship" as const, tickets: ["YM-2", "YM-1"] };
  assert.deepEqual(splitDoRequest(ship), [ship]);
  assert.throws(() => validateCoordinatorRequest({ mode: "do", tickets: ["YM-1", "YM-1"] }), /duplicates/);
  assert.throws(() => splitDoRequest({ mode: "do", tickets: ["YM-1", "YM-1"] }), /duplicates/);
  assert.throws(() => validateCoordinatorRequest({ mode: "ship", tickets: ["YM-1", "YM-1"] }), /duplicates/);
  assert.throws(() => validateCoordinatorRequest({ mode: "do", tickets: ["../YM-1"] }), /invalid/);
});


test("spawn routes each key independently through its retained parent", async () => {
  const source = join(import.meta.dirname, "..");
  const dir = mkdtempSync(join(import.meta.dirname, "fixtures", "spawn-batch-"));
  const requests: unknown[] = [];
  const parent = bindCoordinatorControl(dir, {
    launch: async (request) => {
      requests.push(request);
      if (request.tickets[0] === "YM-1") throw new Error("already running");
      return { runId: "fixture-run-2", identity: {} };
    },
    status: () => ({ requestId: "unused", state: "refused" }),
    cancel: async () => {},
  }, { root: dir, sessionId: "fixture-session", runtimeId: "fixture-runtime", pid: process.pid, starttime: processStarttime(process.pid)!, cwd: dir });
  try {
    await once(parent, "listening");
    cpSync(join(source, "src"), join(dir, "src"), { recursive: true });
    const out = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--no-warnings", join(dir, "src", "spawn.ts"), "YM-1", "YM-2", "--plan", "/explicit.md", "--model", "test/model"], {
      cwd: dir, env: { PATH: process.env.PATH, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, PI_SESSION_ID: "fixture-session" },
    });
    assert.deepEqual(out.stdout.trim().split("\n"), ["refused YM-1: already running", "YM-2 → background run fixture-run-2"]);
    assert.deepEqual(requests, [
      { mode: "do", tickets: ["YM-1"], plan: "/explicit.md", model: "test/model" },
      { mode: "do", tickets: ["YM-2"], plan: "/explicit.md", model: "test/model" },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => parent.close((error) => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});


test("ship preparation keeps the ordered batch", async () => {
  const dir = root();
  const previousPath = process.env.PATH;
  try {
    const shim = join(dir, "shim");
    mkdirSync(shim);
    writeFileSync(join(shim, "gh"), '#!/bin/sh\nprintf "main\\thttps://github.com/org/repo/pull/%s\\n" "${3#YM-}"\n', { mode: 0o755 });
    for (const ticket of ["YM-1", "YM-2"]) {
      const folder = join(dir, "home", "knowledge", "org", "repo", "ai", `${ticket}-work`);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, `${ticket}-work-plan.md`), `# ${ticket}\n\n## Affected repositories\n- \`org/repo\` — app\n`);
      const worktree = join(dir, "work", ticket, "repo");
      mkdirSync(worktree, { recursive: true });
      execFileSync("git", ["init", "-b", ticket, worktree], { stdio: "pipe" });
      execFileSync("git", ["-C", worktree, "remote", "add", "origin", "https://github.com/org/repo.git"]);
    }
    process.env.PATH = `${shim}:${previousPath ?? ""}`;
    const prepared = await prepareShip(dir, { mode: "ship", tickets: ["YM-2", "YM-1"] });
    assert.deepEqual(prepared.tickets, ["YM-2", "YM-1"]);
    assert.deepEqual(Object.keys(prepared.plans), ["YM-2", "YM-1"]);
    assert.deepEqual(prepared.parts.map((part) => part.branch), ["YM-2", "YM-1"]);
    assert.deepEqual(prepared.parts.map((part) => part.pr), ["https://github.com/org/repo/pull/2", "https://github.com/org/repo/pull/1"]);
    assert.match(prepared.prompt, /^\/skill:ship-worker YM-2\+YM-1\./);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
