import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, resolve, relative } from "node:path";
import { openDb } from "./db.ts";
import { dataRoot } from "./data-root.ts";
import { findPlan, parseAffected, type PlanPart } from "./adopt.ts";
import { modelForTicket } from "./project-model.ts";
import { poolModel } from "./pool.ts";
import { ticketUrl } from "./ticket-url.ts";
import { linkTeammates } from "./teammates.ts";
import { readRuntimeSettings, type RuntimeSettings } from "./guard-policy.ts";
import { applyMove, checkMove, type From, type MoveEnv } from "./transitions.ts";

export type CoordinatorMode = "do" | "ship";
export interface CoordinatorRequest { mode: CoordinatorMode; tickets: string[]; plan?: string; model?: string; note?: string }
export interface CoordinatorOrigin extends MoveEnv { sessionId?: string; runId?: string; cwd?: string; pane?: string; parentPane?: string }
export interface PreparedPart extends PlanPart { repo: string; org: string; path: string; passportPath?: string; figmaMcp?: string; figmaUrl?: string; branch: string; pr?: string; base?: string; remote?: string; observedHead?: string }
export interface PreparedCoordinator { doBinding?: import("./plan-binding.ts").PlanBinding; mode: CoordinatorMode; tickets: string[]; model: string; cwd: string; plan?: string; plans: Record<string, string>; parts: PreparedPart[]; prompt: string; skillsPath: string; resourcesPath: string; expected?: From }

const KEY = /^[A-Z][A-Z0-9]*-\d+$/;
const fail = (message: string): never => { throw new Error(message); };
const inside = (root: string, value: string): boolean => { const r = relative(root, resolve(value)); return r !== "" && !r.startsWith("..") && !r.includes("/../"); };

export function validateCoordinatorRequest(request: CoordinatorRequest): void {
  if (!request || typeof request !== "object" || Array.isArray(request)) fail("coordinator request must be an object");
  for (const key of Object.keys(request)) if (!["mode", "tickets", "plan", "model", "note"].includes(key)) fail(`unknown coordinator request field ${key}`);
  for (const key of ["plan", "model", "note"] as const) if (request[key] !== undefined && (typeof request[key] !== "string" || !request[key]!.trim())) fail(`coordinator ${key} must be a nonempty string`);
  if (request.mode !== "do" && request.mode !== "ship") fail(`unknown coordinator mode ${request.mode}`);
  if (!Array.isArray(request.tickets) || request.tickets.length === 0) fail(`${request.mode} needs at least one ticket`);
  if (new Set(request.tickets).size !== request.tickets.length) fail("ticket list contains duplicates");
  for (const ticket of request.tickets) if (typeof ticket !== "string" || !KEY.test(ticket) || ticket.includes("..")) fail(`invalid ticket key ${JSON.stringify(ticket)}`);
  if (request.plan && request.mode !== "do") fail("ship does not accept a plan override");
}

export function splitDoRequest(request: CoordinatorRequest): CoordinatorRequest[] {
  if (request.mode !== "do") return [request];
  if (!Array.isArray(request.tickets) || request.tickets.length === 0) fail("do needs at least one ticket");
  if (new Set(request.tickets).size !== request.tickets.length) fail("ticket list contains duplicates");
  return request.tickets.map((ticket) => ({ ...request, tickets: [ticket] }));
}

function resolvePlan(root: string, ticket: string, explicit?: string): string {
  const db = openDb(join(root, "yokemate.db"));
  const recorded = (db.prepare("SELECT plan FROM work WHERE ticket = ?").get(ticket) as { plan?: string | null } | undefined)?.plan;
  const candidate = explicit ?? recorded ?? findPlan(dataRoot(root), ticket);
  if (!candidate) fail(`${ticket} has no plan on record — write one with /plan, or pass --plan <path>`);
  const plan = resolve(candidate!);
  if (!existsSync(plan)) fail(`plan not found: ${plan}`);
  return plan;
}

