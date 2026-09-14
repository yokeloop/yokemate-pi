import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = resolve(import.meta.dirname, "..");

type Notice = { message: string; level: string | undefined };

async function withResearchSession<T>(cwd: string, entry: string, body: (session: Awaited<ReturnType<typeof createAgentSession>>["session"], notices: Notice[], loadErrors: unknown[], bindErrors: string[]) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "research-mcp-home-"));
  const agentDir = mkdtempSync(join(tmpdir(), "research-mcp-agent-"));
  const previous = { ...process.env };
  process.env.YOKEMATE_MODE = "research";
  process.env.YOKEMATE_RESEARCH_ID = "test-research";
  process.env.YOKEMATE_RESEARCH_ROOT = cwd;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HOME = home;
  delete process.env.YOKEMATE_RESEARCH_PROJECT;
  delete process.env.YOKEMATE_RESEARCH_PROJECT_PATH;
  delete process.env.HERDR_PANE_ID;
  try {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [entry],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    const notices: Notice[] = [];
    const bindErrors: string[] = [];
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
      sessionManager: SessionManager.inMemory(cwd),
      resourceLoader: loader,
      noTools: "builtin",
    });
    try {
      await session.bindExtensions({ uiContext: { notify: (message: string, level?: string) => notices.push({ message, level }), setStatus: () => undefined } as never, onError: (error) => bindErrors.push(error.error) });
      return await body(session, notices, loaded.errors, bindErrors);
    } finally {
      session.dispose();
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(home, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
}

test("the real Pi loader registers mcp and mcpScript from the research entry", async () => {
  const entry = join(root, "src", "research.ts");
  await withResearchSession(root, entry, async (session, notices, loadErrors, bindErrors) => {
    assert.deepEqual(loadErrors, []);
    assert.deepEqual(bindErrors, []);
    for (const name of ["mcp", "mcpScript"]) {
      assert.ok(session.getActiveToolNames().includes(name), `${name} was not active`);
      const tool = session.getAllTools().find((item) => item.name === name);
      assert.ok(tool);
      assert.equal(resolve(tool.sourceInfo.path), entry);
    }
    assert.equal(notices.some((notice) => notice.level === "error" && notice.message.includes("research MCP did not load")), false);
  });
});

test("a research MCP load failure is announced and leaves the mode running", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "research-mcp-missing-"));
  try {
    cpSync(join(root, "src"), join(fixture, "src"), { recursive: true });
    cpSync(join(root, ".pi", "extensions", "subagent"), join(fixture, ".pi", "extensions", "subagent"), { recursive: true });
    mkdirSync(join(fixture, "node_modules"));
    for (const name of readdirSync(join(root, "node_modules")))
      if (name !== "pi-mcp-adapter") symlinkSync(join(root, "node_modules", name), join(fixture, "node_modules", name));
    const entry = join(fixture, "src", "research.ts");
    await withResearchSession(fixture, entry, async (session, notices, loadErrors, bindErrors) => {
      assert.deepEqual(loadErrors, []);
      assert.deepEqual(bindErrors, []);
      const failures = notices.filter((notice) => notice.level === "error");
      assert.equal(failures.length, 1);
      assert.match(failures[0]!.message, /^research MCP did not load: /);
      const active = session.getActiveToolNames();
      assert.equal(active.includes("mcp"), false);
      assert.equal(active.includes("mcpScript"), false);
      for (const name of ["read", "bash", "subagent"]) assert.ok(active.includes(name), `${name} was not active`);
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the patched adapter keeps constructor semantics and the socket data path under the real loader", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adapter-compat-"));
  const socketPath = join(dir, "mcp.sock");
  const server = createServer((socket) => socket.write('{"jsonrpc":"2.0","id":1,"result":{}}\n'));
  await new Promise<void>((done) => server.listen(socketPath, done));
  try {
    const entry = join(root, "test", "fixtures", "adapter-compat-extension.ts");
    await withResearchSession(root, entry, async (session, _notices, loadErrors, bindErrors) => {
      assert.deepEqual(loadErrors, []);
      assert.deepEqual(bindErrors, []);
      const probe = session.getToolDefinition("adapter_compat");
      assert.ok(probe);
      const result = await probe.execute("adapter-compat", { socketPath }, undefined, () => undefined, {} as never);
      const first = result.content[0];
      assert.ok(first && first.type === "text");
      const facts = JSON.parse(first.text) as { defaultPrompt: boolean; neverPrompt: boolean; serverName: string; name: string; message: string; isError: boolean; socketMessage: { id?: number } };
      assert.equal(facts.defaultPrompt, true);
      assert.equal(facts.neverPrompt, false);
      assert.equal(facts.serverName, "srv");
      assert.equal(facts.name, "SessionRecoveryAuthRequiredError");
      assert.match(facts.message, /srv/);
      assert.equal(facts.isError, true);
      assert.equal(facts.socketMessage.id, 1);
    });
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  }
});
