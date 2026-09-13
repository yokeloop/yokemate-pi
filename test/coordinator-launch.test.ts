import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { DefaultResourceLoader, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { markDoRunning, prepareDo, validateCoordinatorRequest } from "../src/coordinator-launch.ts";

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
    const tool = loaded.extensions.flatMap((extension) => [...extension.tools.values()]).find((tool) => tool.definition.name === "subagent");
    assert.ok(tool);
    const ctx = { cwd: dir, mode: "rpc", hasUI: true, ui: { setWidget: () => undefined } } as unknown as ExtensionContext;
    for (let attempt = 0; attempt < 10; attempt++) {
      const result: AgentToolResult<unknown> = await tool.definition.execute(`retry-${attempt}`, { coordinator: { mode: "do", tickets: ["YM-1"], plan: join(dir, "missing-plan.md") } }, undefined, () => undefined, ctx);
      assert.equal("isError" in result && result.isError, true);
      const text = result.content[0];
      assert.ok(text?.type === "text");
      assert.match(text.text, /plan not found:/);
      assert.doesNotMatch(text.text, /already runs|model pending|accepted|Too many detached/);
    }
    assert.deepEqual(reports, []);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("coordinator requests reject malformed keys, duplicate batches and multi-ticket do", () => {
  assert.throws(() => validateCoordinatorRequest({ mode: "do", tickets: ["YM-1", "YM-2"] }), /exactly one/);
  assert.throws(() => validateCoordinatorRequest({ mode: "ship", tickets: ["YM-1", "YM-1"] }), /duplicates/);
  assert.throws(() => validateCoordinatorRequest({ mode: "do", tickets: ["../YM-1"] }), /invalid/);
});
