import { test } from "node:test";
import assert from "node:assert/strict";
import { closeModeSurface, openModeSurface, parseSurfaceArgs } from "../src/mode-surface.ts";
import { resolveLaunch, resolvePlanTargets } from "../src/mode-tab.ts";

test("surface controls stop at the first separator and protect mode option values", () => {
  assert.deepEqual(parseSurfaceArgs(["YM-1"]), { surface: "tab", model: undefined, words: ["YM-1"], literal: [] });
  assert.deepEqual(parseSurfaceArgs(["a", "--split", "--model", "explicit", "b", "--", "--split", "--model", "literal", "--"]), {
    surface: "split", model: "explicit", words: ["a", "b"], literal: ["--split", "--model", "literal", "--"],
  });
  assert.deepEqual(parseSurfaceArgs(["--", "--split"]), { surface: "tab", model: undefined, words: [], literal: ["--split"] });
  assert.throws(() => parseSurfaceArgs(["--model"]), /--model needs a value/);
  assert.deepEqual(parseSurfaceArgs(["--project", "--split", "--unknown"], ["--project"]), {
    surface: "tab", model: undefined, words: ["--project", "--split", "--unknown"], literal: [],
  });
  assert.deepEqual(parseSurfaceArgs(["--project", "--model"], ["--project"]).words, ["--project", "--model"]);
  assert.deepEqual(parseSurfaceArgs(["--tab"]).words, ["--tab"]);
});

test("argument matrix resolves ordered key identities and literal worker words without launching", () => {
  const cases = [
    { args: ["YM-1", "YM-2", "--", "--split", "--model", "literal"], tickets: ["YM-1", "YM-2"], words: [["YM-1", "--split", "--model", "literal"], ["YM-2", "--split", "--model", "literal"]] },
    { args: ["--split", "--model", "explicit", "YM-1", "fix", "YM-2", "--", "YM-99"], tickets: ["YM-1"], words: [["YM-1", "fix", "YM-2", "YM-99"]] },
    { args: ["fix", "problem", "--", "YM-1"], tickets: [""], words: [["fix", "problem", "YM-1"]] },
    { args: ["--", "YM-1", "--model", "literal"], tickets: [""], words: [["YM-1", "--model", "literal"]] },
  ];
  for (const row of cases) {
    const parsed = parseSurfaceArgs(row.args);
    const targets = resolvePlanTargets(parsed);
    assert.deepEqual(targets.map((target) => target.ticket), row.tickets);
    assert.deepEqual(targets.map((target) => target.workerWords), row.words);
    for (const target of targets) {
      const launch = resolveLaunch("/root", "plan", target.ticket, "", parsed.model, "parent", undefined, parsed.surface, target.workerWords);
      assert.equal(launch.prompt, `/skill:plan ${target.workerWords.join(" ")}`);
      assert.equal(launch.model, parsed.model);
      assert.equal(launch.surface, parsed.surface);
      assert.equal(launch.env.some((word) => word.startsWith("YOKEMATE_TICKET=")), Boolean(target.ticket));
    }
  }
});

test("open surface forwards only explicit Pi isolation, not stale session/run or unrelated secrets", (t) => {
  const injected = { PI_CODING_AGENT_DIR: "/isolated agent", PI_CODING_AGENT_SESSION_DIR: "/isolated sessions", PI_SESSION_ID: "stale", YOKEMATE_RUN_ID: "stale", UNRELATED_SECRET: "sentinel" };
  const previous = Object.keys(injected).map((key) => [key, process.env[key]] as const);
  t.after(() => { for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  Object.assign(process.env, injected);
  const calls: string[][] = [];
  openModeSurface("tab", "parent", "workspace", "/root", "label", ["YOKEMATE_RUN_ID=fresh"], (args) => {
    calls.push(args);
    return { result: { tab: { tab_id: "tab" }, root_pane: { pane_id: "pane" } } };
  });
  assert.deepEqual(calls[0]!.slice(8), ["--env", "YOKEMATE_RUN_ID=fresh", "--env", "PI_CODING_AGENT_DIR=/isolated agent", "--env", "PI_CODING_AGENT_SESSION_DIR=/isolated sessions"]);
});

test("awaited close targets only the stored exact surface ID", async () => {
  const calls: string[][] = [];
  const tab = await closeModeSurface({ surface: "tab", paneId: "pane", tabId: "tab", cleanup() {} }, async (args) => { calls.push(args); return { result: {} }; });
  const split = await closeModeSurface({ surface: "split", paneId: "split", cleanup() {} }, async (args) => { calls.push(args); return { result: {} }; });
  assert.deepEqual(tab, { state: "closed" });
  assert.deepEqual(split, { state: "closed" });
  assert.deepEqual(calls, [["tab", "close", "tab"], ["pane", "close", "split"]]);
});

test("awaited close reports missing IDs, command errors and timeout", async () => {
  assert.match((await closeModeSurface({ surface: "tab", paneId: "pane", cleanup() {} }, async () => ({ result: {} }))).reason ?? "", /tab id/);
  assert.match((await closeModeSurface({ surface: "split", paneId: "", cleanup() {} }, async () => ({ result: {} }))).reason ?? "", /pane id/);
  assert.match((await closeModeSurface({ surface: "split", paneId: "pane", cleanup() {} }, async () => { throw new Error("disappeared"); })).reason ?? "", /disappeared/);
  assert.match((await closeModeSurface({ surface: "split", paneId: "pane", cleanup() {} }, async () => new Promise(() => {}), 5)).reason ?? "", /timed out/);
});

for (const surface of ["tab", "split"] as const) {
  test(`${surface} opens and cleans up only returned IDs without configured Pi isolation`, (t) => {
    const previous = new Map(["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"].map((key) => [key, process.env[key]]));
    t.after(() => {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });
    for (const key of previous.keys()) delete process.env[key];
    const calls: string[][] = [];
    const opened = openModeSurface(surface, "w1:p-parent", "w1", "/root", "label", ["A=b"], (args) => {
      calls.push(args);
      return { result: { tab: { tab_id: "w1:t-new" }, root_pane: { pane_id: "w1:p-tab" }, pane: { pane_id: "w1:p-split" } } };
    });
    assert.equal(opened.paneId, surface === "tab" ? "w1:p-tab" : "w1:p-split");
    assert.equal(opened.tabId, surface === "tab" ? "w1:t-new" : undefined);
    assert.deepEqual(calls, [surface === "tab"
      ? ["tab", "create", "--workspace", "w1", "--cwd", "/root", "--label", "label", "--env", "A=b"]
      : ["pane", "split", "w1:p-parent", "--direction", "down", "--cwd", "/root", "--env", "A=b"]]);
    opened.cleanup();
    assert.deepEqual(calls[1], surface === "tab" ? ["tab", "close", "w1:t-new"] : ["pane", "close", "w1:p-split"]);
  });
}
