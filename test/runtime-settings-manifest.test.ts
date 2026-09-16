import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RUNTIME_SETTING_KEYS, RUNTIME_SETTINGS_MATRIX, RUNTIME_SETTING_SURFACES, type RuntimeSettingKey, type RuntimeSettingSurface } from "../src/guard-policy.ts";

type Scenario = { file: string; name: string; keys: readonly RuntimeSettingKey[]; surfaces: readonly RuntimeSettingSurface[]; variants: readonly ["on", "off", "neighbor"] };
const variants = ["on", "off", "neighbor"] as const;
const all = RUNTIME_SETTING_SURFACES;
const toolFamily = ["tool", "cli", "pane", "ordinary", "coordinator"] as const;
const workflow = "raw interactive authority flows through real plan CLI and parent control without a second do confirm";
const publicGuards = "public file and Bash guards disable only their named refusal";
const publicCli = "public CLI decisions reread settings and refuse malformed blocks before repair";
const publicEvents = "loaded completion and report hooks reread only their named settings";
const publicOrdinary = "ordinary public dispatch pins its snapshot and independently enforces all caps and opt-in confirmation";
const publicCoordinator = "coordinator public admission rereads ship confirmation and never manufactures a permit";
const scenarios: Scenario[] = [
  { file: "runtime-settings-entrypoints.test.ts", name: publicGuards, keys: ["guardPolicy.yolo"], surfaces: all, variants },
  { file: "workflow-approval-runtime.test.ts", name: workflow, keys: ["guardPolicy.workflowApproval"], surfaces: all, variants },
  { file: "runtime-settings-entrypoints.test.ts", name: publicGuards, keys: ["guards.settingsWrite", "guards.wait", "guards.codingLaunch", "guards.massKill", "guards.homeDelete"], surfaces: toolFamily, variants },
  { file: "runtime-settings-entrypoints.test.ts", name: publicGuards, keys: ["guards.noteFileWrite", "guards.noteShellWrite"], surfaces: ["tool", "cli", "pane", "ordinary"], variants },
  { file: "runtime-settings-entrypoints.test.ts", name: publicCoordinator, keys: ["guards.shipConfirmation"], surfaces: all, variants },
  { file: "runtime-settings-entrypoints.test.ts", name: publicEvents, keys: ["guards.doCompletion"], surfaces: ["tool", "cli", "pane", "ordinary", "coordinator"], variants },
  { file: "runtime-settings-entrypoints.test.ts", name: publicCli, keys: ["guards.modeOwnership"], surfaces: ["typed", "cli", "pane", "ordinary", "coordinator"], variants },
  { file: "runtime-settings-entrypoints.test.ts", name: publicCli, keys: ["guards.transitionCaller", "guards.transitionTicket", "guards.transitionSource"], surfaces: ["typed", "cli", "pane", "ordinary", "coordinator"], variants },
  { file: "runtime-settings-entrypoints.test.ts", name: publicCoordinator, keys: ["guards.spawnCaller"], surfaces: all, variants },
  { file: "runtime-settings-entrypoints.test.ts", name: publicCli, keys: ["guards.stageCaller", "guards.stageForce"], surfaces: ["cli", "pane", "ordinary", "coordinator"], variants },
  { file: "coordinator-launch.test.ts", name: "failed coordinator starts release duplicate reservations and capacity before retry", keys: ["guards.duplicateDo"], surfaces: all, variants },
  { file: "mode-tab.test.ts", name: "generic duplicate guards and ticketless name series are surface independent", keys: ["guards.duplicateMode"], surfaces: ["typed", "tool", "cli", "pane", "coordinator"], variants },
  { file: "runtime-settings-entrypoints.test.ts", name: publicEvents, keys: ["guards.reportTarget"], surfaces: ["tool", "pane", "ordinary", "coordinator"], variants },
  { file: "runtime-settings-entrypoints.test.ts", name: publicOrdinary, keys: ["guards.projectAgentConfirmation"], surfaces: ["tool", "pane", "ordinary", "coordinator"], variants },
  { file: "runtime-settings-entrypoints.test.ts", name: publicOrdinary, keys: ["guards.parallelTaskLimit", "guards.parallelConcurrencyLimit", "subagent.maxParallelTasks", "subagent.maxConcurrency"], surfaces: ["typed", "tool", "pane", "ordinary", "coordinator"], variants },
  { file: "coordinator-launch.test.ts", name: "failed coordinator starts release duplicate reservations and capacity before retry", keys: ["guards.detachedLimit", "subagent.maxDetached"], surfaces: all, variants },
];

test("public regression manifest resolves every applicable runtime setting cell to on off and neighbor evidence", () => {
  const names = new Map<string, string>();
  for (const scenario of scenarios) {
    const source = readFileSync(new URL(scenario.file, import.meta.url), "utf8");
    assert.ok(source.includes(`test(\"${scenario.name}\"`), `${scenario.file}: missing executable case ${scenario.name}`);
    assert.deepEqual(scenario.variants, variants);
    for (const key of scenario.keys) {
      assert.equal(names.has(key), false, `${key}: duplicate public scenario`);
      names.set(key, scenario.name);
      for (const surface of scenario.surfaces) {
        const cell = RUNTIME_SETTINGS_MATRIX[key][surface];
        assert.notEqual(cell, "not-applicable", `${key}/${surface}: scenario claims a not-applicable cell`);
        if (cell !== "not-applicable") assert.equal(cell.regression, `${surface}:${key}`);
      }
    }
  }
  assert.deepEqual([...names.keys()].sort(), [...RUNTIME_SETTING_KEYS].sort());
  for (const key of RUNTIME_SETTING_KEYS) {
    const scenario = scenarios.find((candidate) => candidate.keys.includes(key))!;
    for (const surface of RUNTIME_SETTING_SURFACES) {
      const cell = RUNTIME_SETTINGS_MATRIX[key][surface];
      if (cell === "not-applicable") continue;
      assert.ok(scenario.surfaces.includes(surface), `${cell.regression}: no named public adapter case`);
    }
  }
});
