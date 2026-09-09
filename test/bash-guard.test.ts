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

// The wait rules judge what the command runs, not what it looks for: the
// guard once denied `grep -n "tail -f" test/bash-guard.test.ts` on the text
// inside the quotes (YM-134). A wait outside the quotes, or one whose
// argument is quoted, is still a wait.
test("a wait inside quotes is a search, a wait outside them is a wait", () => {
  for (const cmd of [
    'grep -n "tail -f" test/bash-guard.test.ts',
    "grep -rn 'tail -f' src",
    'grep -rn "while true; do" src',
    "rg 'inotifywait' .pi/skills",
    'git log --grep="sleep 300" --oneline',
    'echo "it\'s done"; grep -n "tail -f" x',
  ]) {
    assert.equal(bash(undefined, cmd), null, cmd);
    assert.equal(bash("do", cmd), null, cmd);
    assert.equal(bash("review", cmd), null, cmd);
  }
  for (const cmd of [
    "tail -f dev.log",
    "tail -n 20 -f file",
    'tail -f "$LOG"',
    "tail -n 20 -f 'dev.log'",
    'echo "waiting"; sleep 30',
    "grep 'x' log; tail -f log",
    'grep -n "tail -f" x; tail -f x',
  ]) {
    assert.equal(bash(undefined, cmd)?.decision, "deny", cmd);
    assert.equal(bash("do", cmd)?.decision, "deny", cmd);
  }
});

