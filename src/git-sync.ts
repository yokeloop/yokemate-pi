// Two roots, two modes. The engine is public and updates from upstream one
// way only — pullFastForward refuses to merge and says so. The engineer's data
// — journal, knowledge, notes, projects.json, all under SYNC_PATHS in home/ —
// peers between their machines: syncPush commits and pushes it after a
// state-changing command, syncPull refreshes it at session start and pushes
// what an offline session left behind. The move-log contract holds throughout:
// no sync failure may fail the command that did the real work — every problem
// is one line on stderr, exit 0.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
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

function ownGitDir(root: string): string | undefined {
  if (!existsSync(join(root, ".git"))) return;
  try {
    const value = git(root, "rev-parse", "--git-common-dir").trim();
    return realpathSync(isAbsolute(value) ? value : resolve(root, value));
  } catch { return; }
}

export function gitMutationLockPath(root: string): string {
  return join(ownGitDir(root) ?? root, "yokemate-home-git.lock");
}

function lockedPayload(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString("base64"); }
function runLockedSync(root: string, action: string, value: unknown): ExactSyncResult {
  const lock = gitMutationLockPath(root);
  mkdirSync(dirname(lock), { recursive: true });
  const output = execFileSync("flock", ["--exclusive", lock, process.execPath, "--experimental-strip-types", "--no-warnings", import.meta.filename, "--locked", action, lockedPayload(value)], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: TIMEOUT_MS });
  return JSON.parse(output) as ExactSyncResult;
}

const runLockedAsync = (root: string, action: string, value: unknown): Promise<ExactSyncResult> => new Promise((resolvePromise, reject) => {
  const lock = gitMutationLockPath(root);
  mkdirSync(dirname(lock), { recursive: true });
  execFile("flock", ["--exclusive", lock, process.execPath, "--experimental-strip-types", "--no-warnings", import.meta.filename, "--locked", action, lockedPayload(value)], { cwd: root, encoding: "utf8", timeout: TIMEOUT_MS }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolvePromise(JSON.parse(stdout) as ExactSyncResult));
});

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

function reconcileFetched(root: string): ExactSyncResult {
  try {
    if (git(root, "status", "--porcelain").trim()) return { state: "deferred", reason: "remote reconcile deferred: worktree or index is dirty" };
    git(root, "rebase", "FETCH_HEAD");
    return { state: "unchanged" };
  } catch (error) {
    try { git(root, "rebase", "--abort"); } catch {}
    return { state: "deferred", reason: error instanceof Error ? error.message : String(error) };
  }
}

function commitPaths(root: string, message: string, paths: readonly string[]): ExactSyncResult {
  try {
    const present = paths.filter((item) => existsSync(join(root, item)));
    if (!present.length) return { state: "unchanged" };
    git(root, "add", "--", ...present);
    try { git(root, "diff", "--cached", "--quiet"); return { state: "unchanged" }; } catch {}
    git(root, "commit", "-m", message);
    return { state: "committed", commit: git(root, "rev-parse", "HEAD").trim() };
  } catch (error) { return { state: "error", reason: error instanceof Error ? error.message : String(error) }; }
}

export async function pushWithRetryAsync(root: string): Promise<ExactSyncResult> {
  try { await gitAsync(root, ["push"]); return { state: "committed", commit: (await gitAsync(root, ["rev-parse", "HEAD"])).trim() }; }
  catch {}
  for (let index = 0; index < PUSH_RETRIES; index++) {
    try { await gitAsync(root, ["fetch", "origin"]); }
    catch { return { state: "deferred", reason: "push deferred: network fetch failed" }; }
    const reconciled = await runLockedAsync(root, "reconcile", { root });
    if (reconciled.state === "deferred" || reconciled.state === "error") return reconciled;
    try {
      await gitAsync(root, ["push"]);
      return { state: "committed", commit: (await gitAsync(root, ["rev-parse", "HEAD"])).trim() };
    } catch {}
  }
  return { state: "error", reason: `push не прошёл за ${PUSH_RETRIES} попытки` };
}

function pushWithRetry(root: string): void {
  try { git(root, "push"); return; } catch {}
  for (let index = 0; index < PUSH_RETRIES; index++) {
    try { git(root, "fetch", "origin"); }
    catch { note("push отложен: нет сети"); return; }
    const reconciled = runLockedSync(root, "reconcile", { root });
    if (reconciled.state === "deferred" || reconciled.state === "error") { note(reconciled.reason ?? "конфликт, разбери руками"); return; }
    try { git(root, "push"); return; } catch {}
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
    const committed = runLockedSync(root, "commit", { root, message, paths });
    if (committed.state === "error" || committed.state === "deferred") { note(committed.reason ?? "local sync deferred"); return; }
    if (committed.state === "committed") pushWithRetry(root);
  } catch (e) { note(e instanceof Error ? e.message : String(e)); }
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
    try { git(root, "fetch", "origin"); }
    catch { note("pull пропущен: нет сети"); return; }
    const reconciled = runLockedSync(root, "reconcile", { root });
    if (reconciled.state === "deferred" || reconciled.state === "error") { note(reconciled.reason ?? "конфликт, разбери руками"); return; }
    const ahead = git(root, "rev-list", "--count", "@{u}..HEAD").trim();
    if (ahead !== "0") pushWithRetry(root);
  } catch (e) { note(e instanceof Error ? e.message : String(e)); }
}

if (import.meta.filename === process.argv[1]) {
  if (process.argv[2] === "--locked") {
    try {
      const action = process.argv[3];
      const payload = JSON.parse(Buffer.from(process.argv[4] ?? "", "base64").toString("utf8")) as { root: string; message?: string; paths?: string[] };
      const result = action === "reconcile" ? reconcileFetched(payload.root) : action === "commit" ? commitPaths(payload.root, payload.message ?? "sync", payload.paths ?? SYNC_PATHS) : { state: "error" as const, reason: `unknown locked git action ${action}` };
      process.stdout.write(JSON.stringify(result));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } else {
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
}
