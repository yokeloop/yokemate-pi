import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ToolHook = (event: { type: "tool_call"; toolCallId: string; toolName: string; input: Record<string, unknown> }, ctx: ExtensionContext) => Promise<{ block: boolean; reason: string } | undefined>;

function fixture() {
  const root = mkdtempSync(join(import.meta.dirname, "fixtures", "settings-contract-"));
  cpSync(join(import.meta.dirname, "../src"), join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  mkdirSync(join(root, ".pi"));
  const set = (settings: unknown) => writeFileSync(join(root, ".pi/settings.json"), JSON.stringify(settings));
  set({});
  return { root, set, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("guard registration rereads settings between calls without a Pi runtime", async () => {
  const f = fixture();
  const keys = ["YOKEMATE_MODE", "YOKEMATE_TICKET", "YOKEMATE_RESEARCH_ID"] as const;
  const previous = keys.map((key) => [key, process.env[key]] as const);
  try {
    process.env.YOKEMATE_MODE = "do";
    process.env.YOKEMATE_TICKET = "YM-1";
    delete process.env.YOKEMATE_RESEARCH_ID;
    const { default: guards } = await import(pathToFileURL(join(f.root, "src/guards.ts")).href);
    const handlers = new Map<string, ToolHook>();
    // Only collect callbacks. Never invoke startup/shutdown or create a session.
    guards({ on: (name: string, callback: ToolHook) => handlers.set(name, callback) } as unknown as ExtensionAPI);
    const hook = handlers.get("tool_call");
    assert.ok(hook);
    const ctx = { cwd: f.root, hasUI: false } as ExtensionContext;
    const event = { type: "tool_call" as const, toolCallId: "contract", toolName: "bash", input: { command: "sleep 1" } };
    assert.equal((await hook(event, ctx))?.block, true);
    f.set({ guardPolicy: { guards: { wait: false } } });
    assert.equal(await hook(event, ctx), undefined);
    assert.equal((await hook({ ...event, input: { command: "pnpm dev" } }, ctx))?.block, true);
  } finally {
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    f.cleanup();
  }
});

test("Bash CLI refuses malformed settings before any effect", () => {
  const f = fixture();
  try {
    f.set({ subagent: { maxDetached: "8" } });
    const marker = join(f.root, "must-not-exist");
    const out = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(f.root, "src/bash-guard.ts")], {
      cwd: f.root, env: { HOME: f.root, YOKEMATE_MODE: "do" }, encoding: "utf8", timeout: 10000,
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: `touch '${marker}'` } }),
    });
    assert.equal(out.error, undefined);
    assert.equal(out.status, 0, out.stderr);
    const verdict = JSON.parse(out.stdout).hookSpecificOutput;
    assert.equal(verdict.permissionDecision, "deny");
    assert.match(verdict.permissionDecisionReason, /subagent.maxDetached/);
    assert.equal(existsSync(marker), false);
  } finally { f.cleanup(); }
});

test("Bash CLI refuses a package operation outside the assigned worktree under YOLO", () => {
  const f = fixture();
  try {
    const task = join(f.root, "work/YM-1");
    const part = join(task, "repo");
    mkdirSync(part, { recursive: true });
    writeFileSync(join(part, "package.json"), '{"name":"part","scripts":{"test":"never-executed"}}');
    f.set({ guardPolicy: { yolo: true } });
    const out = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(f.root, "src/bash-guard.ts")], {
      cwd: task, env: { HOME: f.root, YOKEMATE_MODE: "do", YOKEMATE_TICKET: "YM-1", YOKEMATE_PROJECT: '["org/repo"]' },
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm test", cwd: part } }),
      encoding: "utf8", timeout: 10000,
    });
    assert.equal(out.error, undefined);
    assert.equal(out.status, 0, out.stderr);
    const verdict = JSON.parse(out.stdout).hookSpecificOutput;
    assert.equal(verdict.permissionDecision, "deny");
    assert.match(verdict.permissionDecisionReason, /workflow.assigned-scope/);
    assert.ok(verdict.permissionDecisionReason.includes(part));
  } finally { f.cleanup(); }
});
