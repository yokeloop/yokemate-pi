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
import { assertMandatoryBoundary } from "./workflow-boundaries.ts";
import { resolveGroupWorkScope } from "./group-scope.ts";

export type CoordinatorMode = "do" | "ship";
export interface CoordinatorRequest { mode: CoordinatorMode; tickets: string[]; plan?: string; model?: string; note?: string }
export interface CoordinatorOrigin extends MoveEnv { sessionId?: string; runId?: string; cwd?: string; pane?: string; parentPane?: string }
export interface PreparedPart extends PlanPart { repo: string; org: string; path: string; passportPath?: string; figmaMcp?: string; figmaUrl?: string; branch: string; pr?: string; base?: string; remote?: string; observedHead?: string; targetBranch?: string; worktree?: string; scopeId?: string }
export interface PreparedGroup { groupId: string; revisionHash: string; root: string; role: "parent" | "member"; memberIdentity?: string; ownWork?: "implementation" | "coordination-only" }
export interface PreparedCoordinator { doBinding?: import("./plan-binding.ts").PlanBinding; mode: CoordinatorMode; tickets: string[]; model: string; cwd: string; plan?: string; plans: Record<string, string>; parts: PreparedPart[]; prompt: string; skillsPath: string; resourcesPath: string; expected?: From; group?: PreparedGroup }

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
  const assigned = request.tickets.every((ticket) => typeof ticket === "string" && KEY.test(ticket) && !ticket.includes(".."));
  assertMandatoryBoundary("workflow.assigned-scope", assigned, "coordinator ticket scope is invalid");
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

