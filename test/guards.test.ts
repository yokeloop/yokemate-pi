// Smoke for the one rule the pi extension adds: the translation of a pi tool
// call into the shape judge() reads. The other three guards live on events a
// live model raises, and node --test does not reach that layer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { guardCall } from "../src/guards.ts";

const CWD = "/home/x/yokemate/work/ACME-1";

test("pi tool calls translate into the names judge() knows", () => {
  assert.deepEqual(guardCall("bash", { command: "sleep 300" }, CWD), {
    name: "Bash",
    input: { command: "sleep 300" },
  });
  assert.deepEqual(guardCall("write", { path: "src/index.ts", content: "x" }, CWD), {
    name: "Write",
    input: { file_path: `${CWD}/src/index.ts` },
  });
  assert.deepEqual(guardCall("edit", { path: "/home/x/yokemate/.pi/settings.json", edits: [] }, CWD), {
    name: "Edit",
    input: { file_path: "/home/x/yokemate/.pi/settings.json" },
  });
  assert.deepEqual(guardCall("mcp", { server: "claude-in-chrome", tool: "computer" }, CWD), {
    name: "mcp__claude-in-chrome__computer",
    input: {},
  });
  assert.deepEqual(guardCall("mcp", { tool: "computer" }, CWD), {
    name: "mcp____computer",
    input: {},
  });
});

test("the tools the guard has no rules for translate to nothing", () => {
  for (const name of ["read", "grep", "ls", "find", "send_message"]) {
    assert.equal(guardCall(name, {}, CWD), null, name);
  }
});