// Under a command that runs its argument — a nested shell, ssh, a container —
// the quoted span is a command, and a wait inside it blocks the pane the same
// way; a remote grep for the text is still a search.
test("a quoted wait under a shell, ssh or a container is a wait", () => {
  for (const cmd of [
    "ssh host 'tail -f /var/log/app.log'",
    'bash -c "tail -f dev.log"',
    "sh -c 'sleep 300'",
    "zsh -c 'tail -n 20 -f dev.log'",
    'docker exec app sh -c "tail -f /var/log/x"',
    "kubectl exec pod -- bash -c 'sleep 60'",
    "sudo bash -c 'tail -f x'",
    "ssh host \"bash -c 'sleep 300'\"",
    "cd work/X && ssh host 'tail -f x'",
    "echo 'sleep 300' | sh",
    'echo "$(tail -f x)"',
  ]) {
    assert.equal(bash(undefined, cmd)?.decision, "deny", cmd);
    assert.equal(bash("review", cmd)?.decision, "deny", cmd);
  }
  for (const cmd of [
    "ssh host 'journalctl -u app --since today' | tail -100",
    "ssh host \"grep -n 'tail -f' /etc/x\"",
    'grep -n "ssh host \'tail -f\'" file',
    'grep -rn "sh -c \'sleep 300\'" src',
    "grep -n 'tail -f' file.sh",
    'echo "done" | ssh host cat',
  ]) {
    assert.equal(bash(undefined, cmd), null, cmd);
    assert.equal(bash("review", cmd), null, cmd);
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

// The kill rule reads the command outside its quotes the way the wait rules
// do (YM-160): the word in a grep pattern or an echo is data, the word under
// ssh or a shell runs.
test("a quoted kill is data under an ordinary command and a kill under ssh or a shell", () => {
  for (const cmd of [
    'echo "после kill -9"; ls',
    'ls | grep "kill -9"',
    'git log --grep="kill -9"',
    'grep -n "pkill" src/bash-guard.ts',
    "rg 'killall' test",
  ]) {
    assert.equal(bash("do", cmd), null, cmd);
    assert.equal(bash("review", cmd), null, cmd);
  }
  for (const cmd of [
    "kill -9 1234",
    "kill -KILL 1234",
    "kill -s 9 1234",
    "pkill node",
    "killall node",
    "sudo kill -9 1234",
    "echo 1234 | xargs kill -9",
    "ssh host 'pkill -9 node'",
    'bash -c "killall node"',
    "docker exec app sh -c 'kill -9 1'",
  ]) {
    assert.equal(bash("do", cmd)?.decision, "deny", cmd);
    assert.equal(bash("review", cmd)?.decision, "deny", cmd);
  }
});

// A wait ends where its pipeline does: the rule's own class stops at `;` and
// `&`, so a tail that finished before the next command is not a wait (YM-160).
test("a wait is read to the end of its pipeline, not to the end of the line", () => {
  for (const cmd of ["tail -n 5 app.log; grep -f patterns file", "tail -n 5 app.log && ls -f"]) {
    assert.equal(bash("do", cmd), null, cmd);
    assert.equal(bash("review", cmd), null, cmd);
  }
  for (const cmd of ["tail -f app.log", "ssh host 'tail -f /var/log/app.log'"]) {
    assert.equal(bash("do", cmd)?.decision, "deny", cmd);
    assert.equal(bash("review", cmd)?.decision, "deny", cmd);
  }
});

// The launch rule reads the command outside its quotes too (YM-160): a launch
// named in a commit message or a grep pattern is data, one under a runner runs.
test("a quoted launch is data, a launch under a runner is a launch", () => {
  for (const cmd of [
    'git commit -m "ACME-1 docs: pnpm dev запрещён"',
    'grep -rn "pnpm start" src',
    'echo "pnpm dev"',
  ]) {
    assert.equal(bash("do", cmd), null, cmd);
    assert.equal(bash("ship", cmd), null, cmd);
  }
  for (const cmd of ["pnpm dev", "ssh host 'pnpm dev'", "bash -c 'pnpm dev'"]) {
    assert.equal(bash("do", cmd)?.decision, "deny", cmd);
    assert.equal(bash("ship", cmd)?.decision, "deny", cmd);
  }
});

// The /note blacklist and its redirect check read the command outside its
// quotes (YM-160): a writing verb inside a search pattern is data, the same
// verb under ssh or a shell writes.
test("note-write: a quoted write is data, a write under a runner is a write", () => {
  for (const cmd of ['grep -rn "git commit" src/', 'rg "rm -rf" docs', 'echo "pnpm spawn ACME-1"']) {
    assert.equal(bash("note", cmd), null, cmd);
  }
  for (const cmd of ["git commit -m 'x'", "rm -rf notes/x", "ssh host 'rm -rf /x'", "pnpm spawn ACME-1"]) {
    assert.equal(bash("note", cmd)?.decision, "deny", cmd);
  }
});

// rm is the rule whose quoted argument is its target: under an rm pipeline the
// quotes stay as typed, so `rm -rf "$HOME/Documents"` names $HOME and a path
// with a space stays one path; in any other pipeline the same words are data
// (YM-160).
test("the home rule reads rm's targets with their quotes and everything else as data", () => {
  const own = { root: "/home/x/yokemate", dataRoot: "/home/x/yokemate/home", home: "/home/x" };
  const stand = (cmd: string) => judge("do", "Bash", { command: cmd }, own);
  for (const cmd of [
    'rm -rf work/ACME-1; echo "/home/eng/Documents"',
    'grep -rn "rm -rf ~/" src',
    'git commit -m "ACME-1 fix: rm -rf ~/Documents больше не срабатывает"',
    "rm -rf ~/Downloads/old-build",
  ]) {
    assert.equal(stand(cmd), null, cmd);
  }
  for (const cmd of [
    'rm -rf "$HOME/Documents"',
    'rm -rf "/home/x/My Docs"',
    "ssh host 'rm -rf /home/x/y'",
    "rm -rf ~/.config/demo-app/logs",
  ]) {
    assert.equal(stand(cmd)?.decision, "deny", cmd);
  }
});

// The ship question reads the command outside its quotes as well (YM-160):
// reading or quoting the launch is ordinary work, only a launch asks.
test("a quoted ship launch is data, an actual ship launch asks", () => {
  for (const cmd of ['grep -n "pnpm ship" src/mode-tab.ts', 'echo "pnpm ship ACME-1"']) {
    assert.equal(bash(undefined, cmd), null, cmd);
  }
  for (const cmd of ["pnpm ship ACME-1", "pnpm split ship ACME-1"]) {
    assert.equal(bash(undefined, cmd)?.decision, "ask", cmd);
  }
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

test("settings edits are fenced by mode", () => {
  // Only the session's own configs are fenced: the instance root's settings
  // and the ticket's task-folder settings. A settings.json committed inside a
  // repository worktree is ordinary work; another ticket's pane is not ours.
  const root = "/home/x/yokemate";
  const own = { root, dataRoot: `${root}/home`, ticket: "ACME-1" };
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
    judge("do", "Edit", { file_path: `${root}/work/ACME-1/repo/.pi/settings.json` }, own),
    null,
  );
  assert.equal(
    judge("do", "Edit", { file_path: `${root}/work/ACME-2/.pi/settings.json` }, own),
    null,
  );
  assert.equal(
    judge("review", "Edit", { file_path: `${root}/.pi/settings.json` }, { root, dataRoot: `${root}/home` })
      ?.decision,
    "deny",
  );
  assert.equal(
    judge(undefined, "Edit", { file_path: `${root}/.pi/settings.json` }, own),
    null,
  );
  assert.equal(judge("do", "Write", { file_path: `${root}/work/ACME-1/src/index.ts` }, own), null);
});