export function prepareDo(root: string, request: CoordinatorRequest, origin: CoordinatorOrigin, snapshot: RuntimeSettings = readRuntimeSettings(root), delegatedGroup?: { groupId: string; revisionHash: string; member: string }): PreparedCoordinator {
  validateCoordinatorRequest(request);
  if (request.mode !== "do" || request.tickets.length !== 1) fail("prepareDo needs exactly one do ticket");
  const ticket = request.tickets[0]!;
  const state = openDb(join(root, "yokemate.db"));
  const activeGroup = delegatedGroup
    ? state.prepare("SELECT id,root_ticket,active_revision,phase FROM task_group WHERE id=? AND active_revision=?").get(delegatedGroup.groupId, delegatedGroup.revisionHash) as { id: string; root_ticket: string; active_revision: string; phase: string } | undefined
    : state.prepare("SELECT id,root_ticket,active_revision,phase FROM task_group WHERE root_ticket=? AND active_revision IS NOT NULL AND phase IN ('planned','running','blocked') ORDER BY updated_at DESC LIMIT 1").get(ticket) as { id: string; root_ticket: string; active_revision: string; phase: string } | undefined;
  if (activeGroup) {
    const revision = state.prepare("SELECT manifest_json,bindings_json FROM group_revision WHERE group_id=? AND revision_hash=?").get(activeGroup.id, activeGroup.active_revision) as { manifest_json: string; bindings_json: string } | undefined;
    const activeRevision = revision ?? fail(`${ticket}: active group revision is missing`);
    const manifest = JSON.parse(activeRevision.manifest_json) as { ownerProject: string; members: { ticket: string; ownWork: "implementation" | "coordination-only"; implementationRepos: string[] }[]; repositories: { repo: string; role: string }[] };
    const bindings = JSON.parse(activeRevision.bindings_json) as { ticket: string; path: string }[];
    const memberTicket = delegatedGroup?.member ?? ticket;
    const member = manifest.members.find((item) => item.ticket === memberTicket);
    const binding = bindings.find((item) => item.ticket === memberTicket);
    const activeMember = member ?? fail(`${memberTicket}: active group member binding is missing`);
    const activeBinding = binding ?? fail(`${memberTicket}: active group member binding is missing`);
    const taskRoot = join(root, "work");
    const folder = delegatedGroup ? join(taskRoot, activeGroup.root_ticket, "members", memberTicket) : join(taskRoot, activeGroup.root_ticket);
    if (!inside(taskRoot, folder)) fail(`unsafe task folder ${folder}`);
    if (existsSync(folder) && lstatSync(folder).isSymbolicLink()) fail(`task folder is a symlink: ${folder}`);
    const repos = delegatedGroup ? activeMember.implementationRepos : manifest.repositories.map((item) => item.repo);
    const roles = new Map(manifest.repositories.map((item) => [item.repo, item.role]));
    const parts = repos.map((repo): PreparedPart => {
      const [org, name] = repo.split("/");
      const row = state.prepare("SELECT path,figma_mcp,figma_url FROM project WHERE org=? AND repo=?").get(org, name) as { path: string; figma_mcp: string | null; figma_url: string | null } | undefined;
      const passport = row ?? fail(`${memberTicket}: no passport for ${repo}`);
      const branch = memberTicket === activeGroup.root_ticket ? `${activeGroup.root_ticket}-own` : memberTicket;
      if (delegatedGroup) {
        const memberRow = state.prepare("SELECT member_identity FROM group_member WHERE group_id=? AND revision_hash=? AND ticket=?").get(activeGroup.id, activeGroup.active_revision, memberTicket) as { member_identity: string };
        const scope = resolveGroupWorkScope(state, join(root, "work", activeGroup.root_ticket), { groupId: activeGroup.id, revisionHash: activeGroup.active_revision, memberIdentity: memberRow.member_identity, kind: memberTicket === activeGroup.root_ticket ? "root-own" : "member", repo });
        return { repo, org: org!, role: roles.get(repo) ?? "app", roleAssumed: false, path: passport.path, figmaMcp: passport.figma_mcp ?? undefined, figmaUrl: passport.figma_url ?? undefined, branch: scope.branch!, targetBranch: scope.targetBranch!, worktree: scope.worktree!, remote: scope.remote!, scopeId: scope.scopeId };
      }
      return { repo, org: org!, role: roles.get(repo) ?? "app", roleAssumed: false, path: passport.path, figmaMcp: passport.figma_mcp ?? undefined, figmaUrl: passport.figma_url ?? undefined, branch, targetBranch: activeGroup.root_ticket, worktree: join(folder, org!, name!) };
    });
    const model = request.model ?? modelForTicket(state, activeGroup.root_ticket, "do") ?? poolModel(dataRoot(root), "do");
    mkdirSync(folder, { recursive: true });
    settings(root, folder);
    const group = { groupId: activeGroup.id, revisionHash: activeGroup.active_revision, root: activeGroup.root_ticket, role: delegatedGroup ? "member" as const : "parent" as const, ...(delegatedGroup ? { memberIdentity: delegatedGroup.member, ownWork: activeMember.ownWork } : {}) };
    const passports = parts.map((part) => `- ${part.repo}: clone at ${part.path}, worktree ${part.worktree}, branch ${part.branch}, internal target ${part.targetBranch}`).join("\n");
    const prompt = delegatedGroup
      ? `/skill:do-worker ${memberTicket}. This is group ${activeGroup.id} revision ${activeGroup.active_revision}; read ${activeBinding.path} fully. Work only inside ${folder}. Use only the listed member scopes; every PR targets ${activeGroup.root_ticket}, never an external base. Project passports:\n${passports}\nWhen the scoped PRs are open and green, run pnpm record-report ${memberTicket} --part <org/repo>:<role>:<branch>:<pr-url> from ${folder}, then call coordinator_finish done.`
      : `/skill:group-do-worker ${activeGroup.root_ticket}. Execute only group ${activeGroup.id} revision ${activeGroup.active_revision}. Start the durable scheduler with group_do_start, keep this cycle conversational, integrate only through group_integrate, and call coordinator_finish only after the group reaches review or a durable blocker.`;
    state.close();
    return { mode: "do", tickets: [memberTicket], model, cwd: folder, plan: activeBinding.path, plans: Object.fromEntries(bindings.map((item) => [item.ticket, item.path])), parts, skillsPath: join(root, ".pi", "skills"), resourcesPath: root, prompt, group };
  }
  state.close();
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
  assertMandatoryBoundary("workflow.required-data", parts.length > 0, `${ticket}: no affected repository passports`);
  const model = request.model ?? modelForTicket(db, ticket, "do") ?? poolModel(dataRoot(root), "do");
  mkdirSync(folder, { recursive: true });
  settings(root, folder);
  const passports = parts.map((p) => `- ${p.repo}: clone at ${p.path}${p.figmaMcp ? `, Figma MCP ${p.figmaMcp}` : ""}${p.figmaUrl ? `, design file ${p.figmaUrl}` : ""}`).join("\n");
  return { mode: "do", tickets: [ticket], model, cwd: folder, plan, plans: { [ticket]: plan }, parts, expected, skillsPath: join(root, ".pi", "skills"), resourcesPath: root, prompt: `/skill:do-worker ${ticket}. The plan is at ${plan} — read it fully; it lists the affected repositories and the contract between parts. Work only inside ${folder}. Project passports (worktrees fork from these clones):\n${passports}\nWhen the PRs are open and green, run pnpm record-report ${ticket} --part <org/repo>:<role>:<branch>:<pr-url> from the task folder root yourself, then call coordinator_finish done.` };
}

