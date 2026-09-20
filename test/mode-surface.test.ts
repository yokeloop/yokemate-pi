import { test } from "node:test";
import assert from "node:assert/strict";
import { closeModeSurface, openModeSurface, parseSurfaceArgs } from "../src/mode-surface.ts";

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
  test(`${surface} opens and cleans up only returned IDs`, () => {
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
