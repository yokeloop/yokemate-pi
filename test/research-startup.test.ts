import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
    const closedBash = await (userBash as never as (event: { command: string }) => Promise<{ result: { output: string; exitCode: number } }>)({ command: "pnpm where research" });
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