export function markDoRunning(root: string, prepared: PreparedCoordinator, origin: CoordinatorOrigin, snapshot: RuntimeSettings = readRuntimeSettings(root)): void {
  if (prepared.group) {
    if (prepared.mode !== "do" || !prepared.plan) fail("prepared group do request is incomplete");
    return;
  }
  if (prepared.mode !== "do" || !prepared.plan || !prepared.expected) fail("prepared do request is incomplete");
  const ticket = prepared.tickets[0]!;
  const db = openDb(join(root, "yokemate.db"));
  const out = applyMove(db, "spawn", origin, ticket, () => {
    db.prepare("INSERT INTO work (ticket, url, stage) VALUES (?, ?, 'running') ON CONFLICT (ticket) DO UPDATE SET stage = 'running'").run(ticket, ticketUrl(db, ticket));
    db.prepare("UPDATE work SET folder = ?, plan = ?, updated_at = datetime('now') WHERE ticket = ?").run(prepared.cwd, prepared.plan!, ticket);
  }, { allowFresh: true, expected: prepared.expected, settings: snapshot });
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
  const group = db.prepare("SELECT id,active_revision,phase FROM task_group WHERE root_ticket=? AND active_revision IS NOT NULL AND phase IN ('accepted','shipping','done') ORDER BY updated_at DESC LIMIT 1").get(request.tickets[0]!) as { id: string; active_revision: string; phase: string } | undefined;
  if (group) {
    const ticket = request.tickets[0]!;
    const acceptance = db.prepare("SELECT candidate_hash FROM group_acceptance WHERE group_id=? AND revision_hash=? AND state='current'").get(group.id, group.active_revision) as { candidate_hash: string } | undefined;
    if (!acceptance) fail(`${ticket}: group has no current accepted candidate`);
    const rootMember = db.prepare("SELECT member_identity FROM group_member WHERE group_id=? AND revision_hash=? AND ticket=?").get(group.id, group.active_revision, ticket) as { member_identity: string } | undefined;
    const activeRootMember = rootMember ?? fail(`${ticket}: group root member is missing`);
    const repositories = db.prepare("SELECT repo,role,remote,external_base,final_pr,head_sha FROM group_repository WHERE group_id=? AND revision_hash=? ORDER BY repo").all(group.id, group.active_revision) as unknown as { repo: string; role: string; remote: string; external_base: string; final_pr: string | null; head_sha: string | null }[];
    const parts = repositories.map((repository): PreparedPart => {
      if (!repository.final_pr || !repository.head_sha) fail(`${repository.repo}: accepted group final PR is incomplete`);
      const [org, repo] = repository.repo.split("/");
      const passport = db.prepare("SELECT path FROM project WHERE org=? AND repo=?").get(org, repo) as { path: string } | undefined;
      const activePassport = passport ?? fail(`${repository.repo}: passport is missing`);
      const scope = resolveGroupWorkScope(db, join(root, "work", ticket), { groupId: group.id, revisionHash: group.active_revision, memberIdentity: activeRootMember.member_identity, kind: "integration", repo: repository.repo });
      return { repo: repository.repo, org: org!, role: repository.role, roleAssumed: false, path: scope.worktree!, passportPath: activePassport.path, branch: ticket, pr: repository.final_pr!, base: repository.external_base, remote: repository.remote, observedHead: repository.head_sha!, targetBranch: repository.external_base, worktree: scope.worktree!, scopeId: scope.scopeId };
    });
    const plan = resolvePlan(root, ticket);
    const model = request.model ?? modelForTicket(db, ticket, "ship") ?? poolModel(dataRoot(root), "ship");
    return { mode: "ship", tickets: [ticket], model, cwd: join(root, "work", ticket), plan, plans: { [ticket]: plan }, parts, skillsPath: join(root, ".pi", "skills"), resourcesPath: root, prompt: `/skill:ship-worker ${ticket}${request.note ? ` ${request.note}` : ""}. Ship only accepted group ${group.id} revision ${group.active_revision}, use coordinator_merge for every registered final PR, then call coordinator_finish with the truthful partial or complete outcome.`, group: { groupId: group.id, revisionHash: group.active_revision, root: ticket, role: "parent" } };
  }
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
