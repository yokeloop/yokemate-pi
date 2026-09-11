import { existsSync, lstatSync, realpathSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type ResearchRole = "worker" | "child";
export interface ResearchIdentity {
  root: string;
  id: string;
  project: string | null;
  projectPath: string | null;
  sessionId: string;
  role: ResearchRole;
  parentPane?: string;
}
export type ResearchVerdict = { ok: true } | { ok: false; reason: string };

export function researchIdentity(env: NodeJS.ProcessEnv = process.env, sessionId = "runtime"): ResearchIdentity | null {
  const id = env.YOKEMATE_RESEARCH_ID;
  const root = env.YOKEMATE_RESEARCH_ROOT;
  if (!id || !root) return null;
  const project = env.YOKEMATE_RESEARCH_PROJECT || null;
  const projectPath = env.YOKEMATE_RESEARCH_PROJECT_PATH || null;
  if (env.YOKEMATE_MODE !== "research") return { root: resolve(root), id, project, projectPath, sessionId, role: "worker" };
  return { root: resolve(root), id, project, projectPath, sessionId, role: env.YOKEMATE_RESEARCH_ROLE === "child" ? "child" : "worker", parentPane: env.YOKEMATE_PARENT_PANE };
}

function within(path: string, root: string): boolean {
  const r = relative(root, path);
  return r === "" || (!r.startsWith(".." + sep) && r !== ".." && !r.includes(".." + sep));
}

export function canonicalResearchTarget(target: string, root: string): string {
  const absolute = resolve(target);
  if (!within(absolute, resolve(root))) throw new Error(`target escapes its allowed root: ${target}`);
  let lexical = resolve(root);
  for (const part of relative(resolve(root), absolute).split(sep).filter(Boolean)) {
    lexical = resolve(lexical, part);
    if (existsSync(lexical) && lstatSync(lexical).isSymbolicLink())
      throw new Error(`symlink target is not writable: ${target}`);
  }
  let cursor = absolute;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`target has no existing parent: ${target}`);
    cursor = parent;
  }
  const canonicalParent = realpathSync(cursor);
  const suffix = relative(cursor, absolute);
  const canonical = resolve(canonicalParent, suffix);
  if (!within(canonical, root)) throw new Error(`target escapes its allowed root: ${target}`);
  let component = root;
  for (const part of relative(root, canonical).split(sep).filter(Boolean)) {
    component = resolve(component, part);
    if (!existsSync(component)) continue;
    const st = lstatSync(component);
    if (st.isSymbolicLink()) throw new Error(`symlink target is not writable: ${target}`);
    if (!st.isFile() && !st.isDirectory()) throw new Error(`special target is not writable: ${target}`);
    if (st.isFile() && st.nlink > 1) throw new Error(`hardlinked target is not writable: ${target}`);
  }
  return canonical;
}

export function digest(content: string | Buffer | null): string {
  return content === null ? "absent" : createHash("sha256").update(content).digest("hex");
}

export interface MutationRequest {
  identity: ResearchIdentity;
  target: string;
  finalContent: string;
  initialContent: string | null;
  toolCallId?: string;
  confirm?: (details: string) => Promise<boolean>;
  hasUI?: boolean;
  aborted?: boolean;
}

export async function authorizeResearchMutation(request: MutationRequest): Promise<ResearchVerdict> {
  const { identity } = request;
  if (identity.role !== "worker") return { ok: false, reason: "research child has no UI code-consent; return the proposed diff to its parent" };
  if (!identity.projectPath) return { ok: false, reason: "free-topic research has no code-write project" };
  if (!request.hasUI || !request.confirm) return { ok: false, reason: "research code changes require one interactive TUI consent" };
  let target: string;
  try { target = canonicalResearchTarget(request.target, identity.projectPath); }
  catch (e) { return { ok: false, reason: (e as Error).message }; }
  if (request.aborted) return { ok: false, reason: "research edit aborted before consent" };
  const before = request.initialContent ?? "(new file)";
  const details = [
    `Project: ${identity.project ?? "none"}`,
    `Target: ${target}`,
    `Research session: ${identity.id}; request: ${request.toolCallId ?? randomUUID()}`,
    "Current content:", before,
    "New content:", request.finalContent,
  ].join("\n");
  try {
    return (await request.confirm(details)) ? { ok: true } : { ok: false, reason: "research code edit was not approved" };
  } catch (e) { return { ok: false, reason: `research consent UI failed: ${(e as Error).message}` }; }
}

export function classifyResearchCall(identity: ResearchIdentity | null, toolName: string): ResearchVerdict {
  if (!identity) return { ok: true };
  if (process.env.YOKEMATE_MODE !== "research") return { ok: false, reason: "research identity is damaged; refusing tool dispatch" };
  if (["read", "grep", "find", "ls", "write", "edit", "bash", "mcp", "mcpScript", "subagent", "send_message"].includes(toolName)) return { ok: true };
  return { ok: false, reason: `research denies unknown tool ${toolName}` };
}

export interface ResearchChildLaunch {
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export function researchChildLaunch(identity: ResearchIdentity, cwd: string, readableRoots: string[]): ResearchChildLaunch {
  const canonical = resolve(cwd);
  if (!readableRoots.some((root) => within(canonical, resolve(root))))
    throw new Error(`research child cwd is outside readable roots: ${cwd}`);
  return {
    cwd: identity.root,
    env: {
      YOKEMATE_MODE: "research",
      YOKEMATE_RESEARCH_ID: identity.id,
      YOKEMATE_RESEARCH_ROOT: identity.root,
      YOKEMATE_RESEARCH_PROJECT: identity.project ?? "",
      YOKEMATE_RESEARCH_PROJECT_PATH: identity.projectPath ?? "",
      YOKEMATE_RESEARCH_ROLE: "child",
      YOKEMATE_PARENT_PANE: identity.parentPane ?? "",
    },
  };
}
