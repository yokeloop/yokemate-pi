// Git sync between instances, proven on throwaway repos: the union merge for
// the journal, the push retry under a race, the offline fallback. Nothing
// touches the real pool or the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncPull, syncPush } from "../src/git-sync.ts";
import { noteSave } from "../src/note-save.ts";

const REPO_ROOT = join(import.meta.dirname, "..");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "git-sync-"));
}

function clone(origin: string, dir: string): void {
  execFileSync("git", ["clone", origin, dir], { stdio: ["ignore", "pipe", "pipe"] });
  git(dir, "config", "user.name", "test");
  git(dir, "config", "user.email", "test@test");
  git(dir, "config", "commit.gpgsign", "false");
}

function setupPair(tmp: string): { origin: string; a: string; b: string } {
  const origin = join(tmp, "origin.git");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: ["ignore", "pipe", "pipe"] });
  const a = join(tmp, "a");
  clone(origin, a);
  git(a, "checkout", "-b", "main");
  copyFileSync(join(REPO_ROOT, ".gitattributes"), join(a, ".gitattributes"));
  mkdirSync(join(a, "journal"), { recursive: true });
  appendFileSync(join(a, "journal", "2026-08.md"), "- base\n");
  git(a, "add", "-A");
  git(a, "commit", "-m", "seed");
  git(a, "push", "-u", "origin", "main");
  const b = join(tmp, "b");
  clone(origin, b);
  return { origin, a, b };
}

