import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { RUNTIME_SETTING_KEYS, RUNTIME_SETTINGS_MATRIX, RUNTIME_SETTING_SURFACES } from "../src/guard-policy.ts";

type Adapter = { file: string; name: string };
const entry = "runtime-settings-entrypoints.test.ts";
const adapters: Adapter[] = [
  { file: entry, name: "typed runtime context renders every applicable setting on off and neighbor" },
  { file: entry, name: "public file and Bash guards disable only their named refusal" },
  { file: entry, name: "public CLI decisions reread settings and refuse malformed blocks before repair" },
  { file: entry, name: "loaded completion and report hooks reread only their named settings" },
  { file: entry, name: "ordinary public dispatch pins its snapshot and independently enforces all caps and opt-in confirmation" },
  { file: entry, name: "live do coordinator keeps single-use approval duplicate policy and detached admission independent" },
  { file: entry, name: "live ship coordinator keeps permit identity duplicate policy and detached admission independent" },
  { file: entry, name: "coordinator public admission rereads ship confirmation and never manufactures a permit" },
  { file: "workflow-approval-runtime.test.ts", name: "raw interactive authority flows through real plan CLI and parent control without a second do confirm" },
  { file: "mode-tab.test.ts", name: "generic duplicate guards and ticketless name series are surface independent" },
];

test("public regression manifest consumes exact passed case IDs for every runtime setting cell", { timeout: 120000 }, () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const passed = new Set<string>();
  for (const file of [...new Set(adapters.map((adapter) => adapter.file))]) {
    const names = adapters.filter((adapter) => adapter.file === file).map((adapter) => adapter.name);
    const pattern = `^(?:${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`;
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--test", `--test-name-pattern=${pattern}`, new URL(file, import.meta.url).pathname], { encoding: "utf8", timeout: 110000, env });
    assert.equal(result.status, 0, `${file}\n${result.stdout}\n${result.stderr}`);
    for (const name of names) {
      const line = result.stdout.split("\n").find((value) => value.includes(` - ${name}`) && /^ok\s/.test(value));
      assert.ok(line && !line.includes("# SKIP"), `${file}: ${name} did not execute\n${result.stdout}`);
    }
    for (const match of result.stdout.matchAll(/RUNTIME_CASE\s+(\S+)/g)) passed.add(match[1]!);
  }
  for (const key of RUNTIME_SETTING_KEYS) for (const surface of RUNTIME_SETTING_SURFACES) {
    const cell = RUNTIME_SETTINGS_MATRIX[key][surface];
    if (cell === "not-applicable") continue;
    for (const variant of ["on", "off", "neighbor"]) assert.ok(passed.has(`${cell.regression}:${variant}`), `${cell.regression}:${variant}: no passed public adapter case`);
  }
});
