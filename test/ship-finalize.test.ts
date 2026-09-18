import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { finalizeShip } from "../src/ship-finalize.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });

test("parent ship finalization appends, commits, pushes and cleans exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "ship-finalize-"));
  const home = join(root, "home");
  const remote = join(root, "remote.git");
  mkdirSync(home, { recursive: true });
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  git(home, "init");
  git(home, "config", "user.email", "test@example.com");
  git(home, "config", "user.name", "Test");
  writeFileSync(join(home, "projects.json"), "[]\n");
  git(home, "add", "projects.json");
  git(home, "commit", "-m", "initial");
  git(home, "remote", "add", "origin", remote);
  git(home, "push", "-u", "origin", "HEAD");
  mkdirSync(join(root, "work", "YM-1"), { recursive: true });
  const first = await finalizeShip(root, "YM-1");
  const second = await finalizeShip(root, "YM-1");
  assert.equal(first.cleanup, "removed");
  assert.equal(second.cleanup, "already_absent");
  assert.equal(second.journal.repeated, true);
  const text = readdirSync(join(home, "journal")).map((name) => readFileSync(join(home, "journal", name), "utf8")).join("\n");
  assert.equal(text.match(/YM-1 отгружено/g)?.length, 1);
  assert.equal(git(home, "status", "--porcelain"), null);
});
