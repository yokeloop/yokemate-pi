import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
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