test("diverging journal appends survive pull --rebase without conflict", () => {
  const tmp = makeTmp();
  try {
    const { a, b } = setupPair(tmp);
    const attrs = readFileSync(join(REPO_ROOT, ".gitattributes"), "utf8");
    assert.match(attrs, /journal\/\*\.md merge=union/);

    appendFileSync(join(a, "journal", "2026-08.md"), "- line A\n");
    git(a, "add", "-A");
    git(a, "commit", "-m", "a");
    git(a, "push");

    appendFileSync(join(b, "journal", "2026-08.md"), "- line B\n");
    git(b, "add", "-A");
    git(b, "commit", "-m", "b");
    git(b, "pull", "--rebase");

    const merged = readFileSync(join(b, "journal", "2026-08.md"), "utf8");
    assert.ok(merged.includes("- line A"), "line from the other machine must be present");
    assert.ok(merged.includes("- line B"), "own line must be present");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function stderrLines(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (msg: unknown) => lines.push(String(msg));
  try {
    fn();
  } finally {
    console.error = orig;
  }
  return lines;
}

test("push racing a faster peer lands after retry", () => {
  const tmp = makeTmp();
  try {
    const { origin, a } = setupPair(tmp);
    const hook = join(origin, "hooks", "pre-receive");
    writeFileSync(hook, '#!/bin/sh\nif [ ! -f "$PWD/seen" ]; then : > "$PWD/seen"; exit 1; fi\nexit 0\n');
    chmodSync(hook, 0o755);

    appendFileSync(join(a, "journal", "2026-08.md"), "- raced\n");
    syncPush(a, "TST-1 план");

    assert.equal(git(origin, "log", "-1", "--format=%s", "main").trim(), "TST-1 план");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("plan and journal land in origin as one commit", () => {
  const tmp = makeTmp();
  try {
    const { origin, a } = setupPair(tmp);
    mkdirSync(join(a, "knowledge", "yokeloop", "yokemate", "ai", "x"), { recursive: true });
    writeFileSync(join(a, "knowledge", "yokeloop", "yokemate", "ai", "x", "x-plan.md"), "# plan\n");
    appendFileSync(join(a, "journal", "2026-08.md"), "- TST-2 запланировано\n");
    syncPush(a, "TST-2 план");

    assert.equal(git(origin, "log", "-1", "--format=%s", "main").trim(), "TST-2 план");
    const files = git(origin, "show", "--name-only", "--format=", "main");
    assert.ok(files.includes("knowledge/yokeloop/yokemate/ai/x/x-plan.md"));
    assert.ok(files.includes("journal/2026-08.md"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("offline push keeps the commit local, reports one line, stages nothing extra", () => {
  const tmp = makeTmp();
  try {
    const { a } = setupPair(tmp);
    writeFileSync(join(a, "code.txt"), "tracked code\n");
    git(a, "add", "code.txt");
    git(a, "commit", "-m", "code");
    git(a, "remote", "set-url", "origin", join(tmp, "gone"));

    appendFileSync(join(a, "journal", "2026-08.md"), "- offline\n");
    writeFileSync(join(a, "code.txt"), "edited code\n");
    const lines = stderrLines(() => syncPush(a, "журнал"));

    assert.ok(lines.some((l) => l.includes("push отложен")), `stderr: ${lines.join(" | ")}`);
    assert.equal(git(a, "log", "-1", "--format=%s").trim(), "журнал");
    const files = git(a, "show", "--name-only", "--format=", "HEAD");
    assert.equal(files.trim(), "journal/2026-08.md");
    assert.match(git(a, "status", "--porcelain"), /^ M code\.txt/m);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("nothing staged means no commit", () => {
  const tmp = makeTmp();
  try {
    const { a } = setupPair(tmp);
    const before = git(a, "rev-parse", "HEAD").trim();
    syncPush(a, "журнал");
    assert.equal(git(a, "rev-parse", "HEAD").trim(), before);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a note rides the default syncPush like the journal", () => {
  const tmp = makeTmp();
  try {
    const { origin, a } = setupPair(tmp);
    mkdirSync(join(a, "notes"), { recursive: true });
    writeFileSync(join(a, "notes", "2026-08-28-tema.md"), "# note\n");
    syncPush(a, "TST-3 план");

    const files = git(origin, "show", "--name-only", "--format=", "main");
    assert.ok(files.includes("notes/2026-08-28-tema.md"), `files: ${files}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("explicit paths commit only notes and leave a dirty journal alone", () => {
  const tmp = makeTmp();
  try {
    const { origin, a } = setupPair(tmp);
    mkdirSync(join(a, "notes"), { recursive: true });
    writeFileSync(join(a, "notes", "2026-08-28-tema.md"), "# note\n");
    appendFileSync(join(a, "journal", "2026-08.md"), "- dirty\n");
    syncPush(a, "заметка tema", ["notes"]);

    assert.equal(git(origin, "log", "-1", "--format=%s", "main").trim(), "заметка tema");
    const files = git(origin, "show", "--name-only", "--format=", "main");
    assert.equal(files.trim(), "notes/2026-08-28-tema.md");
    assert.match(git(a, "status", "--porcelain"), /^ M journal\/2026-08\.md/m);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("noteSave commits and pushes notes/ even under the pane's stamp", () => {
  const tmp = makeTmp();
  const prior = process.env.YOKEMATE_MODE;
  try {
    const { origin, a } = setupPair(tmp);
    mkdirSync(join(a, "notes"), { recursive: true });
    writeFileSync(join(a, "notes", "2026-08-28-tema.md"), "# note\n");
    process.env.YOKEMATE_MODE = "note";
    noteSave(a, "тема");

    assert.equal(git(origin, "log", "-1", "--format=%s", "main").trim(), "заметка тема");
    const files = git(origin, "show", "--name-only", "--format=", "main");
    assert.equal(files.trim(), "notes/2026-08-28-tema.md");
  } finally {
    if (prior === undefined) delete process.env.YOKEMATE_MODE;
    else process.env.YOKEMATE_MODE = prior;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("syncPull picks up the peer and pushes local unsent commits", () => {
  const tmp = makeTmp();
  try {
    const { origin, a, b } = setupPair(tmp);
    appendFileSync(join(a, "journal", "2026-08.md"), "- from A\n");
    git(a, "add", "-A");
    git(a, "commit", "-m", "a");
    git(a, "push");

    appendFileSync(join(b, "journal", "2026-08.md"), "- from B\n");
    git(b, "add", "-A");
    git(b, "commit", "-m", "unsent");
    syncPull(b);

    assert.ok(readFileSync(join(b, "journal", "2026-08.md"), "utf8").includes("- from A"));
    const originLog = git(origin, "log", "--format=%s", "main");
    assert.ok(originLog.includes("unsent"), `origin log: ${originLog}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("syncPull offline skips silently with one line", () => {
  const tmp = makeTmp();
  try {
    const { a } = setupPair(tmp);
    git(a, "remote", "set-url", "origin", join(tmp, "gone"));
    const lines = stderrLines(() => syncPull(a));
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("нет сети"), `stderr: ${lines.join(" | ")}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
