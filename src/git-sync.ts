// Two roots, two modes. The engine is public and updates from upstream one
// way only — pullFastForward refuses to merge and says so. The engineer's data
// — journal, knowledge, notes, projects.json, all under SYNC_PATHS in home/ —
// peers between their machines: syncPush commits and pushes it after a
// state-changing command, syncPull refreshes it at session start and pushes
// what an offline session left behind. The move-log contract holds throughout:
// no sync failure may fail the command that did the real work — every problem
// is one line on stderr, exit 0.
import { execFileSync } from "node:child_process";
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
    if (existsSync(data)) syncPull(data);
    else note("home/ нет — личные данные не подняты: см. scripts/bootstrap.sh");
  } else {
    console.error("usage: git-sync.ts pull");
    process.exit(1);
  }
}