function partsForPlan(root: string, ticket: string, plan: string): PreparedPart[] {
  const parts = parseAffected(readFileSync(plan, "utf8"));
  if (parts.length === 0) fail(`${ticket}: plan ${plan} has no Affected repositories`);
  const db = openDb(join(root, "yokemate.db"));
  return parts.map((part) => {
    const [org, repo] = part.repo.includes("/") ? part.repo.split("/", 2) : [undefined, part.repo];
    const rows = (org
      ? db.prepare("SELECT org, repo, path, figma_mcp, figma_url FROM project WHERE org = ? AND repo = ?").all(org, repo)
      : db.prepare("SELECT org, repo, path, figma_mcp, figma_url FROM project WHERE repo = ?").all(repo)) as unknown as { org: string; repo: string; path: string; figma_mcp: string | null; figma_url: string | null }[];
    if (rows.length !== 1) fail(rows.length ? `${ticket}: ${part.repo} is ambiguous — name org/repo in the plan` : `${ticket}: no passport for ${part.repo}`);
    const row = rows[0];
    return { ...part, repo: `${row.org}/${row.repo}`, org: row.org, path: row.path, figmaMcp: row.figma_mcp ?? undefined, figmaUrl: row.figma_url ?? undefined, branch: ticket };
  });
}

function settings(root: string, folder: string): void {
  mkdirSync(join(folder, ".pi"), { recursive: true });
  writeFileSync(join(folder, ".pi", "settings.json"), JSON.stringify({ extensions: [join(root, "src", "guards.ts"), join(root, "src", "bus.ts"), join(root, ".pi", "extensions", "subagent", "index.ts")] }, null, 2));
  linkTeammates(join(root, ".pi", "agents", "do"), join(folder, ".pi", "agents"));
}

export function prepareDo(root: string, request: CoordinatorRequest, origin: CoordinatorOrigin, snapshot: RuntimeSettings = readRuntimeSettings(root)): PreparedCoordinator {
  validateCoordinatorRequest(request);
  if (request.mode !== "do" || request.tickets.length !== 1) fail("prepareDo needs exactly one do ticket");
  const ticket = request.tickets[0]!;
  const plan = resolvePlan(root, ticket, request.plan);
  const taskRoot = join(root, "work");
  const folder = join(taskRoot, ticket);
  if (!inside(taskRoot, folder)) fail(`unsafe task folder ${folder}`);
  if (existsSync(folder) && lstatSync(folder).isSymbolicLink()) fail(`task folder is a symlink: ${folder}`);
  const db = openDb(join(root, "yokemate.db"));
  const expected = ((db.prepare("SELECT stage FROM work WHERE ticket = ?").get(ticket) as { stage?: From } | undefined)?.stage ?? "absent") as From;
  const preflight = checkMove("spawn", origin, ticket, expected, { allowFresh: Boolean(request.plan), settings: snapshot });
  if (!preflight.ok) fail(preflight.refuse);
  const parts = partsForPlan(root, ticket, plan);
  const model = request.model ?? modelForTicket(db, ticket, "do") ?? poolModel(dataRoot(root), "do");
  mkdirSync(folder, { recursive: true });
  settings(root, folder);
  const passports = parts.map((p) => `- ${p.repo}: clone at ${p.path}${p.figmaMcp ? `, Figma MCP ${p.figmaMcp}` : ""}${p.figmaUrl ? `, design file ${p.figmaUrl}` : ""}`).join("\n");
  return { mode: "do", tickets: [ticket], model, cwd: folder, plan, plans: { [ticket]: plan }, parts, expected, skillsPath: join(root, ".pi", "skills"), resourcesPath: root, prompt: `/skill:do-worker ${ticket}. The plan is at ${plan} — read it fully; it lists the affected repositories and the contract between parts. Work only inside ${folder}. Project passports (worktrees fork from these clones):\n${passports}\nWhen the PRs are open and green, run pnpm record-report ${ticket} --part <org/repo>:<role>:<branch>:<pr-url> from the task folder root yourself, then call coordinator_finish done.` };
}

