import { execFileSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import type { TicketState } from "./sync.ts";

export interface GithubProject {
  org: string;
  repo: string;
  path: string;
  prefix: string;
}

export function githubProjects(db: DatabaseSync): GithubProject[] {
  const rows = db
    .prepare("SELECT org, repo, path, tracker_key FROM project WHERE tracker = 'github'")
    .all() as unknown as { org: string; repo: string; path: string; tracker_key: string }[];
  return rows.map((r) => ({ org: r.org, repo: r.repo, path: r.path, prefix: r.tracker_key }));
}

export type GhExec = (args: string[], cwd?: string) => string;

const gh: GhExec = (args, cwd) =>
  execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export type RemoteOf = (path: string) => string;

const gitOrigin: RemoteOf = (path) =>
  execFileSync("git", ["-C", path, "remote", "get-url", "origin"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

export function ticketNumber(ticket: string): number {
  return Number(ticket.split("-")[1]);
}

const viewerCache = new Map<GhExec, string>();

export function viewerLogin(exec: GhExec = gh): string {
  const hit = viewerCache.get(exec);
  if (hit) return hit;
  const login = exec(["api", "user", "--jq", ".login"]).trim();
  viewerCache.set(exec, login);
  return login;
}

export interface GhIssue {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  assignees: { login: string }[];
}

export function listIssues(p: GithubProject, all = false, exec: GhExec = gh): GhIssue[] {
  const out = exec(
    [
      "issue", "list",
      "--state", all ? "all" : "open",
      "--json", "number,title,state,assignees",
      "--limit", "1000",
    ],
    p.path,
  );
  return JSON.parse(out) as GhIssue[];
}

export function mine(issue: GhIssue, me: string): boolean {
  return issue.assignees.length === 0 || issue.assignees.some((a) => a.login === me);
}

export function issueStates(
  p: GithubProject,
  keys: string[],
  exec: GhExec = gh,
): Map<string, TicketState> {
  const out = new Map<string, TicketState>();
  if (keys.length === 0) return out;
  const me = viewerLogin(exec);
  for (const issue of listIssues(p, true, exec)) {
    out.set(`${p.prefix}-${issue.number}`, {
      resolved: issue.state === "CLOSED",
      assignedToMe: mine(issue, me),
      title: issue.title,
    });
  }
  return out;
}

export function postComment(p: GithubProject, number: number, text: string, exec: GhExec = gh): void {
  exec(["issue", "comment", String(number), "--body", text], p.path);
}

export function originOwnerRepo(
  path: string,
  remoteOf: RemoteOf = gitOrigin,
): { owner: string; repo: string } {
  const remote = remoteOf(path).trim();
  const m = remote.match(/[:/]([^/:]+)\/([^/]+?)(\.git)?$/);
  if (!m) throw new Error(`cannot parse owner/repo from remote "${remote}"`);
  return { owner: m[1], repo: m[2] };
}

export function issueUrl(path: string, number: number, remoteOf?: RemoteOf): string {
  const { owner, repo } = originOwnerRepo(path, remoteOf);
  return `https://github.com/${owner}/${repo}/issues/${number}`;
}

export function validGithubPrefix(s: string): boolean {
  return /^[A-Z][A-Z0-9]*$/.test(s);
}
