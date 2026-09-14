import assert from "node:assert/strict";
import { test } from "node:test";
import { composeWidgetParts, formatElapsed, taskExcerpt, TASK_EXCERPT_BUDGET, widgetParts } from "../src/subagent-widget.ts";

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

test("coordinator children follow their parent and disappear when cleared", () => {
  const coordinator = {};
  const scout = {};
  const running = new Map([[coordinator, "do YM-1 0:05 implement"], [scout, "plan-scout 0:02 inspect"]]);
  const childrenByProcess = new Map<object, string[]>();
  assert.deepEqual(composeWidgetParts(running, childrenByProcess), [...running.values()]);
  childrenByProcess.set(coordinator, ["task-reviewer 0:05 review", "task-executor 0:03 implement"]);
  assert.deepEqual(composeWidgetParts(running, childrenByProcess), [
    "do YM-1 0:05 implement", "↳ task-reviewer 0:05 review", "↳ task-executor 0:03 implement", "plan-scout 0:02 inspect",
  ]);
  childrenByProcess.delete(coordinator);
  assert.deepEqual(composeWidgetParts(running, childrenByProcess), [...running.values()]);
  childrenByProcess.set(coordinator, ["task-reviewer 0:05 review"]);
  running.delete(coordinator);
  assert.deepEqual(composeWidgetParts(running, childrenByProcess), ["plan-scout 0:02 inspect"]);
  assert.deepEqual(composeWidgetParts([], childrenByProcess), []);
});
