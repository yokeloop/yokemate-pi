// Smoke for the PreToolUse guard (REFACTORING-PLAN A1): waits die everywhere,
// launches die while coding, the engineer's browser and home stay theirs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { judge } from "../src/bash-guard.ts";

const bash = (mode: string | undefined, command: string) => judge(mode, "Bash", { command });

test("waiting is denied in every session", () => {
  for (const cmd of [
    "sleep 300",
    "command sleep 5",
    "for i in $(seq 1 40); do sleep 15; done",
    "for i in $(seq 1 6); do inotifywait -q -e create,modify -r src --timeout 50; done",
    "until [ -f /tmp/.review-done ]; do sleep 20; done",
    "while true; do git status --porcelain; done",
    "tail -f dev.log",
  ]) {
    assert.equal(bash(undefined, cmd)?.decision, "deny", cmd);
    assert.equal(bash("do", cmd)?.decision, "deny", cmd);
    assert.equal(bash("review", cmd)?.decision, "deny", cmd);
  }
});

test("plain finishing commands pass", () => {
  for (const cmd of [
    "git status --porcelain",
    "pnpm build",
    "pnpm typecheck && pnpm lint",
    "just build-control-linux-dir",
    "vite build",
    "kill 4242",
    "rm -rf node_modules/.cache",
  ]) {
    assert.equal(bash("do", cmd), null, cmd);
    assert.equal(bash(undefined, cmd), null, cmd);
  }
});

test("launches are denied while coding, allowed on the review stand", () => {
  for (const cmd of [
    "pnpm dev",
    "npm run start",
    "just dev",
    "electron .",
    "python3 -m http.server 8731",
    "chromium --user-data-dir=/tmp/profile",
    "HOME=/tmp/fake ./app --remote-debugging-port=9222",
  ]) {
    assert.equal(bash("do", cmd)?.decision, "deny", cmd);
    assert.equal(bash("ship", cmd)?.decision, "deny", cmd);
  }
  assert.equal(bash("review", "just dev"), null);
  assert.equal(bash("review", "pnpm dev"), null);
});

test("blanket kills and home writes are denied on tabs and stands", () => {
  assert.equal(bash("do", "pkill -f 'linux-unpacked/demo-app'")?.decision, "deny");
  assert.equal(bash("review", "pkill -9 -f 'electron-vite dev'")?.decision, "deny");
  assert.equal(bash("review", "kill -9 1234")?.decision, "deny");
  assert.equal(bash("review", "rm -rf ~/.config/demo-app/logs")?.decision, "deny");
  assert.equal(bash("review", "rm -rf ~/Downloads/old-build"), null);
  assert.equal(bash(undefined, "rm -rf ~/.config/x"), null); // main chat is the engineer's hands

  const root = "/home/x/yokemate";
  assert.equal(
    judge(
      "do",
      "Bash",
      { command: `rm -rf ${root}/work/ACME-1/tmp` },
      { root, dataRoot: `${root}/home`, home: "/home/x" },
    ),
    null,
  );

  const own = {
    root: "/home/x/Projects/yokemate",
    dataRoot: "/home/x/Projects/yokemate/home",
    home: "/home/x",
  };
  assert.equal(judge("do", "Bash", { command: "rm -rf /home/x/Projects/yokemate/work/YM-116" }, own), null);
  assert.equal(judge("ship", "Bash", { command: "rm -rf ~/Projects/yokemate/work/YM-116" }, own), null);
  assert.equal(judge("do", "Bash", { command: "rm -rf $HOME/Projects/yokemate/work/YM-116/tmp" }, own), null);
  assert.equal(judge("review", "Bash", { command: "rm -rf ~/.config/x" }, own)?.decision, "deny");
  assert.equal(judge("do", "Bash", { command: "rm -rf /home/x/yokemate/work/ACME-1" }, own)?.decision, "deny");
  assert.equal(bash("do", "rm -rf /home/user/yokemate/work/ACME-1/tmp")?.decision, "deny");
});

