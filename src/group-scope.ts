import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { GroupExecutionManifest } from "./group-plan.ts";
import { canonicalHash } from "./group-state.ts";

export type GroupWorkKind = "integration" | "member" | "root-own" | "coordination";
export interface WorkScope {
  scopeId: string;
  groupId: string;
  revisionHash: string;
  member: string;
  kind: GroupWorkKind;
  repo: string | null;
  worktree: string | null;
  branch: string | null;
  targetBranch: string | null;
  remote: string | null;
  pr: string | null;
  receiptPath: string | null;
}

interface GroupRow { root_ticket: string; active_revision: string; phase: string }
interface MemberRow { member_identity: string; ticket: string; result_json: string | null }
interface RepoRow { repo: string; remote: string; integration_branch: string; external_base: string; final_pr: string | null }
interface PartRow { source_ref: string | null; target_ref: string | null; pr_identity: string | null; remote: string }

export function resolveGroupWorkScope(db: DatabaseSync, taskRoot: string, input: { groupId: string; revisionHash: string; memberIdentity: string; kind: GroupWorkKind; repo?: string }): WorkScope {
  const group = db.prepare("SELECT root_ticket,active_revision,phase FROM task_group WHERE id=?").get(input.groupId) as GroupRow | undefined;
  if (!group || group.active_revision !== input.revisionHash || group.phase === "done") throw new Error("group work scope revision is inactive");
  const member = db.prepare("SELECT member_identity,ticket,result_json FROM group_member WHERE group_id=? AND revision_hash=? AND member_identity=?").get(input.groupId, input.revisionHash, input.memberIdentity) as MemberRow | undefined;
  if (!member) throw new Error("group work scope member is not registered");
  if (input.kind === "coordination") {
    if (input.repo) throw new Error("coordination scope cannot name a repository");
    return Object.freeze({ scopeId: canonicalHash({ groupId: input.groupId, revisionHash: input.revisionHash, member: input.memberIdentity, kind: input.kind }), groupId: input.groupId, revisionHash: input.revisionHash, member: input.memberIdentity, kind: input.kind, repo: null, worktree: null, branch: null, targetBranch: null, remote: null, pr: null, receiptPath: null });
  }
  if (!input.repo || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(input.repo)) throw new Error("group work scope repository is invalid");
  const repository = db.prepare("SELECT repo,remote,integration_branch,external_base,final_pr FROM group_repository WHERE group_id=? AND revision_hash=? AND repo=?").get(input.groupId, input.revisionHash, input.repo) as RepoRow | undefined;
  if (!repository) throw new Error("group work scope repository is not registered");
  const [org, repoName] = input.repo.split("/");
  let worktree: string;
  let branch: string;
  let targetBranch: string;
  let pr: string | null;
  if (input.kind === "integration") {
    if (member.ticket !== group.root_ticket) throw new Error("integration scope belongs to the group root");
    worktree = join(resolve(taskRoot), "integration", org!, repoName!);
    branch = repository.integration_branch;
    targetBranch = repository.external_base;
    pr = repository.final_pr;
  } else {
    const part = db.prepare("SELECT source_ref,target_ref,pr_identity,remote FROM group_part WHERE group_id=? AND revision_hash=? AND member_identity=? AND repo=?").get(input.groupId, input.revisionHash, input.memberIdentity, input.repo) as PartRow | undefined;
    if (!part) throw new Error("group member part is not registered");
    if (input.kind === "root-own" && member.ticket !== group.root_ticket) throw new Error("root-own scope belongs to the group root");
    if (input.kind === "member" && member.ticket === group.root_ticket) throw new Error("root implementation requires a root-own scope");
    worktree = join(resolve(taskRoot), "members", member.ticket, org!, repoName!);
    branch = part.source_ref ?? (input.kind === "root-own" ? `${group.root_ticket}-own` : member.ticket);
    targetBranch = part.target_ref ?? repository.integration_branch;
    pr = part.pr_identity;
    if (targetBranch !== repository.integration_branch) throw new Error("group member PR target is not the integration branch");
  }
  const receiptPath = join(worktree, ".yokemate-ready.json");
  const scopeId = canonicalHash({ groupId: input.groupId, revisionHash: input.revisionHash, member: input.memberIdentity, kind: input.kind, repo: input.repo, worktree, branch, targetBranch, remote: repository.remote, pr, receiptPath });
  return Object.freeze({ scopeId, groupId: input.groupId, revisionHash: input.revisionHash, member: input.memberIdentity, kind: input.kind, repo: input.repo, worktree, branch, targetBranch, remote: repository.remote, pr, receiptPath });
}

