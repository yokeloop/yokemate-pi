import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { parseAffected } from "./adopt.ts";
import { openDb } from "./db.ts";

export interface ReadyPart { repo: string; worktree: string }
export interface Recipe { manager: "pnpm" | "npm" | "yarn"; lockfile: string; command: string[] }
export interface ReadyEntry { worktree: string; branch: string; head: string; lockfile: string; lockHash: string; manifestHash: string; command: string; exit: number; bins: Record<string, string>; packages: Record<string, string>; at: string }
export interface ReadyReceipt { ticket: string; parts: Record<string, ReadyEntry> }
export interface ReadyDeps { run(command: string[], cwd: string): { exit: number; output: string } }

const RECIPES: Recipe[] = [
  { manager: "pnpm", lockfile: "pnpm-lock.yaml", command: ["pnpm", "install", "--frozen-lockfile", "--prod=false"] },
  { manager: "npm", lockfile: "package-lock.json", command: ["npm", "ci"] },
  { manager: "yarn", lockfile: "yarn.lock", command: ["yarn", "install", "--immutable"] },
];

const TOOLS: { pkg: string; bin: string }[] = [{ pkg: "typescript", bin: "tsc" }];

export function recipeFor(worktree: string): Recipe | { blocker: string } {
  const found = RECIPES.filter((recipe) => existsSync(join(worktree, recipe.lockfile)));
  if (found.length > 1) return { blocker: `several lockfiles (${found.map((recipe) => recipe.lockfile).join(", ")})` };
  if (found.length === 0) return { blocker: "no lockfile — a project without a locked dependency graph cannot be made ready" };
  return found[0]!;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function porcelain(worktree: string): string[] {
  return git(worktree, "status", "--porcelain").split("\n").filter((line) => line && !/^.. "?node_modules\//.test(line));
}

const defaultRun: ReadyDeps["run"] = (command, cwd) => {
  const out = spawnSync(command[0]!, command.slice(1), { cwd, encoding: "utf8", env: process.env });
  return { exit: out.status ?? 1, output: `${out.stdout ?? ""}${out.stderr ?? ""}${out.error ? out.error.message : ""}` };
};

type PartOutcome = { ok: true; entry: ReadyEntry } | { ok: false; reason: string; output: string };

function readyPart(ticket: string, part: ReadyPart, run: ReadyDeps["run"]): PartOutcome {
  const blocked = (reason: string, output = ""): PartOutcome => ({ ok: false, reason: `${part.repo}: ${reason}`, output });
  const worktree = part.worktree;
  if (!existsSync(worktree)) return blocked(`no worktree ${worktree} — git worktree add first`);
  let top: string;
  try { top = realpathSync(git(worktree, "rev-parse", "--show-toplevel")); } catch { return blocked(`${worktree} is not a repository worktree`); }
  if (top !== realpathSync(worktree)) return blocked(`${worktree} is not a repository worktree`);
  const branch = git(worktree, "rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== ticket) return blocked(`worktree is on ${branch}, not ${ticket}`);
  const head = git(worktree, "rev-parse", "HEAD");

  const recipe = recipeFor(worktree);
  if ("blocker" in recipe) return blocked(recipe.blocker);
  const manifest = join(worktree, "package.json");
  if (!existsSync(manifest)) return blocked(`no package.json in ${worktree}`);
  const lockfile = join(worktree, recipe.lockfile);
  const manifestHash = sha256(manifest);
  const lockHash = sha256(lockfile);
  const statusBefore = porcelain(worktree);

  const command = recipe.command.join(" ");
  const installed = run(recipe.command, worktree);
  if (installed.exit !== 0) return blocked(`${command} exited ${installed.exit}`, installed.output);

  if (sha256(lockfile) !== lockHash) return blocked(`bootstrap modified ${recipe.lockfile}`, installed.output);
  if (sha256(manifest) !== manifestHash) return blocked("bootstrap modified package.json", installed.output);

  const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const bins: Record<string, string> = {};
  const packages: Record<string, string> = {};
  const modules = join(worktree, "node_modules");
  for (const tool of TOOLS) {
    if (!pkg.dependencies?.[tool.pkg] && !pkg.devDependencies?.[tool.pkg]) continue;
    const bin = join(modules, ".bin", tool.bin);
    if (!existsSync(bin)) return blocked(`${tool.bin} is not in ${join(modules, ".bin")}`, installed.output);
    let resolved: string;
    try {
      resolved = realpathSync(createRequire(manifest).resolve(`${tool.pkg}/package.json`));
    } catch {
      return blocked(`${tool.pkg} does not resolve from ${worktree}`, installed.output);
    }
    if (!existsSync(modules) || !resolved.startsWith(realpathSync(modules) + sep))
      return blocked(`${tool.pkg} resolves to ${resolved}, outside the worktree's node_modules`, installed.output);
    bins[tool.bin] = bin;
    packages[tool.pkg] = dirname(resolved);
  }

  const statusAfter = porcelain(worktree);
  if (statusAfter.join("\n") !== statusBefore.join("\n")) {
    const changed = statusAfter.filter((line) => !statusBefore.includes(line)).concat(statusBefore.filter((line) => !statusAfter.includes(line)));
    return blocked(`bootstrap changed the working tree: ${changed.join("; ")}`, installed.output);
  }

  return { ok: true, entry: { worktree, branch, head, lockfile: recipe.lockfile, lockHash, manifestHash, command, exit: installed.exit, bins, packages, at: new Date().toISOString() } };
}

export function ready(root: string, ticket: string, parts: ReadyPart[], deps: Partial<ReadyDeps> = {}): { ok: true; receipt: ReadyReceipt } | { ok: false; reason: string; output: string } {
  const file = join(root, "work", ticket, "ready.json");
  const receipt: ReadyReceipt = { ticket, parts: {} };
  for (const part of parts) {
    const out = readyPart(ticket, part, deps.run ?? defaultRun);
    if (!out.ok) {
      rmSync(file, { force: true });
      return out;
    }
    receipt.parts[part.repo] = out.entry;
  }
  writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n");
  return { ok: true, receipt };
}

if (import.meta.filename === process.argv[1]) {
  const ticket = process.argv.slice(2).filter((a) => a !== "--")[0];
  if (!ticket) {
    console.error("usage: ready <TICKET>");
    process.exit(1);
  }
  const root = resolve(new URL("..", import.meta.url).pathname);
  const dbPath = join(root, "yokemate.db");
  const db = existsSync(dbPath) ? openDb(dbPath) : null;
  const work = db?.prepare("SELECT stage, plan FROM work WHERE ticket = ?").get(ticket) as { stage: string; plan: string | null } | undefined;
  if (!db || !work || (work.stage !== "running" && work.stage !== "review")) {
    console.error(`ready: ${ticket} is ${work?.stage ?? "unrecorded"} — spawn or adopt first`);
    process.exit(1);
  }
  try {
    if (!work.plan || !existsSync(work.plan)) throw new Error(`${ticket}: the work row names no readable plan`);
    const parts: ReadyPart[] = parseAffected(readFileSync(work.plan, "utf8")).map((planned) => {
      const [org, repo] = planned.repo.includes("/") ? planned.repo.split("/", 2) : [null, planned.repo];
      const rows = (org
        ? db.prepare("SELECT org, repo, path FROM project WHERE org = ? AND repo = ?").all(org, repo)
        : db.prepare("SELECT org, repo, path FROM project WHERE repo = ?").all(repo)) as unknown as { org: string; repo: string }[];
      if (rows.length !== 1) throw new Error(`${ticket}: ${planned.repo} has ${rows.length} passports`);
      return { repo: `${rows[0]!.org}/${rows[0]!.repo}`, worktree: join(root, "work", ticket, rows[0]!.repo) };
    });
    const out = ready(root, ticket, parts);
    if (!out.ok) {
      console.error(`ready: ${out.reason}`);
      if (out.output) console.error(out.output);
      process.exit(1);
    }
    for (const part of parts) {
      const entry = out.receipt.parts[part.repo]!;
      const tools = Object.entries(entry.bins).map(([bin, path]) => `, ${bin} → ${path}`).join("");
      console.log(`${part.repo} ready: ${entry.command} exit ${entry.exit}${tools}, head ${entry.head.slice(0, 7)}`);
    }
  } catch (e) {
    console.error(`ready: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
