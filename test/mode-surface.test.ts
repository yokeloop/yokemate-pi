import { test } from "node:test";
import assert from "node:assert/strict";
import { openModeSurface, parseSurfaceArgs } from "../src/mode-surface.ts";

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
