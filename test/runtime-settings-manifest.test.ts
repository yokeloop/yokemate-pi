import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { RUNTIME_SETTING_KEYS, RUNTIME_SETTINGS_MATRIX, RUNTIME_SETTING_SURFACES, type RuntimeSettingKey, type RuntimeSettingSurface } from "../src/guard-policy.ts";

type Evidence = { file: string; name: string; keys: readonly RuntimeSettingKey[]; surfaces: readonly RuntimeSettingSurface[] };
const all = RUNTIME_SETTING_SURFACES;
const nonTyped = ["tool", "cli", "pane", "ordinary", "coordinator"] as const;
const typedContext = "typed runtime context renders every applicable setting on off and neighbor";
const publicGuards = "public file and Bash guards disable only their named refusal";
const publicCli = "public CLI decisions reread settings and refuse malformed blocks before repair";
const publicEvents = "loaded completion and report hooks reread only their named settings";
const publicOrdinary = "ordinary public dispatch pins its snapshot and independently enforces all caps and opt-in confirmation";
const liveDo = "live do coordinator keeps single-use approval duplicate policy and detached admission independent";
const liveShip = "live ship coordinator keeps permit identity duplicate policy and detached admission independent";
const publicCoordinator = "coordinator public admission rereads ship confirmation and never manufactures a permit";
const workflow = "raw interactive authority flows through real plan CLI and parent control without a second do confirm";
const duplicatePane = "generic duplicate guards and ticketless name series are surface independent";
const entry = "runtime-settings-entrypoints.test.ts";
const typedKeys = RUNTIME_SETTING_KEYS.filter((key) => key !== "guardPolicy.workflowApproval" && RUNTIME_SETTINGS_MATRIX[key].typed !== "not-applicable");
const evidence: Evidence[] = [
  { file: entry, name: typedContext, keys: typedKeys, surfaces: ["typed"] },
  { file: entry, name: publicGuards, keys: ["guardPolicy.yolo"], surfaces: nonTyped },
  { file: "workflow-approval-runtime.test.ts", name: workflow, keys: ["guardPolicy.workflowApproval"], surfaces: all },
  { file: entry, name: publicGuards, keys: ["guards.settingsWrite", "guards.wait", "guards.codingLaunch", "guards.massKill", "guards.homeDelete"], surfaces: ["tool", "cli", "pane", "ordinary", "coordinator"] },
  { file: entry, name: publicGuards, keys: ["guards.noteFileWrite", "guards.noteShellWrite"], surfaces: ["tool", "cli", "pane", "ordinary"] },
  { file: entry, name: publicCoordinator, keys: ["guards.shipConfirmation"], surfaces: ["tool", "pane", "ordinary", "coordinator"] },
  { file: entry, name: liveShip, keys: ["guards.shipConfirmation"], surfaces: ["cli"] },
  { file: entry, name: publicEvents, keys: ["guards.doCompletion"], surfaces: ["tool", "cli", "pane", "ordinary", "coordinator"] },
  { file: entry, name: publicCli, keys: ["guards.modeOwnership", "guards.transitionCaller", "guards.transitionTicket", "guards.transitionSource"], surfaces: ["cli", "pane", "ordinary", "coordinator"] },
  { file: entry, name: publicCoordinator, keys: ["guards.spawnCaller"], surfaces: nonTyped },
  { file: entry, name: publicCli, keys: ["guards.stageCaller", "guards.stageForce"], surfaces: ["cli", "pane", "ordinary", "coordinator"] },
  { file: entry, name: liveDo, keys: ["guards.duplicateDo"], surfaces: nonTyped },
  { file: "mode-tab.test.ts", name: duplicatePane, keys: ["guards.duplicateMode"], surfaces: ["cli", "pane"] },
  { file: entry, name: liveShip, keys: ["guards.duplicateMode"], surfaces: ["tool", "coordinator"] },
  { file: entry, name: publicEvents, keys: ["guards.reportTarget"], surfaces: ["tool", "pane", "ordinary", "coordinator"] },
  { file: entry, name: publicOrdinary, keys: ["guards.projectAgentConfirmation"], surfaces: ["tool", "pane", "ordinary", "coordinator"] },
  { file: entry, name: publicOrdinary, keys: ["guards.parallelTaskLimit", "guards.parallelConcurrencyLimit", "subagent.maxParallelTasks", "subagent.maxConcurrency"], surfaces: ["tool", "pane", "ordinary", "coordinator"] },
  { file: entry, name: publicOrdinary, keys: ["guards.detachedLimit", "subagent.maxDetached"], surfaces: ["tool", "pane", "ordinary"] },
  { file: entry, name: liveDo, keys: ["guards.detachedLimit", "subagent.maxDetached"], surfaces: ["cli", "coordinator"] },
];

test("public regression manifest executes every named runtime setting adapter", { timeout: 60000 }, () => {
  const files = [...new Set(evidence.map((item) => item.file))];
  const passed = new Set<string>();
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const file of files) {
    const names = evidence.filter((item) => item.file === file).map((item) => item.name);
    const pattern = `^(?:${[...new Set(names)].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`;
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--test", `--test-name-pattern=${pattern}`, new URL(file, import.meta.url).pathname], { encoding: "utf8", timeout: 55000, env });
    assert.equal(result.status, 0, `${file}\n${result.stdout}\n${result.stderr}`);
    for (const name of names) {
      const line = result.stdout.split("\n").find((value) => value.includes(` - ${name}`) && /^ok\s/.test(value));
      assert.ok(line && !line.includes("# SKIP"), `${file}: ${name} did not execute\n${result.stdout}`);
      passed.add(`${file}\0${name}`);
    }
  }
  const cells = new Map<string, string>();
  for (const item of evidence) {
    assert.ok(passed.has(`${item.file}\0${item.name}`));
    for (const key of item.keys) for (const surface of item.surfaces) {
      const cell = RUNTIME_SETTINGS_MATRIX[key][surface];
      assert.notEqual(cell, "not-applicable", `${key}/${surface}: evidence claims a not-applicable cell`);
      const id = `${surface}:${key}`;
      assert.equal(cells.has(id), false, `${id}: duplicate executable evidence`);
      cells.set(id, item.name);
      if (cell !== "not-applicable") assert.equal(cell.regression, id);
    }
  }
  assert.deepEqual([...new Set(evidence.flatMap((item) => item.keys))].sort(), [...RUNTIME_SETTING_KEYS].sort());
  for (const key of RUNTIME_SETTING_KEYS) for (const surface of RUNTIME_SETTING_SURFACES) {
    const cell = RUNTIME_SETTINGS_MATRIX[key][surface];
    if (cell !== "not-applicable") assert.ok(cells.has(cell.regression), `${cell.regression}: no passed public adapter`);
  }
});
