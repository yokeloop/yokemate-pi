// Git sync between instances, proven on throwaway repos: the union merge for
// the journal, the push retry under a race, the offline fallback. Nothing
// touches the real pool or the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitExact, gitMutationLockPath, pullFastForward, syncPull, syncPush } from "../src/git-sync.ts";
import { recordPlan } from "../src/plan-record.ts";
import { openDb } from "../src/db.ts";
import { noteSave } from "../src/note-save.ts";

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
  writeFileSync(join(a, ".gitattributes"), "journal/*.md merge=union\n");
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
    const attrs = readFileSync(join(a, ".gitattributes"), "utf8");
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

test("движок берёт только ff, расхождение — одна строка и никакого мержа", () => {
  const tmp = makeTmp();
  try {
    const { origin, a, b } = setupPair(tmp);
    appendFileSync(join(b, "journal", "2026-08.md"), "- from B\n");
    git(b, "add", "-A");
    git(b, "commit", "-m", "upstream");
    git(b, "push");

    appendFileSync(join(a, "journal", "2026-08.md"), "- from A\n");
    git(a, "add", "-A");
    git(a, "commit", "-m", "local");
    const lines = stderrLines(() => pullFastForward(a));

    assert.equal(lines.length, 1, `stderr: ${lines.join(" | ")}`);
    assert.ok(lines[0].includes("разошёлся с апстримом"), `stderr: ${lines.join(" | ")}`);
    assert.equal(git(a, "log", "-1", "--format=%s").trim(), "local");
    assert.equal(git(a, "status", "--porcelain").trim(), "");

    const c = join(tmp, "c");
    clone(origin, c);
    pullFastForward(c);
    assert.equal(git(c, "rev-parse", "HEAD").trim(), git(c, "rev-parse", "origin/main").trim());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("корень данных без своего .git не трогает движок", () => {
  const tmp = makeTmp();
  try {
    const { origin, a, b } = setupPair(tmp);
    git(b, "commit", "--allow-empty", "-m", "upstream");
    git(b, "push");
    git(a, "commit", "--allow-empty", "-m", "local");
    const head = git(a, "rev-parse", "HEAD").trim();

    // home/ exists as a plain directory — what logMove leaves on a machine
    // bootstrapped without YOKEMATE_HOME_REMOTE. git discovery from inside it
    // finds the engine, so a pull here would rebase and push the engine itself.
    mkdirSync(join(a, "home", "journal"), { recursive: true });
    const lines = stderrLines(() => syncPull(join(a, "home")));

    assert.equal(lines.length, 1, `stderr: ${lines.join(" | ")}`);
    assert.ok(lines[0].includes("не свой git-репозиторий"), `stderr: ${lines.join(" | ")}`);
    assert.equal(git(a, "rev-parse", "HEAD").trim(), head, "движок остаётся на своём коммите");
    assert.equal(git(a, "log", "-1", "--format=%s").trim(), "local");
    assert.equal(git(origin, "log", "-1", "--format=%s", "main").trim(), "upstream");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("plan commit excludes foreign staged files and duplicate record does not repeat journal", async () => {
  const tmp = makeTmp();
  try {
    const { origin, a } = setupPair(tmp);
    const engine = join(tmp, "engine");
    mkdirSync(join(engine, ".pi"), { recursive: true });
    writeFileSync(join(engine, ".pi", "settings.json"), "{}");
    execFileSync("mv", [a, join(engine, "home")]);
    const home = join(engine, "home");
    const plan = join(home, "knowledge", "org", "repo", "ai", "YM-1-work", "plan.md");
    mkdirSync(join(plan, ".."), { recursive: true });
    writeFileSync(plan, "# YM-1\n\n## Affected repositories\n- `org/repo` — app\n");
    writeFileSync(join(home, "foreign.txt"), "foreign\n");
    git(home, "add", "foreign.txt");
    const db = openDb(join(engine, "yokemate.db"));
    db.prepare("INSERT INTO project (org,repo,path,tracker,tracker_key,model) VALUES ('org','repo','/tmp/repo','github','YM','test/model')").run();
    db.close();
    const first = await recordPlan(engine, "YM-1", plan, { ...process.env, YOKEMATE_MODE: "plan", YOKEMATE_TICKET: "YM-1" });
    assert.equal(first.recorded, true);
    assert.equal(first.localSync.state, "committed");
    const files = git(home, "show", "--name-only", "--format=", first.localSync.commit!).trim().split("\n");
    assert.ok(files.includes("knowledge/org/repo/ai/YM-1-work/plan.md"));
    assert.ok(files.some((file) => file.startsWith("journal/")));
    assert.equal(files.includes("foreign.txt"), false);
    assert.equal(git(home, "diff", "--cached", "--name-only").trim(), "foreign.txt");
    const journalFile = join(home, "journal", readdirSync(join(home, "journal"))[0]!);
    const before = readFileSync(journalFile, "utf8");
    const repeat = await recordPlan(engine, "YM-1", plan, { ...process.env, YOKEMATE_MODE: "plan", YOKEMATE_TICKET: "YM-1" });
    assert.equal(repeat.repeat, true);
    assert.equal(readFileSync(journalFile, "utf8"), before);
    assert.equal(git(origin, "log", "-1", "--format=%s", "main").trim(), "YM-1 план");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("a cancelled plan recorder waiting for the canonical lock makes no mutation", async () => {
  const tmp = makeTmp();
  let holder: ReturnType<typeof spawn> | undefined;
  try {
    const { a } = setupPair(tmp);
    const engine = join(tmp, "engine");
    mkdirSync(join(engine, ".pi"), { recursive: true });
    writeFileSync(join(engine, ".pi", "settings.json"), "{}");
    execFileSync("mv", [a, join(engine, "home")]);
    const home = join(engine, "home");
    const plan = join(home, "knowledge", "org", "repo", "ai", "YM-1-work", "plan.md");
    mkdirSync(join(plan, ".."), { recursive: true });
    writeFileSync(plan, "# YM-1\n\n## Affected repositories\n- `org/repo` — app\n");
    const db = openDb(join(engine, "yokemate.db"));
    db.prepare("INSERT INTO project (org,repo,path,tracker,tracker_key,model) VALUES ('org','repo','/tmp/repo','github','YM','test/model')").run();
    db.close();
    holder = spawn("flock", ["--exclusive", "--no-fork", gitMutationLockPath(home), "sh", "-c", "echo locked; exec sleep 30"], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((resolve) => holder!.stdout!.once("data", () => resolve()));
    const controller = new AbortController();
    const pending = recordPlan(engine, "YM-1", plan, { ...process.env, YOKEMATE_MODE: "plan", YOKEMATE_TICKET: "YM-1" }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, /cancelled before lock acquisition/);
    assert.equal(readFileSync(plan, "utf8").startsWith("# YM-1"), true);
    const journal = existsSync(join(home, "journal")) ? readdirSync(join(home, "journal")).map((name) => readFileSync(join(home, "journal", name), "utf8")).join("\n") : "";
    assert.doesNotMatch(journal, /YM-1 запланировано/);
  } finally { holder?.kill("SIGKILL"); rmSync(tmp, { recursive: true, force: true }); }
});

test("parallel plan recorders serialize local writes", async () => {
  const tmp = makeTmp();
  try {
    const { origin, a } = setupPair(tmp);
    const engine = join(tmp, "engine");
    mkdirSync(join(engine, ".pi"), { recursive: true });
    writeFileSync(join(engine, ".pi", "settings.json"), "{}");
    execFileSync("mv", [a, join(engine, "home")]);
    const home = join(engine, "home");
    const db = openDb(join(engine, "yokemate.db"));
    db.prepare("INSERT INTO project (org,repo,path,tracker,tracker_key,model) VALUES ('org','repo','/tmp/repo','github','YM','test/model')").run();
    db.close();
    const plans = ["YM-1", "YM-2"].map((ticket) => {
      const plan = join(home, "knowledge", "org", "repo", "ai", `${ticket}-work`, "plan.md");
      mkdirSync(join(plan, ".."), { recursive: true });
      writeFileSync(plan, `# ${ticket}\n\n## Affected repositories\n- \`org/repo\` — app\n`);
      return { ticket, plan };
    });
    const results = await Promise.all(plans.map(({ ticket, plan }) => recordPlan(engine, ticket, plan, { ...process.env, YOKEMATE_MODE: "plan", YOKEMATE_TICKET: ticket })));
    assert.ok(results.every((result) => result.recorded && result.localSync.state === "committed"));
    const log = git(origin, "log", "--format=%s", "main");
    assert.match(log, /YM-1 план/);
    assert.match(log, /YM-2 план/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("commitExact defers when a target already has staged content", () => {
  const tmp = makeTmp();
  try {
    const { a } = setupPair(tmp);
    appendFileSync(join(a, "journal", "2026-08.md"), "- staged\n");
    git(a, "add", "journal/2026-08.md");
    const result = commitExact(a, "plan", ["journal/2026-08.md"]);
    assert.equal(result.state, "deferred");
    assert.match(result.reason ?? "", /already staged/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("syncPush не пишет в движок из чужого каталога", () => {
  const tmp = makeTmp();
  try {
    const { origin, a, b } = setupPair(tmp);
    git(b, "commit", "--allow-empty", "-m", "upstream");
    git(b, "push");
    git(a, "commit", "--allow-empty", "-m", "local");
    const head = git(a, "rev-parse", "HEAD").trim();

    mkdirSync(join(a, "home", "journal"), { recursive: true });
    writeFileSync(join(a, "home", "journal", "2026-09.md"), "- запись\n");
    const lines = stderrLines(() => syncPush(join(a, "home"), "проба"));

    assert.equal(lines.length, 1, `stderr: ${lines.join(" | ")}`);
    assert.ok(lines[0].includes("не свой git-репозиторий"), `stderr: ${lines.join(" | ")}`);
    assert.equal(git(a, "rev-parse", "HEAD").trim(), head, "движок остаётся на своём коммите");
    assert.equal(git(a, "diff", "--cached", "--name-only").trim(), "", "индекс движка не тронут");
    assert.equal(git(origin, "log", "-1", "--format=%s", "main").trim(), "upstream");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
