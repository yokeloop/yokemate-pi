// Adopt rebuilds the review stand from observable facts on a machine where
// /do never ran: the plan in knowledge, the <KEY> branch in origin, the open
// PR. Proven on a throwaway root with a fake clone — nothing touches the real
// pool or the network (the pull and the PR lookup are injected).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adopt, findPlan, parseAffected } from "../src/adopt.ts";
import { openDb } from "../src/db.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// 1. The Affected repositories parser against the shapes real plans use:
// backticked org/repo, a bare repo name, a backticked role with a tail, a
// compound role, a line with no role at all.
test("parseAffected reads the shapes real plans use", () => {
  const md = [
    "# T-1 — title",
    "",
    "## Affected repositories",
    "",
    "- `acme/acme-ui-kit` — library (виджеты)",
    "- `acme-subscription-page` — `app`. Единственный репозиторий тикета.",
    "- `org/tool` — backend + app",
    "- `org/norole` (working clone `projects/org/norole`)",
    "",
    "## Steps",
    "",
    "- `org/ghost` — app",
  ].join("\n");
  assert.deepEqual(parseAffected(md), [
    { repo: "acme/acme-ui-kit", role: "library", roleAssumed: false },
    { repo: "acme-subscription-page", role: "app", roleAssumed: false },
    { repo: "org/tool", role: "backend", roleAssumed: false },
    { repo: "org/norole", role: "app", roleAssumed: true },
  ]);
  assert.deepEqual(parseAffected("# no section\n\n## Steps\n\n- `x/y` — app"), []);
});