export function markDoRunning(root: string, prepared: PreparedCoordinator, origin: CoordinatorOrigin): void {
  const settings = readRuntimeSettings(root);
  if (prepared.mode !== "do" || !prepared.plan || !prepared.expected) fail("prepared do request is incomplete");
  const ticket = prepared.tickets[0]!;
  const db = openDb(join(root, "yokemate.db"));
  const out = applyMove(db, "spawn", origin, ticket, () => {
    db.prepare("INSERT INTO work (ticket, url, stage) VALUES (?, ?, 'running') ON CONFLICT (ticket) DO UPDATE SET stage = 'running'").run(ticket, ticketUrl(db, ticket));
    db.prepare("UPDATE work SET folder = ?, plan = ?, updated_at = datetime('now') WHERE ticket = ?").run(prepared.cwd, prepared.plan!, ticket);
  }, { allowFresh: true, expected: prepared.expected, settings });
  if (!out.ok) fail(out.refuse);
}

const exec = (file: string, args: string[], cwd: string) => new Promise<string>((resolvePromise, reject) => execFile(file, args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolvePromise(stdout)));
function hasShippedOutcome(root: string, ticket: string): boolean {
  const journal = join(dataRoot(root), "journal");
  if (!existsSync(journal)) return false;
  const pattern = new RegExp(`^\\- \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} ${ticket} отгружено(?:$|:)`, "m");
  return readdirSync(journal).filter((name) => /^\d{4}-\d{2}\.md$/.test(name)).some((name) => pattern.test(readFileSync(join(journal, name), "utf8")));
}

export async function prepareShip(root: string, request: CoordinatorRequest): Promise<PreparedCoordinator> {
  validateCoordinatorRequest(request);
  if (request.mode !== "ship" || request.tickets.length !== 1) fail("prepareShip needs exactly one ship ticket");
  const db = openDb(join(root, "yokemate.db"));
  const plans: Record<string, string> = {};
  const parts: PreparedPart[] = [];
  for (const ticket of request.tickets) {
    const folder = join(root, "work", ticket);
    const recoveringFinalization = !existsSync(folder) && hasShippedOutcome(root, ticket);
    if (!existsSync(folder) && !recoveringFinalization) fail(`no task folder ${folder} — /ship runs after /do`);
    if (!recoveringFinalization && lstatSync(folder).isSymbolicLink()) fail(`task folder is a symlink: ${folder}`);
    const plan = resolvePlan(root, ticket);
    plans[ticket] = plan;
    for (const part of partsForPlan(root, ticket, plan)) {
      const worktree = join(folder, part.repo.split("/")[1]!);
      if (!recoveringFinalization && !existsSync(worktree)) fail(`no worktree ${worktree} for ${part.repo}`);
      const gitCwd = recoveringFinalization ? part.path : worktree;
      const remote = (await exec("git", ["remote", "get-url", "origin"], gitCwd)).trim();
      const snapshot = JSON.parse(await exec("gh", ["pr", "view", ticket, "--json", "baseRefName,url,headRefOid,headRefName,state,mergedAt"], gitCwd)) as { baseRefName: string; url: string; headRefOid: string; headRefName: string; state: string; mergedAt?: string };
      if (snapshot.headRefName !== ticket) fail(`${part.repo}: PR head is ${snapshot.headRefName}, not ${ticket}`);
      if (recoveringFinalization && (snapshot.state !== "MERGED" || !snapshot.mergedAt)) fail(`${part.repo}: task folder is absent but PR is not confirmed merged`);
      parts.push({ ...part, pr: snapshot.url, base: snapshot.baseRefName, path: gitCwd, passportPath: part.path, figmaUrl: part.figmaUrl, figmaMcp: part.figmaMcp, remote, observedHead: snapshot.headRefOid });
    }
  }
  const model = request.model ?? modelForTicket(db, request.tickets[0]!, "ship") ?? poolModel(dataRoot(root), "ship");
  return { mode: "ship", tickets: [...request.tickets], model, cwd: root, plans, parts, skillsPath: join(root, ".pi", "skills"), resourcesPath: root, prompt: `/skill:ship-worker ${request.tickets[0]}${request.note ? ` ${request.note}` : ""}. Work only in this ticket's listed task worktrees and call coordinator_finish with the verified outcome.` };
}
