import assert from "node:assert/strict";
import { test } from "node:test";
import { formatElapsed, taskExcerpt, TASK_EXCERPT_BUDGET, widgetParts } from "../src/subagent-widget.ts";

test("running widget lines carry name, elapsed and excerpt", () => {
  assert.deepEqual(widgetParts([
    { name: "task-reviewer", task: taskExcerpt("  review\n the full diff and acceptance criteria"), startedAt: 0 },
    { name: "plan-scout", task: "inspect", startedAt: 60_000 },
    { name: "ship YM-1", task: "", startedAt: 65_000 },
  ], 65_000), ["task-reviewer 1:05 review the full diff and", "plan-scout 0:05 inspect", "ship YM-1 0:00"]);
  assert.deepEqual(widgetParts([], 0), []);
  assert.equal(taskExcerpt("x".repeat(100)).length, TASK_EXCERPT_BUDGET);
  assert.equal(formatElapsed(-1000), "0:00");
});
