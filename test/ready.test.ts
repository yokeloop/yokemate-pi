import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ready, recipeFor, type ReadyReceipt } from "../src/ready.ts";
import { git, stand } from "./fixtures/gate-stand.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function installInto(worktree: string): void {
  mkdirSync(join(worktree, "node_modules", "typescript"), { recursive: true });
  writeFileSync(join(worktree, "node_modules", "typescript", "package.json"), '{ "name": "typescript", "version": "7.0.2" }');
  mkdirSync(join(worktree, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(worktree, "node_modules", ".bin", "tsc"), "#!/bin/sh\n");
}

const ownEnvironment = (_command: string[], cwd: string) => {
  installInto(cwd);
  return { exit: 0, output: "" };
};

test("recipeFor maps each lockfile to its frozen install and blocks the rest", () => {
  const dir = mkdtempSync(join(tmpdir(), "ready-recipe-"));
  try {
    assert.match((recipeFor(dir) as { blocker: string }).blocker, /^no lockfile/);
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    assert.deepEqual(recipeFor(dir), { manager: "pnpm", lockfile: "pnpm-lock.yaml", command: ["pnpm", "install", "--frozen-lockfile", "--prod=false"] });
    writeFileSync(join(dir, "package-lock.json"), "");
    assert.match((recipeFor(dir) as { blocker: string }).blocker, /^several lockfiles \(pnpm-lock.yaml, package-lock.json\)/);
    rmSync(join(dir, "pnpm-lock.yaml"));
    assert.deepEqual(recipeFor(dir), { manager: "npm", lockfile: "package-lock.json", command: ["npm", "ci"] });
    rmSync(join(dir, "package-lock.json"));
    writeFileSync(join(dir, "yarn.lock"), "");
    assert.deepEqual(recipeFor(dir), { manager: "yarn", lockfile: "yarn.lock", command: ["yarn", "install", "--immutable"] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a poisoned ancestor node_modules does not make the worktree ready", () => {
  const s = stand();
  try {
    installInto(s.root);
    const out = ready(s.root, s.ticket, [{ repo: s.repo, worktree: s.worktree }], { run: () => ({ exit: 0, output: "" }) });
    assert.equal(out.ok, false);
    assert.match(out.ok ? "" : out.reason, /^org\/repo: tsc is not in /);
    assert.equal(existsSync(join(s.root, "work", s.ticket, "ready.json")), false);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("the worktree's own environment yields a receipt", () => {
  const s = stand();
  try {
    const out = ready(s.root, s.ticket, [{ repo: s.repo, worktree: s.worktree }], { run: ownEnvironment });
    assert.ok(out.ok);
    const entry = out.receipt.parts["org/repo"]!;
    assert.equal(entry.bins.tsc, join(s.worktree, "node_modules", ".bin", "tsc"));
    assert.ok(entry.packages.typescript!.startsWith(join(realpathSync(s.worktree), "node_modules") + "/"));
    assert.equal(entry.head, git(s.worktree, "rev-parse", "HEAD"));
    assert.equal(entry.lockHash, sha256(join(s.worktree, "pnpm-lock.yaml")));
    assert.equal(entry.command, "pnpm install --frozen-lockfile --prod=false");
    assert.equal(entry.exit, 0);
    const written = JSON.parse(readFileSync(join(s.root, "work", s.ticket, "ready.json"), "utf8")) as ReadyReceipt;
    assert.deepEqual(written, out.receipt);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("a lockfile mismatch blocks with the literal output and no second install", () => {
  const s = stand();
  try {
    writeFileSync(join(s.root, "work", s.ticket, "ready.json"), "{}");
    let calls = 0;
    const out = ready(s.root, s.ticket, [{ repo: s.repo, worktree: s.worktree }], { run: () => { calls++; return { exit: 1, output: "ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile" }; } });
    assert.equal(out.ok, false);
    assert.equal(out.ok ? "" : out.reason, "org/repo: pnpm install --frozen-lockfile --prod=false exited 1");
    assert.match(out.ok ? "" : out.output, /ERR_PNPM_OUTDATED_LOCKFILE/);
    assert.equal(calls, 1);
    assert.equal(existsSync(join(s.root, "work", s.ticket, "ready.json")), false);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("a changed lockfile on a repeated call installs again and rewrites the receipt", async () => {
  const s = stand();
  try {
    const first = ready(s.root, s.ticket, [{ repo: s.repo, worktree: s.worktree }], { run: ownEnvironment });
    assert.ok(first.ok);
    await new Promise((done) => setTimeout(done, 5));
    writeFileSync(join(s.worktree, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nchanged: true\n");
    git(s.worktree, "commit", "-am", "lock");
    let calls = 0;
    const second = ready(s.root, s.ticket, [{ repo: s.repo, worktree: s.worktree }], { run: (command, cwd) => { calls++; return ownEnvironment(command, cwd); } });
    assert.ok(second.ok);
    assert.equal(calls, 1);
    const [a, b] = [first.receipt.parts["org/repo"]!, second.receipt.parts["org/repo"]!];
    assert.notEqual(b.lockHash, a.lockHash);
    assert.notEqual(b.head, a.head);
    assert.ok(b.at > a.at);
    assert.deepEqual(JSON.parse(readFileSync(join(s.root, "work", s.ticket, "ready.json"), "utf8")), second.receipt);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("ready leaves the engineer's changes byte for byte", () => {
  const s = stand();
  try {
    writeFileSync(join(s.worktree, "note.txt"), "untracked\n");
    writeFileSync(join(s.worktree, "package.json"), '{ "name": "repo", "devDependencies": { "typescript": "7.0.2" }, "edited": true }\n');
    const before = { note: readFileSync(join(s.worktree, "note.txt")), pkg: readFileSync(join(s.worktree, "package.json")), status: git(s.worktree, "status", "--porcelain") };
    const out = ready(s.root, s.ticket, [{ repo: s.repo, worktree: s.worktree }], { run: ownEnvironment });
    assert.ok(out.ok);
    assert.deepEqual(readFileSync(join(s.worktree, "note.txt")), before.note);
    assert.deepEqual(readFileSync(join(s.worktree, "package.json")), before.pkg);
    assert.equal(git(s.worktree, "status", "--porcelain").split("\n").filter((line) => !line.includes("node_modules")).join("\n"), before.status);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("a broken second part blocks the whole receipt", () => {
  const s = stand();
  try {
    const other = join(s.root, "work", s.ticket, "other");
    git(s.clone, "worktree", "add", other, "-b", "YM-10");
    const out = ready(s.root, s.ticket, [{ repo: s.repo, worktree: s.worktree }, { repo: "org/other", worktree: other }], { run: ownEnvironment });
    assert.equal(out.ok, false);
    assert.equal(out.ok ? "" : out.reason, "org/other: worktree is on YM-10, not YM-9");
    assert.equal(existsSync(join(s.root, "work", s.ticket, "ready.json")), false);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("pnpm ready refuses an unrecorded ticket before any install", () => {
  const shim = mkdtempSync(join(tmpdir(), "ready-cli-"));
  try {
    const argvFile = join(shim, "argv");
    writeFileSync(join(shim, "pnpm"), `#!/bin/sh\necho "$@" > ${argvFile}\nexit 7\n`);
    chmodSync(join(shim, "pnpm"), 0o755);
    const out = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/ready.ts", "YM-0"], { cwd: repoRoot, env: { PATH: shim }, encoding: "utf8" });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /YM-0 is unrecorded/);
    assert.equal(existsSync(argvFile), false);
    assert.equal(existsSync(join(repoRoot, "work", "YM-0")), false);
    const usage = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/ready.ts"], { cwd: repoRoot, env: { PATH: shim }, encoding: "utf8" });
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /usage: ready/);
  } finally { rmSync(shim, { recursive: true, force: true }); }
});