export function assertWorkScope(expected: WorkScope, actual: WorkScope): void {
  if (expected.scopeId !== actual.scopeId || JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("group work scope changed");
}

export interface PreparedGroupScopes { repositories: WorkScope[]; members: WorkScope[] }

const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function ensureWorktree(clone: string, worktree: string, branch: string, start: string): void {
  mkdirSync(dirname(worktree), { recursive: true });
  if (existsSync(worktree)) {
    if (realpathSync(git(worktree, "rev-parse", "--show-toplevel")) !== realpathSync(worktree) || git(worktree, "branch", "--show-current") !== branch) throw new Error(`${worktree}: existing group worktree identity differs`);
    return;
  }
  const branchExists = (() => { try { git(clone, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`); return true; } catch { return false; } })();
  if (branchExists) execFileSync("git", ["-C", clone, "worktree", "add", worktree, branch], { stdio: "pipe" });
  else execFileSync("git", ["-C", clone, "worktree", "add", "-b", branch, worktree, start], { stdio: "pipe" });
}

export function refreshQueuedMemberWorkScopes(db: DatabaseSync, taskRoot: string, input: { groupId: string; revisionHash: string; ticket: string }): WorkScope[] {
  const group = db.prepare("SELECT root_ticket FROM task_group WHERE id=? AND active_revision=?").get(input.groupId, input.revisionHash) as { root_ticket: string } | undefined;
  const member = db.prepare("SELECT member_identity FROM group_member WHERE group_id=? AND revision_hash=? AND ticket=? AND execution='running'").get(input.groupId, input.revisionHash, input.ticket) as { member_identity: string } | undefined;
  if (!group || !member) throw new Error(`${input.ticket}: delegated member scope is not active`);
  const rows = db.prepare(`SELECT p.repo,r.base_sha FROM group_part p JOIN group_repository r ON r.group_id=p.group_id AND r.revision_hash=p.revision_hash AND r.repo=p.repo
    WHERE p.group_id=? AND p.revision_hash=? AND p.member_identity=? ORDER BY p.repo`).all(input.groupId, input.revisionHash, member.member_identity) as unknown as { repo: string; base_sha: string }[];
  return rows.map((row) => {
    const kind = input.ticket === group.root_ticket ? "root-own" : "member";
    const scope = resolveGroupWorkScope(db, taskRoot, { groupId: input.groupId, revisionHash: input.revisionHash, memberIdentity: member.member_identity, kind, repo: row.repo });
    if (git(scope.worktree!, "status", "--porcelain")) throw new Error(`${input.ticket}/${row.repo}: delegated worktree is dirty before launch`);
    execFileSync("git", ["-C", scope.worktree!, "fetch", "origin", group.root_ticket], { stdio: "pipe" });
    const head = git(scope.worktree!, "rev-parse", "HEAD");
    if (head === row.base_sha) execFileSync("git", ["-C", scope.worktree!, "reset", "--hard", `origin/${group.root_ticket}`], { stdio: "pipe" });
    return scope;
  });
}

export function prepareGroupWorkScopes(db: DatabaseSync, taskRoot: string, input: { groupId: string; revisionHash: string; manifest: GroupExecutionManifest }): PreparedGroupScopes {
  const group = db.prepare("SELECT root_ticket,active_revision,phase FROM task_group WHERE id=?").get(input.groupId) as GroupRow | undefined;
  if (!group || group.active_revision !== input.revisionHash || !["planned", "running", "blocked", "review", "accepted"].includes(group.phase)) throw new Error("group work preparation requires the active executable or review revision");
  const repositories: WorkScope[] = [];
  const members: WorkScope[] = [];
  for (const repository of input.manifest.repositories) {
    const [org, name] = repository.repo.split("/");
    const passport = db.prepare("SELECT path FROM project WHERE org=? AND repo=?").get(org, name) as { path: string } | undefined;
    if (!passport) throw new Error(`${repository.repo}: no exact project passport`);
    const clone = realpathSync(passport.path);
    const remote = git(clone, "remote", "get-url", "origin");
    execFileSync("git", ["-C", clone, "fetch", "origin"], { stdio: "pipe" });
    const remoteHead = git(clone, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
    if (!remoteHead.startsWith("origin/")) throw new Error(`${repository.repo}: origin/HEAD is unavailable`);
    let externalBase = remoteHead.slice("origin/".length);
    let baseSha = git(clone, "rev-parse", `origin/${externalBase}^{commit}`);
    const existing = db.prepare("SELECT remote,role,integration_branch,external_base,base_sha FROM group_repository WHERE group_id=? AND revision_hash=? AND repo=?").get(input.groupId, input.revisionHash, repository.repo) as { remote: string; role: string; integration_branch: string; external_base: string; base_sha: string } | undefined;
    if (existing && ["review", "accepted"].includes(group.phase)) { externalBase = existing.external_base; baseSha = existing.base_sha; }
    const expected = { remote, role: repository.role, integration_branch: group.root_ticket, external_base: externalBase, base_sha: baseSha };
    if (existing && JSON.stringify(existing) !== JSON.stringify(expected)) throw new Error(`${repository.repo}: registered integration scope changed`);
    if (!existing) db.prepare("INSERT INTO group_repository (group_id,revision_hash,repo,remote,role,integration_branch,external_base,base_sha) VALUES (?,?,?,?,?,?,?,?)").run(input.groupId, input.revisionHash, repository.repo, remote, repository.role, group.root_ticket, externalBase, baseSha);
    const integrationPath = join(resolve(taskRoot), "integration", org!, name!);
    ensureWorktree(clone, integrationPath, group.root_ticket, existing && ["review", "accepted"].includes(group.phase) ? baseSha : `origin/${externalBase}`);
    const remoteIntegration = git(clone, "ls-remote", "--heads", "origin", group.root_ticket);
    if (!remoteIntegration) execFileSync("git", ["-C", integrationPath, "push", "--set-upstream", "origin", `${group.root_ticket}:${group.root_ticket}`], { stdio: "pipe" });
    else {
      execFileSync("git", ["-C", integrationPath, "fetch", "origin", group.root_ticket], { stdio: "pipe" });
      const localHead = git(integrationPath, "rev-parse", group.root_ticket);
      const remoteHead = git(integrationPath, "rev-parse", `origin/${group.root_ticket}`);
      if (localHead !== remoteHead) {
        if (git(integrationPath, "status", "--porcelain")) throw new Error(`${repository.repo}: integration worktree is dirty while remote branch advanced`);
        try { git(integrationPath, "merge-base", "--is-ancestor", localHead, remoteHead); }
        catch { throw new Error(`${repository.repo}: local and remote integration branches diverged`); }
        execFileSync("git", ["-C", integrationPath, "reset", "--hard", `origin/${group.root_ticket}`], { stdio: "pipe" });
      }
    }
    const rootMember = input.manifest.members.find((member) => member.ticket === group.root_ticket)!;
    const rootIdentity = (db.prepare("SELECT member_identity FROM group_member WHERE group_id=? AND revision_hash=? AND ticket=?").get(input.groupId, input.revisionHash, group.root_ticket) as { member_identity: string }).member_identity;
    repositories.push(resolveGroupWorkScope(db, taskRoot, { groupId: input.groupId, revisionHash: input.revisionHash, memberIdentity: rootIdentity, kind: "integration", repo: repository.repo }));
    for (const member of input.manifest.members.filter((candidate) => candidate.implementationRepos.includes(repository.repo))) {
      const row = db.prepare("SELECT member_identity FROM group_member WHERE group_id=? AND revision_hash=? AND ticket=?").get(input.groupId, input.revisionHash, member.ticket) as { member_identity: string } | undefined;
      if (!row) throw new Error(`${member.ticket}: active group member is missing`);
      const source = member.ticket === group.root_ticket ? `${group.root_ticket}-own` : member.ticket;
      const part = db.prepare("SELECT remote,role,source_ref,target_ref FROM group_part WHERE group_id=? AND revision_hash=? AND member_identity=? AND repo=?").get(input.groupId, input.revisionHash, row.member_identity, repository.repo) as { remote: string; role: string; source_ref: string; target_ref: string } | undefined;
      const expectedPart = { remote, role: repository.role, source_ref: source, target_ref: group.root_ticket };
      if (part && JSON.stringify(part) !== JSON.stringify(expectedPart)) throw new Error(`${member.ticket}/${repository.repo}: registered member scope changed`);
      if (!part) db.prepare("INSERT INTO group_part (group_id,revision_hash,member_identity,repo,remote,role,source_ref,target_ref) VALUES (?,?,?,?,?,?,?,?)").run(input.groupId, input.revisionHash, row.member_identity, repository.repo, remote, repository.role, source, group.root_ticket);
      const kind = member.ticket === group.root_ticket ? "root-own" : "member";
      const scope = resolveGroupWorkScope(db, taskRoot, { groupId: input.groupId, revisionHash: input.revisionHash, memberIdentity: row.member_identity, kind, repo: repository.repo });
      ensureWorktree(clone, scope.worktree!, source, group.root_ticket);
      members.push(scope);
    }
    if (rootMember.ownWork === "coordination-only" && rootMember.implementationRepos.includes(repository.repo)) throw new Error("coordination-only root cannot own implementation scope");
  }
  for (const member of input.manifest.members.filter((candidate) => candidate.ownWork === "coordination-only")) {
    const row = db.prepare("SELECT member_identity FROM group_member WHERE group_id=? AND revision_hash=? AND ticket=?").get(input.groupId, input.revisionHash, member.ticket) as { member_identity: string };
    members.push(resolveGroupWorkScope(db, taskRoot, { groupId: input.groupId, revisionHash: input.revisionHash, memberIdentity: row.member_identity, kind: "coordination" }));
  }
  return { repositories, members };
}