test("only ship launches ask in the main chat", () => {
  for (const cmd of [
    "pnpm spawn ACME-1",
    "pnpm review ACME-1 обнови ветку",
    "pnpm worklog acme && echo ok",
    "pnpm split plan ACME-3",
    'HERDR_ENV=1 pnpm split plan кнопка не жмётся',
    "HERDR_ENV=1 pnpm spawn ACME-1",
    "node --experimental-strip-types src/mode-tab.ts review ACME-1",
    "node --experimental-strip-types src/spawn.ts ACME-1",
    "pnpm review SHIP-1",
  ]) {
    assert.equal(bash(undefined, cmd), null, cmd);
  }
  for (const cmd of [
    "pnpm ship ACME-1 ACME-2",
    'cd /x && HERDR_ENV="1" pnpm ship ACME-1',
    "pnpm run ship ACME-1",
    "pnpm split ship ACME-1",
    "node --experimental-strip-types src/mode-tab.ts ship ACME-1",
  ]) {
    assert.equal(bash(undefined, cmd)?.decision, "ask", cmd);
  }
  assert.equal(bash("do", "pnpm ship ACME-1"), null);
  assert.equal(bash(undefined, "pnpm test"), null);
  assert.equal(bash(undefined, "pnpm plan ACME-1 knowledge/x/y/ai/z/z-plan.md"), null);
  assert.equal(bash(undefined, "pnpm where do ACME-1"), null);
  assert.equal(bash("do", "pnpm where do ACME-1"), null);
});

// adopt raises no pane and writes only work/ and the DB: the review pane runs
// it itself when the stand is missing, and the main chat repairs with it
// without a confirmation — it is not a mode launch.
test("pnpm adopt passes on the review pane and in the main chat", () => {
  assert.equal(bash("review", "pnpm adopt ACME-1"), null);
  assert.equal(bash(undefined, "pnpm adopt ACME-1"), null);
  assert.equal(bash(undefined, "node --experimental-strip-types src/adopt.ts ACME-1"), null);
});

test("reading or mentioning the launcher files never asks", () => {
  for (const cmd of [
    "sed -n '150,175p' /home/user/yokemate/src/mode-tab.ts",
    "cat src/mode-guard.ts; grep -n 'MODES' src/mode-tab.ts",
    "grep -n 'review|spawn|ship' /home/user/yokemate/src/bash-guard.ts",
    "grep -rn 'pnpm spawn' docs/",
    "git diff src/spawn.ts",
    "wc -l src/mode-tab.ts src/spawn.ts",
  ]) {
    assert.equal(bash(undefined, cmd), null, cmd);
  }
});

// The /note pane is read-only by mechanism, not discipline: file tools write
// only under notes/, Bash loses its writing verbs, mutating git/gh and the
// state-changing pnpm commands. The blessed exits — pnpm note-save and a
// secret gist — pass by construction.
test("note pane writes files only under notes/", () => {
  const root = "/home/x/yokemate";
  const own = { root, dataRoot: `${root}/home` };
  assert.equal(judge("note", "Write", { file_path: `${root}/home/notes/2026-08-28-tema.md` }, own), null);
  assert.equal(
    judge("note", "Write", { file_path: `${root}/home/journal/2026-08.md` }, own)?.decision,
    "deny",
  );
  assert.equal(judge("note", "Edit", { file_path: `${root}/projects/o/r/src/a.ts` }, own)?.decision, "deny");
  assert.equal(
    judge("note", "NotebookEdit", { notebook_path: `${root}/projects/o/r/a.ipynb` }, own)?.decision,
    "deny",
  );
  // A missing path is an unknown target — denied in a read-only pane.
  assert.equal(judge("note", "Write", {}, own)?.decision, "deny");
  // Other modes keep their old behavior.
  assert.equal(
    judge(
      "do",
      "Write",
      { file_path: `${root}/work/ACME-1/src/index.ts` },
      { root, dataRoot: `${root}/home`, ticket: "ACME-1" },
    ),
    null,
  );
});

