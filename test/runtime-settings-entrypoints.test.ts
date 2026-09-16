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
