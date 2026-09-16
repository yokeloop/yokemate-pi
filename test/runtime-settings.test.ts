import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SUBAGENT_LIMITS, GUARD_IDS, RuntimeSettingsError, readRuntimeSettings, resolveRuntimeSettings } from "../src/guard-policy.ts";

const source = join(tmpdir(), "runtime-settings", ".pi", "settings.json");

test("runtime settings resolve missing blocks, full presets and independent overrides", () => {
  for (const value of [undefined, {}, { extensions: ["pi-owned"], unrelated: 1 }]) {
    const settings = resolveRuntimeSettings(value, source);
    assert.equal(settings.source, source);
    assert.equal(settings.policy.workflowApproval, true);
    assert.equal(settings.policy.yolo, false);
    assert.deepEqual(settings.limits, DEFAULT_SUBAGENT_LIMITS);
    assert.deepEqual(settings.policy.guards, Object.fromEntries(GUARD_IDS.map((id) => [id, true])));
  }
  const yolo = resolveRuntimeSettings({ guardPolicy: { yolo: true } }, source);
  assert.equal(yolo.policy.workflowApproval, false);
  for (const id of GUARD_IDS) {
    assert.equal(yolo.policy.guards[id], false);
    const on = resolveRuntimeSettings({ guardPolicy: { yolo: true, guards: { [id]: true }, workflowApproval: true }, subagent: { maxParallelTasks: 2 } }, source);
    assert.equal(on.policy.guards[id], true);
    assert.equal(on.policy.workflowApproval, true);
    assert.deepEqual(on.limits, { maxParallelTasks: 2, maxConcurrency: 2, maxDetached: 8 });
    const off = resolveRuntimeSettings({ guardPolicy: { guards: { [id]: false }, workflowApproval: false } }, source);
    assert.equal(off.policy.guards[id], false);
    assert.equal(off.policy.workflowApproval, false);
    for (const neighbor of GUARD_IDS.filter((key) => key !== id)) assert.equal(off.policy.guards[neighbor], true);
  }
  assert.deepEqual(resolveRuntimeSettings({ subagent: { maxParallelTasks: 12 } }, source).limits, { maxParallelTasks: 12, maxConcurrency: 4, maxDetached: 12 });
  assert.deepEqual(resolveRuntimeSettings({ subagent: { maxParallelTasks: 5, maxConcurrency: 3, maxDetached: 6 } }, source).limits, { maxParallelTasks: 5, maxConcurrency: 3, maxDetached: 6 });
});

test("runtime settings reject every malformed owned field with absolute source and precise field", () => {
  const cases: [unknown, string][] = [];
  for (const bad of [null, [], "false", 1, true]) {
    cases.push([bad, "settings root"]);
    cases.push([{ guardPolicy: bad }, "guardPolicy"]);
    cases.push([{ guardPolicy: { guards: bad } }, "guardPolicy.guards"]);
    cases.push([{ subagent: bad }, "subagent"]);
  }
  for (const key of ["yolo", "workflowApproval"]) {
    for (const bad of [null, [], {}, 0, "true"]) cases.push([{ guardPolicy: { [key]: bad } }, `guardPolicy.${key}`]);
  }
  for (const id of GUARD_IDS) {
    for (const bad of [null, [], {}, 0, "false"]) cases.push([{ guardPolicy: { guards: { [id]: bad } } }, `guardPolicy.guards.${id}`]);
  }
  for (const key of Object.keys(DEFAULT_SUBAGENT_LIMITS)) {
    for (const bad of [null, [], {}, true, "4", 0, -1, 1.5, Infinity, NaN]) cases.push([{ subagent: { [key]: bad } }, `subagent.${key}`]);
  }
  cases.push([{ guardPolicy: { extra: true } }, "guardPolicy.extra"], [{ guardPolicy: { guards: { extra: true } } }, "guardPolicy.guards.extra"], [{ subagent: { extra: 1 } }, "subagent.extra"]);
  cases.push([{ subagent: { maxConcurrency: 9 } }, "subagent.maxConcurrency"], [{ subagent: { maxDetached: 7 } }, "subagent.maxDetached"]);
  for (const [value, field] of cases) {
    assert.throws(() => resolveRuntimeSettings(value, source), (error) => error instanceof RuntimeSettingsError && isAbsolute(error.path) && error.path === source && error.message.includes(field), JSON.stringify(value));
  }
});

test("runtime settings reread root settings and fail closed on broken or unreadable files", () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-settings-"));
  const file = join(root, ".pi", "settings.json");
  try {
    assert.deepEqual(readRuntimeSettings(root).limits, DEFAULT_SUBAGENT_LIMITS);
    mkdirSync(join(root, ".pi"));
    writeFileSync(file, JSON.stringify({ guardPolicy: { yolo: true }, subagent: { maxParallelTasks: 2 } }));
    const first = readRuntimeSettings(root);
    writeFileSync(file, JSON.stringify({ guardPolicy: { guards: { wait: false } }, subagent: { maxParallelTasks: 9 } }));
    const second = readRuntimeSettings(root);
    assert.equal(first.policy.yolo, true);
    assert.equal(second.policy.yolo, false);
    assert.equal(second.policy.guards.wait, false);
    assert.equal(first.limits.maxParallelTasks, 2);
    assert.equal(second.limits.maxParallelTasks, 9);
    writeFileSync(file, "{");
    assert.throws(() => readRuntimeSettings(root), (error) => error instanceof RuntimeSettingsError && error.message.includes(file));
    rmSync(file);
    mkdirSync(file);
    assert.throws(() => readRuntimeSettings(root), (error) => error instanceof RuntimeSettingsError && error.message.includes(file));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
