import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataRoot } from "./data-root.ts";
import { type ModeModels, rowModel } from "./project-model.ts";
import { poolModel } from "./pool.ts";

export interface ResearchProject {
  org: string;
  repo: string;
  path: string;
  tracker: string;
  tracker_key: string;
  subsystem: string | null;
}

export interface ResearchContext {
  project: ResearchProject | null;
  topic: string;
  knowledgeDir: string | null;
  notesDir: string;
  model: string;
}

type ProjectRow = ResearchProject & { model: string | null; mode_models: string | null };

export interface ResearchArgs {
  project?: string;
  model?: string;
  forceTopic: boolean;
  words: string[];
}

export function parseResearchArgs(argv: string[]): ResearchArgs {
  let project: string | undefined;
  let model: string | undefined;
  let forceTopic = false;
  const words: string[] = [];
  let positional = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") { positional = true; continue; }
    if (!positional && arg === "--project") {
      project = argv[++i] ?? (() => { throw new Error("--project needs org/repo, repo, or KEY"); })();
      continue;
    }
    if (!positional && arg === "--model") {
      model = argv[++i] ?? (() => { throw new Error("--model needs a value"); })();
      continue;
    }
    if (!positional && arg === "--topic") { forceTopic = true; continue; }
    if (!positional && arg.startsWith("--")) throw new Error(`unknown research option ${arg}`);
    words.push(arg);
  }
  if (words.length === 0 && !project) throw new Error("usage: research [--project <org/repo|repo|KEY>] [--model <m>] [--topic] <text…>");
  return { project, model, forceTopic, words };
}

function rows(root: string): ProjectRow[] {
  const db = new DatabaseSync(join(root, "yokemate.db"), { readOnly: true });
  try {
    return db.prepare("SELECT org, repo, path, tracker, tracker_key, subsystem, model, mode_models FROM project")
      .all() as unknown as ProjectRow[];
  } finally { db.close(); }
}

function describe(matches: ProjectRow[]): string {
  return matches.map((p) => `${p.org}/${p.repo}`).sort().join(", ");
}

export function resolveResearchProject(root: string, token: string, explicit = false): ResearchProject | null {
  const needle = token.toLowerCase();
  const all = rows(root);
  const byFull = all.filter((p) => `${p.org}/${p.repo}`.toLowerCase() === needle);
  const byRepo = byFull.length ? byFull : all.filter((p) => p.repo.toLowerCase() === needle);
  const byKey = byRepo.length ? byRepo : all.filter((p) => p.tracker_key.toLowerCase() === needle);
  if (byKey.length === 0) {
    if (explicit || token.includes("/")) throw new Error(`no research project "${token}" — add a passport first`);
    return null;
  }
  if (byKey.length > 1) throw new Error(`research project "${token}" is ambiguous: ${describe(byKey)}`);
  const row = byKey[0]!;
  if (!existsSync(row.path)) throw new Error(`research clone does not exist: ${row.path}`);
  return {
    org: row.org,
    repo: row.repo,
    path: realpathSync(row.path),
    tracker: row.tracker,
    tracker_key: row.tracker_key,
    subsystem: row.subsystem,
  };
}

function projectModel(root: string, p: ResearchProject): string | null {
  const row = rows(root).find((r) => r.org === p.org && r.repo === p.repo);
  return row ? rowModel(row as { model: string | null; mode_models: string | null }, "research") : null;
}

export function resolveResearchContext(root: string, argv: string[]): ResearchContext {
  const args = parseResearchArgs(argv);
  let project: ResearchProject | null = null;
  let topicWords = args.words;
  if (args.project) project = resolveResearchProject(root, args.project, true);
  else if (!args.forceTopic && args.words.length) {
    const candidate = resolveResearchProject(root, args.words[0]!);
    if (candidate) { project = candidate; topicWords = args.words.slice(1); }
  }
  const topic = topicWords.join(" ").trim() || (project ? "обзор проекта" : "");
  if (!topic) throw new Error("usage: research [--project <org/repo|repo|KEY>] [--model <m>] [--topic] <text…>");
  const rootData = dataRoot(root);
  const model = args.model ?? (project ? projectModel(root, project) : poolModel(rootData, "research"));
  if (!model)
    throw new Error(`no research model for ${project!.org}/${project!.repo} — pass --model or set research=<pattern> on its passport`);
  return {
    project,
    topic,
    knowledgeDir: project ? join(rootData, "knowledge", project.org, project.repo) : null,
    notesDir: join(rootData, "notes"),
    model,
  };
}

export interface ResearchLaunch extends ResearchContext {
  id: string;
  agentName: string;
  label: string;
  prompt: string;
  env: string[];
}

export function resolveResearchLaunch(root: string, argv: string[], id = crypto.randomUUID()): ResearchLaunch {
  const context = resolveResearchContext(root, argv);
  const short = id.replace(/-/g, "").slice(0, 8);
  const subject = context.project ? `${context.project.org}/${context.project.repo}` : context.topic.slice(0, 48);
  return {
    ...context,
    id,
    agentName: `research-${short}`,
    label: `research-${short} ${subject}`,
    prompt: `/skill:research-worker ${context.topic}`,
    env: [
      "YOKEMATE_MODE=research",
      `YOKEMATE_RESEARCH_ID=${id}`,
      `YOKEMATE_RESEARCH_PROJECT=${context.project ? `${context.project.org}/${context.project.repo}` : ""}`,
      `YOKEMATE_RESEARCH_PROJECT_PATH=${context.project?.path ?? ""}`,
      `YOKEMATE_RESEARCH_TRACKER_KEY=${context.project?.tracker_key ?? ""}`,
      `YOKEMATE_RESEARCH_TRACKER=${context.project?.tracker ?? ""}`,
      `YOKEMATE_RESEARCH_ROOT=${resolve(root)}`,
    ],
  };
}

export function researchAgentArgs(root: string, model: string): string[] {
  return ["--model", model, "--skill", join(root, ".pi", "skills"), "--no-extensions", "--no-builtin-tools", "-e", join(root, "src", "research.ts")];
}
