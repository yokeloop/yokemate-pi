import type { DatabaseSync } from "node:sqlite";
import { fetchSubIssues, type GhExec, type GithubProject, type RemoteOf } from "./github.ts";
import { canonicalHash } from "./group-state.ts";
import { resolvePublicationTarget } from "./plan-publication-target.ts";
import type { Tracker } from "./trackers.ts";
import { fetchHierarchy } from "./youtrack.ts";

export interface TaskTreeSourceNode {
  identity: string;
  ticket: string;
  parentIdentities: string[];
  childrenIdentities: string[];
  trackerState: string;
  snapshot: unknown;
}

export interface TaskTreeNode {
  identity: string;
  ticket: string;
  parentIdentity: string | null;
  issueSnapshotHash: string;
  trackerState: string;
}

export interface TaskTree {
  root: TaskTreeNode;
  nodes: TaskTreeNode[];
  treeHash: string;
}

export type TaskTreeFetcher = (identity: string) => Promise<TaskTreeSourceNode>;

export interface DurableGroupMemberTopology { memberIdentity: string; parentIdentity: string | null; execution: string }

export function assertCurrentTaskTree(tree: TaskTree, members: DurableGroupMemberTopology[]): void {
  const current = new Map(tree.nodes.map((node) => [node.identity, node]));
  if (members.length !== current.size || members.some((member) => current.get(member.memberIdentity)?.parentIdentity !== member.parentIdentity)) throw new Error("tracker group topology changed; rediscovery and replanning are required");
  const unsupportedClosed = members.find((member) => current.get(member.memberIdentity)?.trackerState.toLowerCase() === "closed" && member.execution !== "integrated");
  if (unsupportedClosed) throw new Error(`${unsupportedClosed.memberIdentity}: tracker is closed without preserved integrated evidence`);
}

export async function discoverTaskTree(rootIdentity: string, fetchNode: TaskTreeFetcher): Promise<TaskTree> {
  if (!rootIdentity) throw new Error("incomplete_tree: root identity is missing");
  const source = new Map<string, TaskTreeSourceNode>();
  const parent = new Map<string, string | null>([[rootIdentity, null]]);
  const queue = [rootIdentity];
  while (queue.length) {
    const identity = queue.shift()!;
    if (source.has(identity)) continue;
    const node = await fetchNode(identity);
    if (node.identity !== identity || !node.ticket || new Set(node.childrenIdentities).size !== node.childrenIdentities.length || new Set(node.parentIdentities).size !== node.parentIdentities.length) throw new Error(`incomplete_tree: invalid hierarchy node ${identity}`);
    if (node.parentIdentities.length > 1) throw new Error(`ambiguous_membership: ${node.ticket} has multiple parents`);
    const expectedParent = parent.get(identity) ?? null;
    if (identity !== rootIdentity) {
      if (node.parentIdentities.length !== 1 || node.parentIdentities[0] !== expectedParent) throw new Error(`ambiguous_membership: ${node.ticket} parent does not match the discovered edge`);
    }
    source.set(identity, node);
    for (const child of node.childrenIdentities) {
      if (child === identity) throw new Error(`ambiguous_membership: hierarchy cycle at ${node.ticket}`);
      let ancestor: string | null = identity;
      while (ancestor) {
        if (ancestor === child) throw new Error(`ambiguous_membership: hierarchy cycle through ${child}`);
        ancestor = parent.get(ancestor) ?? null;
      }
      if (parent.has(child) && parent.get(child) !== identity) throw new Error(`ambiguous_membership: ${child} has multiple parents`);
      parent.set(child, identity);
      if (!source.has(child)) queue.push(child);
    }
  }
  const ordered: TaskTreeNode[] = [];
  const append = (identity: string): void => {
    const node = source.get(identity);
    if (!node) throw new Error(`incomplete_tree: ${identity} was not fetched`);
    ordered.push({ identity, ticket: node.ticket, parentIdentity: parent.get(identity) ?? null, issueSnapshotHash: canonicalHash(node.snapshot), trackerState: node.trackerState });
    for (const child of node.childrenIdentities) append(child);
  };
  append(rootIdentity);
  const treeIdentity = ordered.map(({ identity, ticket, parentIdentity, issueSnapshotHash, trackerState }) => ({ identity, ticket, parentIdentity, issueSnapshotHash, trackerState }));
  const treeHash = canonicalHash({ version: 1, rootIdentity, nodes: treeIdentity });
  return { root: ordered[0]!, nodes: ordered, treeHash };
}

export interface TrackerTreeDeps {
  trackers: Tracker[];
  fetchImpl?: typeof fetch;
  ghExec?: GhExec;
  remoteOf?: RemoteOf;
}

export async function discoverTaskTreeForTicket(db: DatabaseSync, ticket: string, deps: TrackerTreeDeps): Promise<TaskTree> {
  const target = resolvePublicationTarget(db, ticket, deps.remoteOf);
  if (target.type === "youtrack") {
    const trackerName = target.server.replace(/^youtrack-/, "");
    const tracker = deps.trackers.find((candidate) => candidate.name === trackerName);
    if (!tracker) throw new Error(`incomplete_tree: tracker ${trackerName} is unavailable`);
    const prefix = ticket.split("-")[0]!;
    const identity = (key: string) => `${target.server}:${key}`;
    return discoverTaskTree(identity(ticket), async (current) => {
      const key = current.slice(current.lastIndexOf(":") + 1);
      if (key.split("-")[0] !== prefix) throw new Error(`ambiguous_membership: ${key} has no unambiguous passport in the root project`);
      const hierarchy = await fetchHierarchy(tracker, key, deps.fetchImpl);
      return {
        identity: identity(key),
        ticket: key,
        parentIdentities: hierarchy.parents.map((issue) => identity(issue.idReadable)),
        childrenIdentities: hierarchy.subtasks.map((issue) => identity(issue.idReadable)),
        trackerState: hierarchy.issue.resolved == null ? "open" : "closed",
        snapshot: hierarchy.issue,
      };
    });
  }
  const projectRows = db.prepare("SELECT org,repo,path,tracker_key FROM project WHERE tracker='github' AND tracker_key=?").all(ticket.split("-")[0]) as unknown as { org: string; repo: string; path: string; tracker_key: string }[];
  if (projectRows.length !== 1) throw new Error("ambiguous_membership: GitHub prefix does not select exactly one passport");
  const project: GithubProject = { org: target.owner, repo: target.repo, path: projectRows[0]!.path, prefix: projectRows[0]!.tracker_key };
  const identity = (number: number) => `github:${target.owner}/${target.repo}#${number}`;
  return discoverTaskTree(target.target, async (current) => {
    const match = /#(\d+)$/.exec(current);
    if (!match) throw new Error(`incomplete_tree: invalid GitHub identity ${current}`);
    const hierarchy = fetchSubIssues(project, Number(match[1]), deps.ghExec);
    return {
      identity: identity(hierarchy.issue.number),
      ticket: `${project.prefix}-${hierarchy.issue.number}`,
      parentIdentities: hierarchy.parent ? [identity(hierarchy.parent.number)] : [],
      childrenIdentities: hierarchy.subtasks.map((issue) => identity(issue.number)),
      trackerState: hierarchy.issue.state,
      snapshot: hierarchy.issue,
    };
  });
}
