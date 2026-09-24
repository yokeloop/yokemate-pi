import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { bindCoordinatorControl, processStarttime } from "../src/coordinator-control.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { markDoRunning, prepareDo, prepareShip, splitDoRequest, validateCoordinatorRequest } from "../src/coordinator-launch.ts";
import { socketDir } from "../src/inbox.ts";

function root(): string {
  const root = mkdtempSync(join(tmpdir(), "coordinator-launch-"));
  mkdirSync(join(root, ".pi", "agents", "do"), { recursive: true });
  mkdirSync(join(root, "home", "knowledge", "org", "repo", "ai", "YM-1-work"), { recursive: true });
  writeFileSync(join(root, ".pi", "settings.json"), "{}");
  writeFileSync(join(root, "home", "knowledge", "org", "repo", "ai", "YM-1-work", "YM-1-work-plan.md"), "# YM-1\n\n## Goal\nFixture.\n\n## Affected repositories\n- `org/repo` — app\n\n## Steps\n1. Fixture.\n\n## Assumptions\n- Fixture.\n\n## Out of scope\n- Other work.\n\n## Acceptance\nFixture completes.\n");
  const db = openDb(join(root, "yokemate.db"));
  db.prepare("INSERT INTO project (org, repo, path, tracker, tracker_key, model) VALUES ('org','repo', ?, 'x', 'YM', 'test/model')").run(join(root, "clone"));
  db.close();
  return root;
}

