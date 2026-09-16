import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = resolve(import.meta.dirname, "..");
const entry = join(root, "src", "research.ts");

test("the real research entry loads without action APIs before runtime binding", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "research-startup-agent-"));
  try {
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.create(root, agentDir),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [entry],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    const extension = loaded.extensions.find((item) => resolve(item.resolvedPath) === entry);
    assert.ok(extension, "the task research entry must be loaded");
    assert.ok(extension.handlers.has("session_start"));
    assert.ok(extension.handlers.has("tool_call"));
    assert.ok(extension.tools.has("send_message"));
    assert.ok(extension.tools.has("subagent"));
    const userBash = extension.handlers.get("user_bash")?.[0];
    assert.ok(userBash);
    const invokeUserBash = userBash as never as (event: { command: string; cwd: string }) => Promise<{ result: { output: string; exitCode: number } }>;
    const closedBash = await invokeUserBash({ command: "pnpm where research", cwd: root });
    assert.deepEqual(closedBash.result, { output: "research tools are not ready", exitCode: 1, cancelled: false, truncated: false });

    const previous = { ...process.env };
    process.env.YOKEMATE_MODE = "research";
    process.env.YOKEMATE_RESEARCH_ID = "test-research";
    process.env.YOKEMATE_RESEARCH_ROOT = root;
    delete process.env.YOKEMATE_RESEARCH_PROJECT;
    delete process.env.YOKEMATE_RESEARCH_PROJECT_PATH;
    const errors: string[] = [];
    try {
      const { session } = await createAgentSession({
        cwd: root,
        agentDir,
        settingsManager: SettingsManager.create(root, agentDir),
        sessionManager: SessionManager.inMemory(root),
        resourceLoader: loader,
        noTools: "builtin",
      });
      await session.bindExtensions({ uiContext: { notify: () => undefined, setStatus: () => undefined } as never, onError: (error) => errors.push(error.error) });
      assert.deepEqual(errors, []);
      for (const name of ["read", "grep", "find", "ls", "write", "edit", "bash", "subagent", "send_message"])
        assert.ok(session.getActiveToolNames().includes(name), `${name} was not active`);
      for (const name of ["bash", "edit", "write"]) {
        const tool = session.getAllTools().find((item) => item.name === name);
        assert.ok(tool);
        assert.equal(resolve(tool.sourceInfo.path), entry);
        assert.notEqual(tool.sourceInfo.source, "builtin");
      }
      const wrongCwd = await invokeUserBash({ command: "pnpm where research", cwd: "/tmp" });
      assert.deepEqual(wrongCwd.result, { output: "research tools are not ready", exitCode: 1, cancelled: false, truncated: false });
      const bash = session.getToolDefinition("bash");
      assert.ok(bash);
      const result = await bash.execute("research-bash", { command: "pnpm where research" }, undefined, () => undefined, {} as never);
      assert.deepEqual(result.content, [{ type: "text", text: "run\n" }]);
      await assert.rejects(() => bash.execute("research-bash", { command: "echo nope > changed" }, undefined, () => undefined, {} as never), /simple literal argv/);
      session.dispose();
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    }
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});


test("active research read tools use the selected clone despite the session cwd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-relative-"));
  const engine = join(dir, "engine");
  const clone = join(dir, "clone");
  const agentDir = join(dir, "agent");
  const previous = { ...process.env };
  for (const path of [join(engine, "test"), join(engine, "src"), join(clone, "test"), agentDir]) mkdirSync(path, { recursive: true });
  writeFileSync(join(clone, "test", "fixture.txt"), "research-marker CLONE_FIXTURE");
  writeFileSync(join(engine, "test", "fixture.txt"), "research-marker ENGINE_SENTINEL");
  writeFileSync(join(engine, "src", "fixture.txt"), "ENGINE_SOURCE");
  writeFileSync(join(clone, ".env"), "PRIVATE_CONTENT");
  Object.assign(process.env, { YOKEMATE_MODE: "research", YOKEMATE_RESEARCH_ID: "relative-reads", YOKEMATE_RESEARCH_ROOT: engine, YOKEMATE_RESEARCH_PROJECT: "acme/app", YOKEMATE_RESEARCH_PROJECT_PATH: clone });
  delete process.env.HERDR_PANE_ID;
  try {
    const settingsManager = SettingsManager.create(engine, agentDir);
    const loader = new DefaultResourceLoader({ cwd: engine, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [entry] });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const extension = loader.getExtensions().extensions.find((item) => resolve(item.resolvedPath) === entry);
    assert.ok(extension);
    const gates = extension.handlers.get("tool_call")!;
    const check = async (toolName: string, input: Record<string, unknown>) => {
      for (const gate of gates) {
        const result = await gate({ type: "tool_call", toolCallId: "relative", toolName, input } as never, { cwd: engine } as never) as { block?: boolean; reason?: string } | undefined;
        if (result?.block) return result;
      }
      return undefined;
    };
    assert.equal((await check("grep", { pattern: "research-marker", path: "test" }))?.block, true);
    const { session } = await createAgentSession({ cwd: engine, agentDir, settingsManager, sessionManager: SessionManager.inMemory(engine), resourceLoader: loader, noTools: "builtin" });
    try {
      const errors: string[] = [];
      await session.bindExtensions({ uiContext: { notify: () => undefined, setStatus: () => undefined } as never, onError: (error) => errors.push(error.error) });
      assert.deepEqual(errors, []);
      for (const name of ["read", "grep", "find", "ls"]) {
        assert.ok(session.getActiveToolNames().includes(name));
        const info = session.getAllTools().find((tool) => tool.name === name)!;
        assert.equal(resolve(info.sourceInfo.path), entry);
        assert.notEqual(info.sourceInfo.source, "builtin");
      }
      const cases: [string, Record<string, unknown>, RegExp][] = [
        ["read", { path: "test/fixture.txt" }, /CLONE_FIXTURE/],
        ["grep", { pattern: "research-marker", path: "test" }, /CLONE_FIXTURE/],
        ["grep", { pattern: "research-marker", path: "." }, /CLONE_FIXTURE/],
        ["grep", { pattern: "research-marker" }, /CLONE_FIXTURE/],
        ["find", { pattern: "*.txt", path: "test" }, /fixture.txt/],
        ["find", { pattern: "*.txt" }, /test\/fixture.txt/],
        ["ls", { path: "test" }, /fixture.txt/],
        ["ls", {}, /test/],
        ["read", { path: join(engine, "src", "fixture.txt") }, /ENGINE_SOURCE/],
      ];
      for (const [name, input, expected] of cases) {
        assert.equal(await check(name, input), undefined, `${name} ${JSON.stringify(input)}`);
        const tool = session.getToolDefinition(name)!;
        const result = await tool.execute("relative", input, undefined, () => undefined, { cwd: engine } as never);
        const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        assert.match(text, expected);
        assert.doesNotMatch(text, /ENGINE_SENTINEL/);
        assert.match(tool.description, /relative paths use the selected clone/);
      }
      for (const name of ["read", "grep", "find", "ls"]) {
        for (const path of [engine, join(clone, ".env"), dir]) {
          const blocked = await check(name, { path });
          assert.equal(blocked?.block, true);
          assert.ok(blocked?.reason?.includes(path));
          assert.ok(blocked?.reason?.includes(`allowed roots: ${clone}`));
          assert.doesNotMatch(blocked?.reason ?? "", /PRIVATE_CONTENT/);
        }
      }
    } finally { session.dispose(); }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(dir, { recursive: true, force: true });
  }
});
