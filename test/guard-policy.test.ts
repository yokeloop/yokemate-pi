import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_SUBAGENT_LIMITS,
  GUARD_IDS,
  RuntimeSettingsError,
  formatGuardPolicy,
  readRuntimeSettings,
  resolveRuntimeSettings,
  resolveGuardPolicy,
  subagentAdmission,
  subagentConcurrency,
} from "../src/guard-policy.ts";

function root(settings?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "ym-197-"));
  mkdirSync(join(dir, ".pi"));
  if (settings !== undefined) writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify(settings));
  return dir;
}

test("guard policy retains every legacy default and YOLO switches every guard", () => {
  const legacy = readRuntimeSettings(root()).policy;
  assert.equal(legacy.yolo, false);
  assert.equal(Object.keys(legacy.guards).length, GUARD_IDS.length);
  for (const id of GUARD_IDS) assert.equal(legacy.guards[id], true, id);
  const yolo = resolveGuardPolicy({ yolo: true });
  for (const id of GUARD_IDS) assert.equal(yolo.guards[id], false, id);
  assert.equal(yolo.workflowApproval, false);
  assert.equal(resolveGuardPolicy({ yolo: true, guards: { wait: true }, workflowApproval: true }).guards.wait, true);
});

test("policy validates only its own block and rereads settings", () => {
  const dir = root({ guardPolicy: { yolo: false, guards: { wait: false } }, extensions: ["x"] });
  assert.equal(readRuntimeSettings(dir).policy.guards.wait, false);
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ guardPolicy: { yolo: true, guards: { wait: true } } }));
  assert.equal(readRuntimeSettings(dir).policy.guards.wait, true);
  for (const value of ["false", null, [], 1])
    assert.throws(() => resolveGuardPolicy({ guards: { wait: value } }), RuntimeSettingsError);
  assert.throws(() => resolveGuardPolicy({ nope: true }), /guardPolicy.nope/);
  assert.throws(() => resolveGuardPolicy({ guards: { nope: true } }), /guardPolicy.guards.nope/);
  assert.match(formatGuardPolicy(readRuntimeSettings(dir)), /Immutable boundaries/);
});

test("subagent limits share defaults, validation, and independent caps", () => {
  assert.deepEqual(readRuntimeSettings(root()).limits, DEFAULT_SUBAGENT_LIMITS);
  assert.equal(resolveRuntimeSettings({ subagent: { maxParallelTasks: 9 } }).limits.maxDetached, 9);
  assert.throws(() => resolveRuntimeSettings({ subagent: { maxConcurrency: 9 } }), /subagent.maxConcurrency/);
  const settings = resolveRuntimeSettings({ guardPolicy: { yolo: true, guards: { parallelTaskLimit: true } } });
  assert.match(subagentAdmission(settings, "parallel", 9, 0) ?? "", /Too many parallel/);
  assert.equal(subagentAdmission(resolveRuntimeSettings({ guardPolicy: { yolo: true } }), "parallel", 9, 99), null);
  assert.equal(subagentConcurrency(resolveRuntimeSettings({ guardPolicy: { yolo: true } }), 9), 9);
});
