import { execFile } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { mkdirSync, realpathSync } from "node:fs";
import { dataRoot } from "./data-root.ts";
import { openDb } from "./db.ts";
import { commitExact, gitMutationLockPath, pushWithRetryAsync, type ExactSyncResult } from "./git-sync.ts";
import { readRuntimeSettings } from "./guard-policy.ts";
import { logMoveDetailed } from "./move-log.ts";
import { ticketUrl } from "./ticket-url.ts";
import { applyMove, type MoveEnv } from "./transitions.ts";

export interface PlanRecordResult { ticket: string; plan: string; repeat: boolean; recorded: true; journal?: string; localSync: ExactSyncResult; push?: ExactSyncResult }

export function recordLockPath(root: string): string { return gitMutationLockPath(root); }

export function recordPlanCore(root: string, ticket: string, planPath: string, env: MoveEnv = process.env as MoveEnv): PlanRecordResult {
  const data = dataRoot(root);
  const plan = realpathSync(resolve(planPath));
  const dataRelative = relative(data, plan);
  if (dataRelative.startsWith("..") || isAbsolute(dataRelative)) throw new Error(`plan is outside the data root: ${plan}`);
  const settings = readRuntimeSettings(root);
  const db = openDb(join(root, "yokemate.db"));
  const prior = db.prepare("SELECT stage, plan FROM work WHERE ticket = ?").get(ticket) as { stage?: string; plan?: string | null } | undefined;
  const out = applyMove(db, "plan", env, ticket, () => {
    db.prepare(`INSERT INTO work (ticket, url, stage, plan) VALUES (?, ?, 'planned', ?) ON CONFLICT (ticket) DO UPDATE SET stage = 'planned', plan = excluded.plan, updated_at = datetime('now')`).run(ticket, ticketUrl(db, ticket), plan);
  }, { settings });
  if (!out.ok) throw new Error(out.refuse);
  const durableRepeat = out.repeat && prior?.plan && resolve(prior.plan) === plan;
  const logged = durableRepeat ? null : logMoveDetailed(data, ticket, "запланировано", `план ${basename(plan, ".md")}`);
  const targets = [dataRelative, ...(logged ? [relative(data, logged.path)] : [])];
  const localSync = durableRepeat ? { state: "unchanged" as const } : commitExact(data, `${ticket} план`, targets);
  return { ticket, plan, repeat: Boolean(durableRepeat), recorded: true, journal: logged?.path, localSync };
}

const run = (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string }> => new Promise((resolvePromise, reject) => execFile(file, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => error ? reject(Object.assign(new Error(stderr.trim() || error.message), { stdout, stderr })) : resolvePromise({ stdout, stderr })));

export async function recordPlan(root: string, ticket: string, planPath: string, env: NodeJS.ProcessEnv = process.env): Promise<PlanRecordResult> {
  const payload = Buffer.from(JSON.stringify({ root, ticket, planPath })).toString("base64");
  const lock = recordLockPath(dataRoot(root));
  mkdirSync(dirname(lock), { recursive: true });
  const result = await run("flock", ["--exclusive", lock, process.execPath, "--experimental-strip-types", "--no-warnings", new URL(import.meta.url).pathname, "--locked", payload], { cwd: root, env });
  const recorded = JSON.parse(result.stdout) as PlanRecordResult;
  if (recorded.localSync.state === "committed") recorded.push = await pushWithRetryAsync(dataRoot(root));
  return recorded;
}

if (import.meta.filename === process.argv[1] && process.argv[2] === "--locked") {
  try {
    const payload = JSON.parse(Buffer.from(process.argv[3] ?? "", "base64").toString("utf8")) as { root: string; ticket: string; planPath: string };
    process.stdout.write(JSON.stringify(recordPlanCore(payload.root, payload.ticket, payload.planPath)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
