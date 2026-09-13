import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DefaultResourceLoader, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const root = resolve(import.meta.dirname, "..");

test("RPC with hasUI sends child widget lines and clears them on completion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "subagent-widget-"));
  const agentDir = join(dir, "agent");
  const script = process.argv[1];
  const cwd = process.cwd();
  let timer: NodeJS.Timeout | undefined;
  try {
    mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
    writeFileSync(join(dir, ".pi", "agents", "task-reviewer.md"), "---\nname: task-reviewer\ndescription: Widget fixture\n---\n");
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir,
      settingsManager: SettingsManager.create(dir, agentDir),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [join(root, ".pi", "extensions", "subagent", "index.ts")],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    loaded.runtime.sendMessage = () => undefined;
    const tool = loaded.extensions.flatMap((extension) => [...extension.tools.values()]).find((tool) => tool.definition.name === "subagent");
    assert.ok(tool);
    const widgets: unknown[] = [];
    let cleared!: () => void;
    const completion = new Promise<void>((resolve) => { cleared = resolve; });
    const ctx = {
      cwd: dir,
      mode: "rpc",
      hasUI: true,
      ui: { setWidget: (key: string, content: unknown) => {
        assert.equal(key, "subagent-running");
        widgets.push(content);
        if (content === undefined && widgets.length > 1) cleared();
      } },
    } as ExtensionContext;
    process.chdir(dir);
    process.argv[1] = join(root, "test", "fixtures", "subagent-widget-child.js");
    const result = await tool.definition.execute("widget-test", { agent: "task-reviewer", task: "review the diff", cwd: dir }, undefined, () => undefined, ctx);
    assert.equal("isError" in result && result.isError, false);
    await Promise.race([completion, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("child widget did not clear")), 5000); })]);
    assert.ok(Array.isArray(widgets[0]), "RPC widget must be string lines, not a component factory");
    assert.match((widgets[0] as string[])[0]!, /^task-reviewer \d+:\d{2} review the diff$/);
    assert.equal(widgets.at(-1), undefined);
  } finally {
    clearTimeout(timer);
    process.argv[1] = script;
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
