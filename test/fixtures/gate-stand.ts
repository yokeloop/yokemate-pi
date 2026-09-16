import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb } from "../../src/db.ts";

const repoRoot = resolve(import.meta.dirname, "..", "..");

export interface RollupEntry { name?: string; workflowName?: string; status?: string; conclusion?: string | null }

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export interface Stand { root: string; clone: string; worktree: string; shim: string; ticket: string; repo: string }

export function stand(ticket = "YM-9"): Stand {
  const root = mkdtempSync(join(tmpdir(), "gate-stand-"));
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: ["ignore", "pipe", "pipe"] });
  const clone = join(root, "clones", "repo");
  execFileSync("git", ["clone", origin, clone], { stdio: ["ignore", "pipe", "pipe"] });
  git(clone, "config", "user.name", "test");
  git(clone, "config", "user.email", "test@test");
  git(clone, "config", "commit.gpgsign", "false");
  mkdirSync(join(clone, ".github", "workflows"), { recursive: true });
  for (const name of ["ci.yml", "telegram-notify.yml"])
    writeFileSync(join(clone, ".github", "workflows", name), readFileSync(join(repoRoot, ".github", "workflows", name)));
  writeFileSync(join(clone, "package.json"), '{ "name": "repo", "devDependencies": { "typescript": "7.0.2" } }\n');
  writeFileSync(join(clone, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  git(clone, "add", ".");
  git(clone, "commit", "-m", "seed");
  git(clone, "push", "-u", "origin", "main");
  const worktree = join(root, "work", ticket, "repo");
  git(clone, "worktree", "add", worktree, "-b", ticket);
  git(worktree, "commit", "--allow-empty", "-m", "work");
  git(worktree, "push", "-u", "origin", ticket);

  const plan = join(root, "home", "knowledge", "org", "repo", "ai", `${ticket}-work`, `${ticket}-work-plan.md`);
  mkdirSync(join(plan, ".."), { recursive: true });
  writeFileSync(plan, `# ${ticket}\n\n## Affected repositories\n- \`org/repo\` — app\n`);
  const db = openDb(join(root, "yokemate.db"));
  db.prepare("INSERT INTO project (org, repo, path, tracker, tracker_key, model) VALUES ('org','repo', ?, 'x', 'YM', 'test/model')").run(clone);

  const shim = join(root, "shim");
  mkdirSync(shim);
  writeFileSync(join(shim, "gh"), '#!/bin/sh\ncat "$GH_SHIM_DIR/$(basename "$3").json"\n');
  chmodSync(join(shim, "gh"), 0o755);
  return { root, clone, worktree, shim, ticket, repo: "org/repo" };
}

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function writeReceipt(s: Stand, overrides: Record<string, unknown> = {}): void {
  const entry = {
    worktree: s.worktree, branch: s.ticket, head: git(s.worktree, "rev-parse", "HEAD"), lockfile: "pnpm-lock.yaml",
    lockHash: sha256(join(s.worktree, "pnpm-lock.yaml")), manifestHash: sha256(join(s.worktree, "package.json")),
    command: "pnpm install --frozen-lockfile --prod=false", exit: 0,
    bins: { tsc: join(s.worktree, "node_modules", ".bin", "tsc") }, packages: { typescript: join(s.worktree, "node_modules", "typescript") },
    at: new Date().toISOString(), ...overrides,
  };
  writeFileSync(join(s.root, "work", s.ticket, "ready.json"), JSON.stringify({ ticket: s.ticket, parts: { [s.repo]: entry } }));
}

export const green = (name: string): RollupEntry => ({ name, workflowName: "ci", status: "COMPLETED", conclusion: "SUCCESS" });
export const notify: RollupEntry = { name: "notify / notify", workflowName: "telegram-notify", status: "COMPLETED", conclusion: "SUCCESS" };

export function writePr(s: Stand, file: string, rollup: RollupEntry[], overrides: Record<string, unknown> = {}): void {
  const snapshot = {
    url: "https://github.com/org/repo/pull/34", state: "OPEN", headRefName: s.ticket,
    headRefOid: git(s.worktree, "rev-parse", "HEAD"), baseRefName: "main", baseRefOid: git(s.clone, "rev-parse", "origin/main"),
    statusCheckRollup: rollup, ...overrides,
  };
  writeFileSync(join(s.shim, `${file}.json`), JSON.stringify(snapshot));
}

export async function withShim<T>(s: Stand, body: () => T | Promise<T>): Promise<T> {
  const previous = { PATH: process.env.PATH, GH_SHIM_DIR: process.env.GH_SHIM_DIR };
  process.env.PATH = `${s.shim}:${process.env.PATH ?? ""}`;
  process.env.GH_SHIM_DIR = s.shim;
  try {
    return await body();
  } finally {
    process.env.PATH = previous.PATH;
    if (previous.GH_SHIM_DIR === undefined) delete process.env.GH_SHIM_DIR; else process.env.GH_SHIM_DIR = previous.GH_SHIM_DIR;
  }
}