test("note pane bash blacklist cuts writes and passes reads", () => {
  for (const cmd of [
    "rm x",
    "touch a",
    "sed -i 's/a/b/' f",
    "echo x > notes/a.md",
    "git -C projects/o/r commit -m x",
    "git push",
    "gh pr merge 5",
    "pnpm plan YM-1 p.md",
    "pnpm spawn YM-1",
    "gh gist create --public notes/a.md",
  ]) {
    assert.equal(bash("note", cmd)?.decision, "deny", cmd);
  }
  for (const cmd of [
    "git log --oneline",
    "gh pr view 5",
    "cat f | grep '=>'",
    "ls > /dev/null 2>&1",
    "pnpm note-save тема",
    "pnpm warmup",
    "gh gist create notes/a.md",
  ]) {
    assert.equal(bash("note", cmd), null, cmd);
  }
  // The blacklist is note's alone: the main chat and the task tab keep theirs.
  assert.equal(bash(undefined, "rm /tmp/x"), null);
  assert.equal(bash("do", "git commit -m x"), null);
});

test("browser MCP and settings edits are fenced by mode", () => {
  assert.equal(judge("review", "mcp__claude-in-chrome__computer", {})?.decision, "deny");
  assert.equal(judge("do", "mcp__claude-in-chrome__navigate", {})?.decision, "deny");
  assert.equal(judge(undefined, "mcp__claude-in-chrome__computer", {}), null);
  assert.equal(judge("plan", "mcp__claude-in-chrome__computer", {}), null);

  // Only the session's own configs are fenced: the instance root's settings
  // and the ticket's task-folder settings. A settings.json committed inside a
  // repository worktree is ordinary work; another ticket's pane is not ours.
  const root = "/home/x/yokemate";
  const own = { root, dataRoot: `${root}/home`, ticket: "ACME-1" };
  assert.equal(
    judge("do", "Edit", { file_path: `${root}/.claude/settings.json` }, own)?.decision,
    "deny",
  );
  assert.equal(
    judge("do", "Edit", { file_path: `${root}/.claude/settings.local.json` }, own)?.decision,
    "deny",
  );
  assert.equal(
    judge("review", "Edit", { file_path: `${root}/work/ACME-1/.claude/settings.json` }, own)?.decision,
    "deny",
  );
  assert.equal(
    judge("do", "Write", { file_path: `${root}/work/ACME-1/.claude/settings.local.json` }, own)?.decision,
    "deny",
  );
  assert.equal(
    judge("do", "Edit", { file_path: `${root}/.pi/settings.json` }, own)?.decision,
    "deny",
  );
  assert.equal(
    judge("do", "Edit", { file_path: `${root}/.pi/settings.local.json` }, own)?.decision,
    "deny",
  );
  assert.equal(
    judge("review", "Edit", { file_path: `${root}/work/ACME-1/.pi/settings.json` }, own)?.decision,
    "deny",
  );
  assert.equal(
    judge("do", "Write", { file_path: `${root}/work/ACME-1/.pi/settings.local.json` }, own)?.decision,
    "deny",
  );
  assert.equal(
    judge("do", "Edit", { file_path: `${root}/work/ACME-1/repo/.claude/settings.json` }, own),
    null,
  );
  assert.equal(
    judge("do", "Edit", { file_path: `${root}/work/ACME-2/.claude/settings.json` }, own),
    null,
  );
  assert.equal(
    judge("review", "Edit", { file_path: `${root}/.claude/settings.json` }, { root, dataRoot: `${root}/home` })
      ?.decision,
    "deny",
  );
  assert.equal(
    judge(undefined, "Edit", { file_path: `${root}/.claude/settings.json` }, own),
    null,
  );
  assert.equal(judge("do", "Write", { file_path: `${root}/work/ACME-1/src/index.ts` }, own), null);
});