// 2. The plan glob: keys are typed uppercase, old slugs are lowercase, and a
// rework plan beside the base plan does not shadow it.
test("findPlan matches the key case-insensitively and prefers the folder's own plan", () => {
  const root = mkdtempSync(join(tmpdir(), "adopt-plan-"));
  try {
    const dir = join(root, "knowledge", "acme", "acme-ui-kit", "ai", "acme-3-fix");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "acme-3-fix-plan.md"), "# p");
    writeFileSync(join(dir, "acme-3-fix-rework-plan.md"), "# r");
    assert.equal(findPlan(root, "ACME-3"), join(dir, "acme-3-fix-plan.md"));
    assert.equal(findPlan(root, "ACME-33"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function setupRoot(): { root: string; clone: string } {
  const root = mkdtempSync(join(tmpdir(), "adopt-"));
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: ["ignore", "pipe", "pipe"] });
  const clone = join(root, "clones", "repo1");
  execFileSync("git", ["clone", origin, clone], { stdio: ["ignore", "pipe", "pipe"] });
  git(clone, "config", "user.name", "test");
  git(clone, "config", "user.email", "test@test");
  git(clone, "config", "commit.gpgsign", "false");
  git(clone, "commit", "--allow-empty", "-m", "seed");
  git(clone, "push", "-u", "origin", "main");
  // The PR branch exists only in origin — the shape of a machine /do never ran on.
  git(clone, "checkout", "-b", "YM-9");
  git(clone, "commit", "--allow-empty", "-m", "work");
  git(clone, "push", "-u", "origin", "YM-9");
  git(clone, "checkout", "main");
  git(clone, "branch", "-D", "YM-9");

  const planDir = join(root, "knowledge", "testorg", "repo1", "ai", "YM-9-thing");
  mkdirSync(planDir, { recursive: true });
  writeFileSync(
    join(planDir, "YM-9-thing-plan.md"),
    "# YM-9\n\n## Affected repositories\n\n- `testorg/repo1` — app\n\n## Steps\n",
  );

  const db = openDb(join(root, "yokemate.db"));
  db.prepare(
    "INSERT INTO project (org, repo, path, tracker, tracker_key, model) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("testorg", "repo1", clone, "yokeloop", "YM", "fable");
  return { root, clone };
}

// 3. The smoke: a fresh root adopts the ticket — worktree on the PR branch,
// work row in review, part row with the PR; a second run is a repeat that
// doubles nothing.
test("adopt assembles the stand and the review row, repeats as a no-op", () => {
  const { root } = setupRoot();
  try {
    const deps = { pull: () => {}, listPrs: () => ["https://github.com/testorg/repo1/pull/7"] };
    const first = adopt(root, "YM-9", {}, deps);
    assert.equal(first.repeat, false);
    assert.deepEqual(first.parts, [
      { repo: "testorg/repo1", role: "app", pr: "https://github.com/testorg/repo1/pull/7" },
    ]);

    const worktree = join(root, "work", "YM-9", "repo1");
    assert.ok(existsSync(worktree), "worktree must stand in work/YM-9/repo1");
    assert.equal(git(worktree, "rev-parse", "--abbrev-ref", "HEAD").trim(), "YM-9");

    const db = openDb(join(root, "yokemate.db"));
    const row = db.prepare("SELECT stage, folder, plan, pr FROM work WHERE ticket = 'YM-9'").get() as {
      stage: string;
      folder: string;
      plan: string;
      pr: string;
    };
    assert.equal(row.stage, "review");
    assert.equal(row.folder, join(root, "work", "YM-9"));
    assert.ok(row.plan.endsWith("YM-9-thing-plan.md"));
    assert.equal(row.pr, "https://github.com/testorg/repo1/pull/7");
    const parts = db.prepare("SELECT repo, role, branch, pr FROM part").all() as unknown as {
      repo: string;
      role: string;
      branch: string;
      pr: string;
    }[];
    assert.deepEqual(parts.map((p) => ({ ...p })), [
      {
        repo: "testorg/repo1",
        role: "app",
        branch: "YM-9",
        pr: "https://github.com/testorg/repo1/pull/7",
      },
    ]);

    const second = adopt(root, "YM-9", {}, deps);
    assert.equal(second.repeat, true, "a second adopt is a repeat, not an error");
    assert.equal((db.prepare("SELECT COUNT(*) c FROM part").get() as { c: number }).c, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 4. Every missing fact fails with its own line: no plan, no passport, no
// branch in origin, no open PR — and a failed adopt writes no row.
test("adopt names the missing fact and writes nothing on failure", () => {
  const { root, clone } = setupRoot();
  try {
    const prs = () => ["https://github.com/testorg/repo1/pull/7"];
    assert.throws(() => adopt(root, "YM-777", {}, { pull: () => {}, listPrs: prs }), /плана в knowledge нет/);

    const planDir = join(root, "knowledge", "testorg", "repo1", "ai", "YM-8-other");
    mkdirSync(planDir, { recursive: true });
    writeFileSync(
      join(planDir, "YM-8-other-plan.md"),
      "# YM-8\n\n## Affected repositories\n\n- `testorg/repo1` — app\n",
    );
    assert.throws(
      () => adopt(root, "YM-8", {}, { pull: () => {}, listPrs: prs }),
      /PR-ветки YM-8 в testorg\/repo1 нет/,
    );

    const planDir9 = join(root, "knowledge", "testorg", "ghost", "ai", "YM-7-ghost");
    mkdirSync(planDir9, { recursive: true });
    writeFileSync(
      join(planDir9, "YM-7-ghost-plan.md"),
      "# YM-7\n\n## Affected repositories\n\n- `testorg/ghost` — app\n",
    );
    assert.throws(
      () => adopt(root, "YM-7", {}, { pull: () => {}, listPrs: prs }),
      /паспорта testorg\/ghost нет/,
    );

    git(clone, "checkout", "-b", "YM-6");
    git(clone, "push", "-u", "origin", "YM-6");
    git(clone, "checkout", "main");
    const planDir6 = join(root, "knowledge", "testorg", "repo1", "ai", "YM-6-noPr");
    mkdirSync(planDir6, { recursive: true });
    writeFileSync(
      join(planDir6, "YM-6-noPr-plan.md"),
      "# YM-6\n\n## Affected repositories\n\n- `testorg/repo1` — app\n",
    );
    assert.throws(
      () => adopt(root, "YM-6", {}, { pull: () => {}, listPrs: () => [] }),
      /открытого PR по ветке YM-6/,
    );

    const db = openDb(join(root, "yokemate.db"));
    for (const key of ["YM-777", "YM-8", "YM-7", "YM-6"]) {
      assert.equal(db.prepare("SELECT COUNT(*) c FROM work WHERE ticket = ?").get(key)!.c, 0, key);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 5. A move the stage machine refuses leaves no git trace: the pre-flight
// check runs before any fetch or worktree add, so a refused adopt cannot
// plant a folder that would mask the adopt instruction on the next /review.
test("a refused adopt creates no worktree", () => {
  const { root } = setupRoot();
  try {
    const db = openDb(join(root, "yokemate.db"));
    db.prepare("INSERT INTO work (ticket, url, stage) VALUES ('YM-9', 'ticket:YM-9', 'planned')").run();
    assert.throws(
      () =>
        adopt(root, "YM-9", {}, { pull: () => {}, listPrs: () => ["https://github.com/t/r/pull/7"] }),
      /YM-9 is at planned/,
    );
    assert.ok(!existsSync(join(root, "work", "YM-9")), "no folder may appear on a refused move");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 6. Offline or a broken remote is not «ветки нет»: only a missing ref gets
// the branch diagnosis, anything else carries git's own last line.
test("a broken remote is reported as a failed fetch, not a missing branch", () => {
  const { root, clone } = setupRoot();
  try {
    git(clone, "remote", "set-url", "origin", join(root, "no-such-origin.git"));
    assert.throws(
      () =>
        adopt(root, "YM-9", {}, { pull: () => {}, listPrs: () => ["https://github.com/t/r/pull/7"] }),
      (e: Error) => /git fetch origin YM-9 в testorg\/repo1 не прошёл/.test(e.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
