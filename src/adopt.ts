// Rebuild a ticket's review stand on a machine where /do never ran. Everything
// is recovered from observable facts: the plan rides git in knowledge/, the
// branches are always named <KEY> (do-worker's contract), the PRs answer to
// `gh pr list --head <KEY>`. The command assembles work/<KEY>/ worktrees from
// the PR branches and upserts the work row straight into `review` — the same
// row record-report would have written here. The review pane calls it itself
// when the stand is missing; the unstamped main chat is the repair entry.
// Adoption does not confirm the runtime — the review pane runs `pnpm ready <KEY>`
// next; the row is in `review`, the environment is not proven until the receipt exists.
//
// Usage: pnpm adopt ACME-347

import { execFileSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { dataRoot as dataRootOf } from "./data-root.ts";
import { openDb } from "./db.ts";
import { syncPull } from "./git-sync.ts";
import { ticketUrl } from "./ticket-url.ts";
import { applyMove, checkMove, type From, type MoveEnv } from "./transitions.ts";

/** The ticket's plan in knowledge/<org>/<project>/ai/<slug>/, by the slug's
 *  key prefix. Old slugs are lowercase (`acme-326-…` for ACME-326), so the match
 *  ignores case. Several hits — a rework plan lives beside the base plan —
 *  resolve to the file named after its folder. */
export function findPlan(dataRoot: string, key: string): string | null {
  const prefix = `${key.toLowerCase()}-`;
  const hits = globSync(join(dataRoot, "knowledge", "*", "*", "ai", "*", "*-plan.md")).filter((p) =>
    basename(p).toLowerCase().startsWith(prefix),
  );
  if (hits.length === 0) return null;
  return hits.sort().find((p) => basename(p) === `${basename(dirname(p))}-plan.md`) ?? hits[0];
}

export interface PlanPart {
  repo: string;
  role: string;
  /** The line named no role; `app` was assumed (PLAN-FORMAT promises a role,
   *  but a degraded line must not fail the transfer). */
  roleAssumed: boolean;
}

/** Parse the plan's `## Affected repositories` lines: `` - `org/repo` … — <role> ``. */
export function parseAffected(md: string): PlanPart[] {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^##\s+Affected repositories\s*$/.test(l));
  if (start === -1) return [];
  const parts: PlanPart[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) break;
    const item = lines[i].match(/^\s*[-*]\s+(.+)$/);
    if (!item) continue;
    const body = item[1];
    const ticked = body.match(/`([^`\s]+)`/);
    const repo = (ticked ? ticked[1] : body.split(/\s/)[0]).replace(/[.,;:]+$/, "");
    const tail = body.split(/\s+—\s+/).slice(1).join(" — ").replace(/`/g, "");
    const role = tail.match(/\b(library|app|backend)\b/)?.[1];
    parts.push({ repo, role: role ?? "app", roleAssumed: !role });
  }
  return parts;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Open PRs for the branch, asked in the clone so its own origin answers —
 *  the passport's org is a normalized label, not necessarily the GitHub org. */
