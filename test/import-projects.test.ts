// import-projects: the manifest replayed onto a machine — clone what is
// missing, upsert what has no passport, leave existing passports alone (their
// path is this machine's choice). Remotes in fixtures are local repos, so the
// clone step runs offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { decideImport, importProjects } from "../src/import-projects.ts";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "import-"));
}

function makeSourceRepo(root: string, name: string): string {
  const path = join(root, "origins", name);
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["-C", path, "init", "-q"]);
  writeFileSync(join(path, "README.md"), name);
  execFileSync("git", ["-C", path, "add", "."], { stdio: "ignore" });
  execFileSync(
    "git",
    ["-C", path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"],
    { stdio: "ignore" },
  );
  return path;
}

function writeManifestFile(root: string, entries: object[]) {
  writeFileSync(join(root, "projects.json"), JSON.stringify(entries, null, 2) + "\n");
}

function entryFor(remote: string, org: string, repo: string) {
  return {
    org,
    repo,
    remote,
    tracker: "yokeloop",
    tracker_key: "YM",
    model: "opus",
    figma_mcp: null,
    figma_url: null,
    subsystem: null,
  };
}

test("decideImport: passport wins, then the clone decides", () => {
  assert.equal(decideImport(true, true), "skip");
  assert.equal(decideImport(true, false), "skip");
  assert.equal(decideImport(false, true), "upsert");
  assert.equal(decideImport(false, false), "clone");
});

test("an empty db gets clones and passports from the manifest", () => {
  const root = makeRoot();
  try {
    const src = makeSourceRepo(root, "alpha");
    writeManifestFile(root, [entryFor(src, "aaa", "alpha")]);
    const db = openDb(join(root, "yokemate.db"));

    importProjects(db, root);

    const clonePath = join(root, "projects", "aaa", "alpha");
    assert.ok(existsSync(join(clonePath, "README.md")), "clone must exist");
    const row = db
      .prepare("SELECT path, tracker, tracker_key, model FROM project WHERE org = ? AND repo = ?")
      .get("aaa", "alpha") as unknown as { path: string; tracker: string; tracker_key: string; model: string };
    assert.equal(row.path, clonePath);
    assert.equal(row.tracker, "yokeloop");
    assert.equal(row.tracker_key, "YM");
    assert.equal(row.model, "opus");
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an existing passport is not touched", () => {
  const root = makeRoot();
  try {
    const src = makeSourceRepo(root, "alpha");
    writeManifestFile(root, [entryFor(src, "aaa", "alpha")]);
    const db = openDb(join(root, "yokemate.db"));
    db.prepare(
      `INSERT INTO project (org, repo, path, tracker, tracker_key, model)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("aaa", "alpha", "/custom/place/alpha", "yokeloop", "YM", "fable");

    importProjects(db, root);

    const row = db
      .prepare("SELECT path, model FROM project WHERE org = ? AND repo = ?")
      .get("aaa", "alpha") as unknown as { path: string; model: string };
    assert.equal(row.path, "/custom/place/alpha", "path is this machine's choice");
    assert.equal(row.model, "fable");
    assert.ok(!existsSync(join(root, "projects", "aaa", "alpha")), "no clone for a skipped entry");
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a standing clone is reused, only the passport is written", () => {
  const root = makeRoot();
  try {
    const src = makeSourceRepo(root, "alpha");
    const clonePath = join(root, "projects", "aaa", "alpha");
    mkdirSync(clonePath, { recursive: true });
    execFileSync("git", ["clone", "-q", src, clonePath], { stdio: "ignore" });
    writeFileSync(join(clonePath, "local-change.txt"), "keep me");
    writeManifestFile(root, [entryFor(src, "aaa", "alpha")]);
    const db = openDb(join(root, "yokemate.db"));

    importProjects(db, root);

    assert.ok(existsSync(join(clonePath, "local-change.txt")), "existing clone must be untouched");
    const row = db
      .prepare("SELECT path FROM project WHERE org = ? AND repo = ?")
      .get("aaa", "alpha") as unknown as { path: string };
    assert.equal(row.path, clonePath);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--only narrows the import to one org/repo", () => {
  const root = makeRoot();
  try {
    const a = makeSourceRepo(root, "alpha");
    const b = makeSourceRepo(root, "beta");
    writeManifestFile(root, [entryFor(a, "aaa", "alpha"), entryFor(b, "bbb", "beta")]);
    const db = openDb(join(root, "yokemate.db"));

    importProjects(db, root, "bbb/beta");

    assert.ok(!existsSync(join(root, "projects", "aaa", "alpha")));
    assert.ok(existsSync(join(root, "projects", "bbb", "beta")));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project").get()!.n, 1);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--only naming an absent entry fails loudly", () => {
  const root = makeRoot();
  try {
    writeManifestFile(root, [entryFor("/nowhere", "aaa", "alpha")]);
    const db = openDb(join(root, "yokemate.db"));
    assert.throws(() => importProjects(db, root, "zzz/nope"), /zzz\/nope/);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
