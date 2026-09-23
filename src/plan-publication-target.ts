import { execFileSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { originOwnerRepo, ticketNumber, type RemoteOf } from "./github.ts";
import { sha256 } from "./subagent-runs.ts";
import { assertMandatoryBoundary } from "./workflow-boundaries.ts";

export type TargetResolutionError = "target_unavailable" | "remote_conflict";
export class PublicationTargetFailure extends Error {
  code: TargetResolutionError;
  constructor(code: TargetResolutionError) { super(code); this.code = code; }
}

export type PublicationTarget = {
  type: "youtrack";
  target: string;
  targetHash: string;
  server: string;
  issueId: string;
  visibleTarget: string;
} | {
  type: "github";
  target: string;
  targetHash: string;
  owner: string;
  repo: string;
  issueNumber: number;
  clonePath: string;
  canonicalUrl: string;
  visibleTarget: string;
};

const gitRemote: RemoteOf = (path) => execFileSync("git", ["-C", path, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function githubHost(remote: string): string | undefined {
  const value = remote.trim();
  const ssh = /^(?:ssh:\/\/)?git@([^/:]+)[:/]/.exec(value);
  if (ssh) return ssh[1]!.toLowerCase();
  try { return new URL(value).hostname.toLowerCase(); } catch { return undefined; }
}

export function publicationTargetLabel(db: DatabaseSync, ticket: string): string {
  const prefix = ticket.split("-")[0]!;
  const rows = db.prepare("SELECT org,repo,tracker FROM project WHERE tracker_key=? ORDER BY id").all(prefix) as unknown as { org: string; repo: string; tracker: string }[];
  const trackers = new Set(rows.map((row) => row.tracker));
  if (trackers.size === 1) {
    const tracker = rows[0]!.tracker;
    if (tracker !== "github") return `youtrack-${tracker}/${ticket}`;
    const repositories = new Set(rows.map((row) => `${row.org}/${row.repo}`));
    if (repositories.size === 1) return `${rows[0]!.org}/${rows[0]!.repo}#${ticketNumber(ticket)}`;
  }
  return `unresolved/${ticket}`;
}

export function resolvePublicationTarget(db: DatabaseSync, ticket: string, remoteOf: RemoteOf = gitRemote): PublicationTarget {
  const prefix = ticket.split("-")[0]!;
  const rows = db.prepare("SELECT tracker,tracker_key,path FROM project WHERE tracker_key=? ORDER BY id").all(prefix) as unknown as { tracker: string; tracker_key: string; path: string }[];
  try { assertMandatoryBoundary("workflow.required-data", rows.length > 0, "publication target unavailable"); }
  catch { throw new PublicationTargetFailure("target_unavailable"); }
  const trackers = new Set(rows.map((row) => row.tracker));
  try { assertMandatoryBoundary("workflow.target-identity", trackers.size === 1, "publication target conflict"); }
  catch { throw new PublicationTargetFailure("remote_conflict"); }
  const tracker = rows[0]!.tracker;
  if (tracker !== "github") {
    const server = `youtrack-${tracker}`;
    const target = `${server}:${ticket}`;
    return { type: "youtrack", target, targetHash: sha256(target), server, issueId: ticket, visibleTarget: `${server}/${ticket}` };
  }
  let identities: { owner: string; repo: string; path: string }[];
  try {
    identities = rows.map((row) => {
      const remote = remoteOf(row.path);
      if (githubHost(remote) !== "github.com") throw new PublicationTargetFailure("target_unavailable");
      const { owner, repo } = originOwnerRepo(row.path, () => remote);
      return { owner, repo, path: row.path };
    });
  } catch (error) {
    if (error instanceof PublicationTargetFailure) throw error;
    throw new PublicationTargetFailure("target_unavailable");
  }
  const distinct = new Set(identities.map((item) => `${item.owner.toLowerCase()}/${item.repo.toLowerCase()}`));
  if (distinct.size !== 1) throw new PublicationTargetFailure("remote_conflict");
  const identity = identities[0]!;
  const issueNumber = ticketNumber(ticket);
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new PublicationTargetFailure("target_unavailable");
  const target = `github:${identity.owner}/${identity.repo}#${issueNumber}`;
  const canonicalUrl = `https://github.com/${identity.owner}/${identity.repo}/issues/${issueNumber}`;
  return { type: "github", target, targetHash: sha256(target), owner: identity.owner, repo: identity.repo, issueNumber, clonePath: identity.path, canonicalUrl, visibleTarget: canonicalUrl };
}