function ghOpenPrs(clonePath: string, key: string): string[] {
  const out = execFileSync("gh", ["pr", "list", "--head", key, "--state", "open", "--json", "url"], {
    cwd: clonePath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return (JSON.parse(out) as { url: string }[]).map((p) => p.url);
}

export interface AdoptDeps {
  pull: (root: string) => void;
  listPrs: (clonePath: string, key: string) => string[];
}

export interface AdoptedPart {
  repo: string;
  role: string;
  pr: string;
}

export interface AdoptOutcome {
  repeat: boolean;
  planPath: string;
  parts: AdoptedPart[];
}

export function adopt(
  root: string,
  dataRoot: string,
  key: string,
  env: MoveEnv,
  deps: Partial<AdoptDeps> = {},
): AdoptOutcome {
  (deps.pull ?? syncPull)(dataRoot);

  const planPath = findPlan(dataRoot, key);
  if (!planPath)
    throw new Error(`${key}: плана в knowledge нет — он не запушен с dev-машины или тикет не планировался`);
  const planned = parseAffected(readFileSync(planPath, "utf8"));
  if (planned.length === 0)
    throw new Error(`${key}: в плане ${planPath} нет секции Affected repositories — переносить нечего`);

  const db = openDb(join(root, "yokemate.db"));
  // Pre-flight before any git side effect: a move the stage machine would
  // refuse must not leave worktrees behind — a standing folder would mask the
  // adopt instruction on the next /review while the row stays unmovable. The
  // authoritative compare-and-set still happens inside applyMove below.
  const current: From =
    (db.prepare("SELECT stage FROM work WHERE ticket = ?").get(key) as { stage: From } | undefined)
      ?.stage ?? "absent";
  const pre = checkMove("adopt", env, key, current);
  if (!pre.ok) throw new Error(pre.refuse);

  const folder = join(root, "work", key);
  const parts: AdoptedPart[] = [];
  for (const part of planned) {
    const [org, repo] = part.repo.includes("/") ? part.repo.split("/", 2) : [null, part.repo];
    const rows = (
      org
        ? db.prepare("SELECT org, repo, path FROM project WHERE org = ? AND repo = ?").all(org, repo)
        : db.prepare("SELECT org, repo, path FROM project WHERE repo = ?").all(repo)
    ) as unknown as { org: string; repo: string; path: string }[];
    if (rows.length === 0)
      throw new Error(`${key}: паспорта ${part.repo} нет — восстанови клоны и паспорта: pnpm import-projects`);
    if (rows.length > 1)
      throw new Error(
        `${key}: ${part.repo} есть в нескольких организациях (${rows.map((r) => r.org).join(", ")}) — назови org/repo в плане`,
      );
    const passport = rows[0];
    const fullRepo = `${passport.org}/${passport.repo}`;
    if (part.roleAssumed)
      console.error(`adopt: строка ${part.repo} в плане не называет роль — записана app`);

    try {
      git(passport.path, "fetch", "origin", key);
    } catch (e) {
      // Only a missing ref means the branch is not there; offline or a broken
      // remote is its own diagnosis — the transfer report must stay honest.
      const stderr = String((e as { stderr?: unknown }).stderr ?? "").trim();
      if (/couldn't find remote ref/.test(stderr))
        throw new Error(`${key}: PR-ветки ${key} в ${fullRepo} нет — /do не доехал или ветка названа иначе`);
      const line = stderr.split("\n").filter(Boolean).pop() ?? (e as Error).message;
      throw new Error(`${key}: git fetch origin ${key} в ${fullRepo} не прошёл — ${line}`);
    }

    const worktree = join(folder, passport.repo);
    if (!existsSync(worktree)) {
      let local = true;
      try {
        git(passport.path, "show-ref", "--verify", "--quiet", `refs/heads/${key}`);
      } catch {
        local = false;
      }
      if (local) git(passport.path, "worktree", "add", worktree, key);
      else git(passport.path, "worktree", "add", "--track", "-b", key, worktree, `origin/${key}`);
    }

    const prs = (deps.listPrs ?? ghOpenPrs)(passport.path, key);
    if (prs.length === 0)
      throw new Error(`${key}: открытого PR по ветке ${key} в ${fullRepo} нет — /do не доехал или ветка названа иначе`);
    parts.push({ repo: fullRepo, role: part.role, pr: prs[0] });
  }

  // ticketUrl falls back to ticket:<KEY> when the tracker is unknown; a root
  // with no .env.local at all deserves the same fallback, not a failure.
  let url: string;
  try {
    url = ticketUrl(db, key);
  } catch {
    url = `ticket:${key}`;
  }
  const out = applyMove(db, "adopt", env, key, () => {
    db.prepare(
      `INSERT INTO work (ticket, url, stage, folder, plan, pr)
       VALUES (?, ?, 'review', ?, ?, ?)
       ON CONFLICT (ticket) DO UPDATE SET stage = 'review', folder = excluded.folder,
         plan = excluded.plan, pr = excluded.pr, updated_at = datetime('now')`,
    ).run(key, url, folder, planPath, parts.map((p) => p.pr).join(" "));
    const work = db.prepare("SELECT id FROM work WHERE ticket = ?").get(key) as { id: number };
    db.prepare("DELETE FROM part WHERE work_id = ?").run(work.id);
    const ins = db.prepare("INSERT INTO part (work_id, repo, role, branch, pr) VALUES (?, ?, ?, ?, ?)");
    for (const p of parts) ins.run(work.id, p.repo, p.role, key, p.pr);
  }, { expected: current });
  if (!out.ok) throw new Error(out.refuse);
  return { repeat: out.repeat, planPath, parts };
}

if (import.meta.filename === process.argv[1]) {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const key = argv[0];
  if (!key) {
    console.error("usage: adopt <TICKET>");
    process.exit(1);
  }
  const root = resolve(new URL("..", import.meta.url).pathname);
  try {
    const out = adopt(root, dataRootOf(root), key, process.env as MoveEnv);
    console.log(
      `${key} adopted${out.repeat ? " (repeat)" : ""}: ${out.parts.length} part(s), stage review, folder work/${key} — run pnpm ready ${key} before the stand`,
    );
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
