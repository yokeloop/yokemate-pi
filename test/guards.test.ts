// Smoke for the pure rules the pi extension adds: the translation of a pi tool
// call into the shape judge() reads, and the stop guard's decision to push a
// turn or only speak. The events themselves are raised by a live model, and
// node --test does not reach that layer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupScopeVerdict, guardCall, stopDelivery } from "../src/guards.ts";

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
  assert.deepEqual(guardCall("mcp", { server: "youtrack-yokeloop", tool: "get_issue" }, CWD), {
    name: "mcp__youtrack-yokeloop__get_issue",
    input: {},
  });
  assert.deepEqual(guardCall("mcp", { tool: "get_issue" }, CWD), {
    name: "mcp____get_issue",
    input: {},
  });
});

test("the tools the guard has no rules for translate to nothing", () => {
  for (const name of ["read", "grep", "ls", "find", "send_message"]) {
    assert.equal(guardCall(name, {}, CWD), null, name);
  }
});

test("group scope blocks write, refspec, direct merge and MCP bypasses", () => {
  const env = { YOKEMATE_GROUP_ROLE: "member", YOKEMATE_GROUP_SCOPE_PATHS: JSON.stringify([`${CWD}/repo`]), YOKEMATE_GROUP_SCOPE_BRANCHES: JSON.stringify(["ACME-2"]) };
  assert.equal(groupScopeVerdict("write", { path: `${CWD}/repo/src/x.ts` }, CWD, env), null);
  assert.match(groupScopeVerdict("edit", { path: `${CWD}/other/x.ts` }, CWD, env)!, /WorkScope/);
  assert.equal(groupScopeVerdict("bash", { command: `git -C '${CWD}/repo' push -u origin ACME-2` }, CWD, env), null);
  assert.match(groupScopeVerdict("bash", { command: `git -C '${CWD}/repo' push origin HEAD:ACME-1` }, CWD, env)!, /registered source branch/);
  assert.match(groupScopeVerdict("bash", { command: `git -C '${CWD}/repo' push origin --delete ACME-2` }, CWD, env)!, /registered source branch/);
  assert.match(groupScopeVerdict("bash", { command: "gh pr merge 10 --squash" }, CWD, env)!, /trusted merge/);
  assert.match(groupScopeVerdict("bash", { command: "gh api repos/o/r/pulls/10/merge" }, CWD, env)!, /trusted merge/);
  assert.match(groupScopeVerdict("mcp", { server: "github", tool: "merge_pull_request" }, CWD, env)!, /MCP/);
  assert.match(groupScopeVerdict("bash", { command: `tee '${CWD}/repo/x'` }, CWD, env)!, /shell writes/);
  assert.match(groupScopeVerdict("bash", { command: `git -C '${CWD}/repo' merge ACME-2` }, CWD, env)!, /integrate/);
  assert.match(groupScopeVerdict("bash", { command: `git -C '${CWD}/repo' push -u origin ACME-2` }, CWD, { ...env, YOKEMATE_GROUP_ROLE: "parent", YOKEMATE_GROUP_SCOPE_PATHS: "[]", YOKEMATE_GROUP_SCOPE_BRANCHES: "[]" })!, /WorkScope|registered source branch/);
});

test("the stop guard pushes a turn once per verdict, then only speaks", () => {
  const running = "The ticket's stage is still running. …";
  const unrecorded = "The ticket's stage is still unrecorded. …";

  // Первый непустой вердикт — толчок.
  assert.deepEqual(stopDelivery(null, running), { content: running, triggerTurn: true });
  // Тот же вердикт снова — доставка без триггера: рана нет, цикла нет.
  assert.deepEqual(stopDelivery(running, running), { content: running, triggerTurn: false });
  // Вердикт сменился (сменилась стадия) — снова толчок.
  assert.deepEqual(stopDelivery(running, unrecorded), { content: unrecorded, triggerTurn: true });
  // Пустой вердикт — забор молчит, что бы он ни говорил прежде.
  assert.equal(stopDelivery(running, null), null);
  assert.equal(stopDelivery(null, null), null);
});
