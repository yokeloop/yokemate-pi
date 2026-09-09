// The passport manifest: a deterministic projection of the project table into
// projects.json — org/repo-sorted, remote instead of the machine-local path.
// Fixtures live in a temp root with real git clones; nothing touches the pool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { readManifest, writeManifest } from "../src/manifest.ts";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "manifest-"));
}

function makeClone(root: string, org: string, repo: string, remote: string): string {
  const path = join(root, "projects", org, repo);
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["-C", path, "init", "-q"]);
  execFileSync("git", ["-C", path, "remote", "add", "origin", remote]);
  return path;
}

function seedPassport(
  db: ReturnType<typeof openDb>,
  row: {
    org: string;
    repo: string;
    path: string;
    model?: string;
    subsystem?: string | null;
    modeModels?: string;
  },
) {
  db.prepare(
    `INSERT INTO project (org, repo, path, tracker, tracker_key, model, figma_mcp, figma_url, subsystem,
                          mode_models)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.org,
    row.repo,
    row.path,
    "yokeloop",
    "YM",
    row.model ?? "opus",
    null,
    null,
    row.subsystem ?? null,
    row.modeModels ?? null,
  );
}

test("write is deterministic, sorted by org/repo, and read returns the same", () => {
  const root = makeRoot();
  try {
    const db = openDb(join(root, "yokemate.db"));
    seedPassport(db, {
      org: "zzz",
      repo: "last",
      path: makeClone(root, "zzz", "last", "git@example.com:zzz/last.git"),
    });
    seedPassport(db, {
      org: "aaa",
      repo: "first",
      path: makeClone(root, "aaa", "first", "https://example.com/aaa/first.git"),
      model: "fable",
      subsystem: "UI",
      modeModels: '{"review":"luna","ship":"terra"}',
    });

    writeManifest(db, root);
    const first = readFileSync(join(root, "projects.json"), "utf8");
    writeManifest(db, root);
    const second = readFileSync(join(root, "projects.json"), "utf8");
    assert.equal(first, second, "two writes from the same db must be byte-identical");

    const entries = readManifest(root);
    assert.deepEqual(
      entries.map((e) => `${e.org}/${e.repo}`),
      ["aaa/first", "zzz/last"],
    );
    assert.equal(entries[0].remote, "https://example.com/aaa/first.git");
    assert.equal(entries[0].model, "fable");
    assert.equal(entries[0].subsystem, "UI");
    assert.deepEqual(entries[0].mode_models, { review: "luna", ship: "terra" });
    assert.equal(entries[1].remote, "git@example.com:zzz/last.git");
    assert.equal(entries[1].mode_models, null, "no overrides is null, not an empty object");
    assert.ok(!first.includes(root), "machine-local paths must not leak into the manifest");
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dead clone keeps the remote from the existing manifest", () => {
  const root = makeRoot();
  try {
    const db = openDb(join(root, "yokemate.db"));
    seedPassport(db, { org: "aaa", repo: "gone", path: join(root, "projects", "aaa", "gone") });
    writeFileSync(
      join(root, "projects.json"),
      JSON.stringify(
        [
          {
            org: "aaa",
            repo: "gone",
            remote: "git@example.com:aaa/gone.git",
            tracker: "yokeloop",
            tracker_key: "YM",
            model: "opus",
            figma_mcp: null,
            figma_url: null,
            subsystem: null,
          },
        ],
        null,
        2,
      ) + "\n",
    );

    writeManifest(db, root);
    const entries = readManifest(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].remote, "git@example.com:aaa/gone.git");
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dead clone with no prior manifest entry is skipped, the rest are written", () => {
  const root = makeRoot();
  try {
    const db = openDb(join(root, "yokemate.db"));
    seedPassport(db, { org: "aaa", repo: "gone", path: join(root, "projects", "aaa", "gone") });
    seedPassport(db, {
      org: "bbb",
      repo: "alive",
      path: makeClone(root, "bbb", "alive", "git@example.com:bbb/alive.git"),
    });

    writeManifest(db, root);
    const entries = readManifest(root);
    assert.deepEqual(
      entries.map((e) => `${e.org}/${e.repo}`),
      ["bbb/alive"],
    );
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an upserted passport lands in the manifest on the next write", () => {
  const root = makeRoot();
  try {
    const db = openDb(join(root, "yokemate.db"));
    seedPassport(db, {
      org: "aaa",
      repo: "first",
      path: makeClone(root, "aaa", "first", "git@example.com:aaa/first.git"),
    });
    writeManifest(db, root);
    assert.equal(readManifest(root).length, 1);

    const path = makeClone(root, "bbb", "second", "git@example.com:bbb/second.git");
    db.prepare(
      `INSERT INTO project (org, repo, path, tracker, tracker_key, model, figma_mcp, figma_url, subsystem,
                            mode_models)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (org, repo) DO UPDATE
         SET path = excluded.path,
             tracker = excluded.tracker,
             tracker_key = excluded.tracker_key,
             model = excluded.model,
             figma_mcp = excluded.figma_mcp,
             figma_url = excluded.figma_url,
             subsystem = excluded.subsystem,
             mode_models = excluded.mode_models`,
    ).run("bbb", "second", path, "acme", "ACME", "opus", null, null, null, null);
    writeManifest(db, root);

    const entries = readManifest(root);
    assert.deepEqual(
      entries.map((e) => `${e.org}/${e.repo}`),
      ["aaa/first", "bbb/second"],
    );
    assert.equal(entries[1].tracker_key, "ACME");
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readManifest rejects an entry missing a required field", () => {
  const root = makeRoot();
  try {
    writeFileSync(
      join(root, "projects.json"),
      JSON.stringify([{ org: "aaa", repo: "x", tracker: "yokeloop" }], null, 2) + "\n",
    );
    assert.throws(() => readManifest(root), /remote/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readManifest rejects a hand-edited mode_models, and accepts its absence", () => {
  const root = makeRoot();
  const entry = (mode_models: unknown) => ({
    org: "aaa",
    repo: "x",
    remote: "git@example.com:aaa/x.git",
    tracker: "yokeloop",
    tracker_key: "YM",
    model: "opus",
    figma_mcp: null,
    figma_url: null,
    subsystem: null,
    ...(mode_models === undefined ? {} : { mode_models }),
  });
  const write = (mode_models: unknown) =>
    writeFileSync(join(root, "projects.json"), JSON.stringify([entry(mode_models)], null, 2) + "\n");
  try {
    // A manifest written before the field, and one that says "no overrides".
    write(undefined);
    assert.equal(readManifest(root)[0].mode_models, undefined);
    write(null);
    assert.equal(readManifest(root)[0].mode_models, null);

    write(["review"]);
    assert.throws(() => readManifest(root), /"mode_models" must be an object/);
    write({ staging: "luna" });
    assert.throws(() => readManifest(root), /unknown mode "staging" in mode_models/);
    write({ review: "" });
    assert.throws(() => readManifest(root), /mode_models\.review must be a model pattern/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readManifest names the missing file", () => {
  const root = makeRoot();
  try {
    assert.throws(() => readManifest(root), /projects\.json/);
    assert.ok(!existsSync(join(root, "projects.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
