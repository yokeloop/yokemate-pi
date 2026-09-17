// Two roots, two modes. The engine is public and updates from upstream one
// way only — pullFastForward refuses to merge and says so. The engineer's data
// — journal, knowledge, notes, projects.json, all under SYNC_PATHS in home/ —
// peers between their machines: syncPush commits and pushes it after a
// state-changing command, syncPull refreshes it at session start and pushes
// what an offline session left behind. The move-log contract holds throughout:
// no sync failure may fail the command that did the real work — every problem
// is one line on stderr, exit 0.
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dataRoot } from "./data-root.ts";

const SYNC_PATHS = ["journal", "knowledge", "notes", "projects.json"];
const TIMEOUT_MS = 10_000;
const PUSH_RETRIES = 3;

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: TIMEOUT_MS,
  });
}

function note(msg: string): void {
  console.error(`git-sync: ${msg}`);
}

function pullRebase(root: string): "ok" | "offline" | "conflict" {
  try {
    git(root, "pull", "--rebase", "--autostash");
    return "ok";
  } catch {
    try {
      git(root, "rebase", "--abort");
      return "conflict";
    } catch {
      return "offline";
    }
  }
}

export interface ExactSyncResult { state: "committed" | "unchanged" | "skipped" | "deferred" | "error"; commit?: string; reason?: string }

export function commitExact(root: string, message: string, paths: readonly string[]): ExactSyncResult {
  if (!existsSync(join(root, ".git"))) return { state: "skipped", reason: `${root} — не свой git-репозиторий` };
  try {
    const present = paths.filter((item) => existsSync(join(root, item)));
    if (!present.length) return { state: "unchanged" };
    const staged = git(root, "diff", "--cached", "--name-only", "--", ...present).trim();
    if (staged) return { state: "deferred", reason: `target already staged: ${staged.replaceAll("\n", ", ")}` };
    git(root, "add", "--", ...present);
    try { git(root, "diff", "--cached", "--quiet", "--", ...present); return { state: "unchanged" }; } catch {}
    git(root, "commit", "--only", "-m", message, "--", ...present);
    return { state: "committed", commit: git(root, "rev-parse", "HEAD").trim() };
  } catch (error) { return { state: "error", reason: error instanceof Error ? error.message : String(error) }; }
}

const gitAsync = (root: string, args: string[]): Promise<string> => new Promise((resolvePromise, reject) => execFile("git", ["-C", root, ...args], { encoding: "utf8", timeout: TIMEOUT_MS }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolvePromise(stdout)));

export async function pushWithRetryAsync(root: string): Promise<ExactSyncResult> {
  try { await gitAsync(root, ["push"]); return { state: "committed", commit: (await gitAsync(root, ["rev-parse", "HEAD"])).trim() }; }
  catch {}
  try {
    if ((await gitAsync(root, ["status", "--porcelain"])).trim()) return { state: "deferred", reason: "remote reconcile deferred: worktree or index is dirty" };
    for (let index = 0; index < PUSH_RETRIES; index++) {
      try {
        await gitAsync(root, ["pull", "--rebase"]);
        await gitAsync(root, ["push"]);
        return { state: "committed", commit: (await gitAsync(root, ["rev-parse", "HEAD"])).trim() };
      } catch {}
    }
    return { state: "error", reason: `push не прошёл за ${PUSH_RETRIES} попытки` };
  } catch (error) { return { state: "deferred", reason: error instanceof Error ? error.message : String(error) }; }
}

function pushWithRetry(root: string): void {
  for (let i = 0; i < PUSH_RETRIES; i++) {
    switch (pullRebase(root)) {
      case "conflict":
        note("конфликт, разбери руками");
        return;
      case "offline":
        note("push отложен: нет сети");
        return;
    }
    try {
      git(root, "push");
      return;
    } catch {}
  }
  note(`push не прошёл за ${PUSH_RETRIES} попытки`);
}

export function syncPush(
  root: string,
  message: string,
  paths: readonly string[] = SYNC_PATHS,
): void {
  if (!existsSync(join(root, ".git"))) {
    note(`${root} — не свой git-репозиторий, синк пропущен`);
    return;
  }
  try {
    const present = paths.filter((p) => existsSync(join(root, p)));
    if (present.length === 0) return;
    git(root, "add", "--", ...present);
    try {
      git(root, "diff", "--cached", "--quiet");
      return;
    } catch {}
    git(root, "commit", "-m", message);
    pushWithRetry(root);
  } catch (e) {
    note(e instanceof Error ? e.message : String(e));
  }
}

export function pullFastForward(root: string): void {
  try {
    git(root, "pull", "--ff-only");
  } catch {
    note("движок разошёлся с апстримом: git pull --ff-only не прошёл, разбери руками");
  }
}

export function syncPull(root: string): void {
  if (!existsSync(join(root, ".git"))) {
    note(`${root} — не свой git-репозиторий, синк пропущен`);
    return;
  }
  try {
    switch (pullRebase(root)) {
      case "conflict":
        note("конфликт, разбери руками");
        return;
      case "offline":
        note("pull пропущен: нет сети");
        return;
    }
    const ahead = git(root, "rev-list", "--count", "@{u}..HEAD").trim();
    if (ahead !== "0") pushWithRetry(root);
  } catch (e) {
    note(e instanceof Error ? e.message : String(e));
  }
}

if (import.meta.filename === process.argv[1]) {
  if (process.env.YOKEMATE_MODE) process.exit(0);
  const root = join(import.meta.dirname, "..");
  if (process.argv[2] === "pull") {
    pullFastForward(root);
    const data = dataRoot(root);
    if (existsSync(join(data, ".git"))) syncPull(data);
    else note("home/ нет — личные данные не подняты: см. scripts/bootstrap.sh");
  } else {
    console.error("usage: git-sync.ts pull");
    process.exit(1);
  }
}