// Capacity/retry/duplicate ownership belongs to coordinator-runtime.test.ts.
// Actual extension startup/render/shutdown wiring is deferred to a future suite.
test("do preparation resolves exact plan parts and CAS prevents stale running write", () => {
  const dir = root();
  try {
    const plan = join(dir, "home", "knowledge", "org", "repo", "ai", "YM-1-work", "YM-1-work-plan.md");
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ guardPolicy: { yolo: true } }));
    const prepared = prepareDo(dir, { mode: "do", tickets: ["YM-1"], plan }, {});
    assert.equal(prepared.parts[0]?.repo, "org/repo");
    assert.equal(prepared.model, "test/model");
    const db = openDb(join(dir, "yokemate.db"));
    db.prepare("INSERT INTO work (ticket, url, stage) VALUES ('YM-1','u','review')").run();
    db.close();
    assert.throws(() => markDoRunning(dir, prepared, { YOKEMATE_MODE: "do", YOKEMATE_TICKET: "YM-1", YOKEMATE_ROLE: "coordinator" }), /changed from absent to review/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("do preparation preserves an explicit model without a thinking setting", () => {
  const dir = root();
  try {
    const plan = join(dir, "home", "knowledge", "org", "repo", "ai", "YM-1-work", "YM-1-work-plan.md");
    writeFileSync(join(dir, "home", "pool.json"), "not json");
    const prepared = prepareDo(dir, { mode: "do", tickets: ["YM-1"], plan, model: "test/model:high" }, {});
    assert.equal(prepared.model, "test/model:high");
    const settings = JSON.parse(readFileSync(join(prepared.cwd, ".pi", "settings.json"), "utf8"));
    assert.equal("thinkingLevel" in settings, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("do preparation falls back to pool only when the tracker key has no passports", () => {
  const dir = root();
  try {
    const plan = join(dir, "home", "knowledge", "org", "repo", "ai", "YM-1-work", "YM-1-work-plan.md");
    writeFileSync(join(dir, "home", "pool.json"), '{"do":"pool-do"}');
    assert.equal(prepareDo(dir, { mode: "do", tickets: ["OTHER-1"], plan }, {}).model, "pool-do");
    writeFileSync(join(dir, "home", "pool.json"), "not json");
    const db = openDb(join(dir, "yokemate.db"));
    db.prepare("UPDATE project SET mode_models = '{\"do\":\"passport-do\"}' WHERE tracker_key = 'YM'").run();
    assert.equal(prepareDo(dir, { mode: "do", tickets: ["YM-2"], plan }, {}).model, "passport-do");
    db.prepare("INSERT INTO project (org, repo, path, tracker, tracker_key, model) VALUES ('org','other', ?, 'x', 'YM', 'other-model')").run(join(dir, "other"));
    db.close();
    assert.throws(() => prepareDo(dir, { mode: "do", tickets: ["YM-3"], plan }, {}), /disagree on the do model/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("coordinator requests reject malformed keys, duplicate batches and split a do batch per key", () => {
  const request = { mode: "do" as const, tickets: ["YM-1", "YM-2"], plan: "/plan.md", model: "test/model:high" };
  assert.doesNotThrow(() => validateCoordinatorRequest(request));
  assert.deepEqual(splitDoRequest(request), [{ ...request, tickets: ["YM-1"] }, { ...request, tickets: ["YM-2"] }]);
  assert.deepEqual(request.tickets, ["YM-1", "YM-2"]);
  const ship = { mode: "ship" as const, tickets: ["YM-2", "YM-1"] };
  assert.deepEqual(splitDoRequest(ship), [ship]);
  assert.throws(() => validateCoordinatorRequest({ mode: "do", tickets: ["YM-1", "YM-1"] }), /duplicates/);
  assert.throws(() => splitDoRequest({ mode: "do", tickets: ["YM-1", "YM-1"] }), /duplicates/);
  assert.throws(() => validateCoordinatorRequest({ mode: "ship", tickets: ["YM-1", "YM-1"] }), /duplicates/);
  assert.throws(() => validateCoordinatorRequest({ mode: "do", tickets: ["../YM-1"] }), /invalid/);
});

test("spawn routes each key independently through its retained parent", async () => {
  const source = join(import.meta.dirname, "..");
  const dir = mkdtempSync(join(import.meta.dirname, "fixtures", "spawn-batch-"));
  const runtime = mkdtempSync(join(tmpdir(), "spawn-batch-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  mkdirSync(socketDir(env, process.getuid!()), { recursive: true });
  writeFileSync(join(socketDir(env, process.getuid!()), "main-pane.json"), JSON.stringify({ mode: "main", ticket: null, cwd: dir, pid: process.pid, starttime: processStarttime(process.pid), sessionId: "fixture-session", parentPane: null }));
  const requests: unknown[] = [];
  const parent = bindCoordinatorControl(dir, {
    launch: async (request) => {
      requests.push(request);
      return { listRunId: "fixture-list", results: request.tickets.map((key, index) => index === 0 ? { key, keyRunId: "fixture-run-1", state: "refused" as const, reason: "already running" } : { key, keyRunId: "fixture-run-2", state: "accepted" as const }) };
    },
    status: () => ({ requestId: "unused", state: "refused" }),
    cancel: async () => {},
  }, { root: dir, sessionId: "fixture-session", runtimeId: "fixture-runtime", pid: process.pid, starttime: processStarttime(process.pid)!, cwd: dir, pane: "main-pane" }, env);
  try {
    await once(parent, "listening");
    cpSync(join(source, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(source, "package.json"), join(dir, "package.json"));
    for (const entry of ["node", "package"]) {
      const command = entry === "package" ? "pnpm" : process.execPath;
      const args = entry === "package" ? ["spawn", "YM-1", "YM-2", "--plan", "/explicit.md", "--model", "test/model"] : ["--experimental-strip-types", "--no-warnings", join(dir, "src", "spawn.ts"), "YM-1", "YM-2", "--plan", "/explicit.md", "--model", "test/model"];
      const out = await promisify(execFile)(command, args, { cwd: dir, env: { PATH: process.env.PATH, XDG_RUNTIME_DIR: runtime, PI_SESSION_ID: "fixture-session", HERDR_PANE_ID: "main-pane" }, timeout: 20000 });
      assert.deepEqual(out.stdout.trim().split("\n").filter((line) => /^(?:refused )?YM-/.test(line)), ["refused YM-1: already running", "YM-2 → reserved background run fixture-run-2"]);
    }
    assert.deepEqual(requests, [
      { mode: "do", tickets: ["YM-1", "YM-2"], plan: "/explicit.md", model: "test/model" },
      { mode: "do", tickets: ["YM-1", "YM-2"], plan: "/explicit.md", model: "test/model" },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => parent.close((error) => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("ship preparation keeps the ordered batch", async () => {
  const dir = root();
  const previousPath = process.env.PATH;
  try {
    const db = openDb(join(dir, "yokemate.db"));
    db.prepare("INSERT INTO project (org, repo, path, tracker, tracker_key, model) VALUES ('org','repo-a', ?, 'x', 'A', 'model-a')").run(join(dir, "clone-a"));
    db.prepare("INSERT INTO project (org, repo, path, tracker, tracker_key, model) VALUES ('org','repo-b', ?, 'x', 'B', 'model-b')").run(join(dir, "clone-b"));
    db.close();
    const shim = join(dir, "shim");
    mkdirSync(shim);
    writeFileSync(join(shim, "gh"), '#!/bin/sh\nprintf \'{"baseRefName":"main","url":"https://github.com/org/repo/pull/%s","headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","headRefName":"%s"}\\n\' "$3" "$3"\n', { mode: 0o755 });
    for (const [ticket, repo] of [["A-1", "repo-a"], ["B-1", "repo-b"], ["C-1", "repo-a"]]) {
      const folder = join(dir, "home", "knowledge", "org", repo, "ai", `${ticket}-work`);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, `${ticket}-work-plan.md`), `# ${ticket}\n\n## Goal\nFixture.\n\n## Affected repositories\n- \`org/${repo}\` — app\n\n## Steps\n1. Fixture.\n\n## Assumptions\n- Fixture.\n\n## Out of scope\n- Other work.\n\n## Acceptance\nFixture completes.\n`);
      const worktree = join(dir, "work", ticket, repo);
      mkdirSync(worktree, { recursive: true });
      execFileSync("git", ["init", "-b", ticket, worktree], { stdio: "pipe" });
      execFileSync("git", ["-C", worktree, "remote", "add", "origin", `https://github.com/org/${repo}.git`]);
    }
    process.env.PATH = `${shim}:${previousPath ?? ""}`;
    writeFileSync(join(dir, "home", "pool.json"), '{"ship":"pool-ship"}');
    assert.equal((await prepareShip(dir, { mode: "ship", tickets: ["C-1"] })).model, "pool-ship");
    writeFileSync(join(dir, "home", "pool.json"), "not json");
    assert.equal((await prepareShip(dir, { mode: "ship", tickets: ["C-1"], model: "explicit" })).model, "explicit");
    const prepared = await prepareShip(dir, { mode: "ship", tickets: ["B-1"] });
    assert.deepEqual(prepared.tickets, ["B-1"]);
    assert.deepEqual(Object.keys(prepared.plans), ["B-1"]);
    assert.deepEqual(prepared.parts.map((part) => part.branch), ["B-1"]);
    assert.deepEqual(prepared.parts.map((part) => part.pr), ["https://github.com/org/repo/pull/B-1"]);
    assert.equal(prepared.parts[0]?.remote, "https://github.com/org/repo-b.git");
    assert.equal(prepared.parts[0]?.observedHead, "a".repeat(40));
    assert.equal(prepared.model, "model-b");
    assert.match(prepared.prompt, /^\/skill:ship-worker B-1\./);
    await assert.rejects(() => prepareShip(dir, { mode: "ship", tickets: ["A-1", "B-1"] }), /exactly one/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
