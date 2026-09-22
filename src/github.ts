import { execFileSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import type { TicketState } from "./sync.ts";
import { PublicationFailure, type PublicationAdapter, type RemoteComment } from "./plan-publication.ts";

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

export interface GithubHierarchyIssue { number: number; title: string; state: "open" | "closed" }
export interface GithubIssueHierarchy { issue: GithubHierarchyIssue; parent: GithubHierarchyIssue | null; subtasks: GithubHierarchyIssue[] }

function parseHierarchyIssue(value: unknown, context: string): GithubHierarchyIssue {
  if (!value || typeof value !== "object") throw new Error(`incomplete_tree: invalid GitHub ${context}`);
  const issue = value as { number?: unknown; title?: unknown; state?: unknown };
  if (!Number.isSafeInteger(issue.number) || Number(issue.number) < 1 || typeof issue.title !== "string" || issue.state !== "open" && issue.state !== "closed") throw new Error(`incomplete_tree: invalid GitHub ${context}`);
  return { number: Number(issue.number), title: issue.title, state: issue.state };
}

export function fetchSubIssues(project: GithubProject, number: number, exec: GhExec = gh): GithubIssueHierarchy {
  const repository = `${project.org}/${project.repo}`;
  let issue: GithubHierarchyIssue;
  try { issue = parseHierarchyIssue(JSON.parse(exec(["api", `repos/${repository}/issues/${number}`], project.path)), "issue"); }
  catch (error) { throw error instanceof Error && error.message.startsWith("incomplete_tree:") ? error : new Error(`incomplete_tree: GitHub issue ${repository}#${number} is unavailable`); }
  let parent: GithubHierarchyIssue | null = null;
  try {
    const raw = JSON.parse(exec(["api", `repos/${repository}/issues/${number}/parent`], project.path)) as unknown;
    parent = parseHierarchyIssue(raw, "parent");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/404|not found/i.test(message)) throw new Error(`incomplete_tree: cannot read GitHub parent of ${repository}#${number}`);
  }
  const subtasks: GithubHierarchyIssue[] = [];
  const seen = new Set<number>();
  const pageFingerprints = new Set<string>();
  for (let page = 1; ; page++) {
    let values: unknown;
    try { values = JSON.parse(exec(["api", `repos/${repository}/issues/${number}/sub_issues?per_page=100&page=${page}`], project.path)); }
    catch { throw new Error(`incomplete_tree: cannot read GitHub sub-issues of ${repository}#${number}`); }
    if (!Array.isArray(values)) throw new Error(`incomplete_tree: invalid GitHub sub-issues response for ${repository}#${number}`);
    const fingerprint = JSON.stringify(values);
    if (values.length && pageFingerprints.has(fingerprint)) throw new Error(`incomplete_tree: repeated GitHub sub-issues page for ${repository}#${number}`);
    pageFingerprints.add(fingerprint);
    for (const value of values) {
      const child = parseHierarchyIssue(value, "sub-issue");
      if (seen.has(child.number)) throw new Error(`ambiguous_membership: duplicate GitHub sub-issue ${repository}#${child.number}`);
      seen.add(child.number);
      subtasks.push(child);
    }
    if (values.length < 100) break;
  }
  return { issue, parent, subtasks };
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

export type GhPublicationExec = (args: string[], options: { cwd: string; input?: string }) => string;
const ghPublicationExec: GhPublicationExec = (args, options) => execFileSync("gh", args, { cwd: options.cwd, input: options.input, encoding: "utf8", timeout: 30_000, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });

function githubFailure(error: unknown): PublicationFailure {
  const value = error as { status?: number; stderr?: string | Buffer; publicationCode?: string };
  if (["auth", "permission", "rate_limit", "size", "unavailable"].includes(value.publicationCode ?? "")) return new PublicationFailure(value.publicationCode as "auth" | "permission" | "rate_limit" | "size" | "unavailable");
  const status = Number(value.status);
  const stderr = Buffer.isBuffer(value.stderr) ? value.stderr.toString("utf8") : String(value.stderr ?? "");
  if (status === 4 || /\b401\b|authentication/i.test(stderr)) return new PublicationFailure("auth");
  if (/\b403\b|forbidden|permission/i.test(stderr)) return new PublicationFailure("permission");
  if (/\b429\b|rate.?limit/i.test(stderr)) return new PublicationFailure("rate_limit");
  if (/\b413\b|too large|maximum size/i.test(stderr)) return new PublicationFailure("size");
  return new PublicationFailure("unavailable");
}

export function githubPublicationAdapter(project: { owner: string; repo: string; issueNumber: number; clonePath: string }, exec: GhPublicationExec = ghPublicationExec): PublicationAdapter {
  const repo = `${project.owner}/${project.repo}`;
  return {
    async list(): Promise<RemoteComment[]> {
      const comments: RemoteComment[] = [];
      const seen = new Set<string>();
      for (let page = 1; page <= 10_000; page++) {
        let raw: string;
        try { raw = exec(["api", `repos/${repo}/issues/${project.issueNumber}/comments?per_page=100&page=${page}`], { cwd: project.clonePath }); }
        catch (error) { throw githubFailure(error); }
        let values: unknown;
        try { values = JSON.parse(raw); } catch { throw new PublicationFailure("incomplete_listing"); }
        if (!Array.isArray(values)) throw new PublicationFailure("incomplete_listing");
        if (values.length === 0) return comments;
        for (const value of values) {
          if (!value || typeof value !== "object" || !("id" in value) || !("body" in value) || !["string", "number"].includes(typeof value.id) || typeof value.body !== "string") throw new PublicationFailure("incomplete_listing");
          const item = value as { id: string | number; body: string; html_url?: unknown };
          const id = String(item.id);
          if (seen.has(id)) throw new PublicationFailure("incomplete_listing");
          seen.add(id);
          comments.push({ id, text: item.body, ...(typeof item.html_url === "string" ? { url: item.html_url } : {}) });
        }
      }
      throw new PublicationFailure("incomplete_listing");
    },
    async add(body: string): Promise<void> {
      try { exec(["issue", "comment", String(project.issueNumber), "--repo", repo, "--body-file", "-"], { cwd: project.clonePath, input: body }); }
      catch (error) { throw githubFailure(error); }
    },
  };
}
