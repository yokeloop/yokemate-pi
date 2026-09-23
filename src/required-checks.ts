import { parse } from "yaml";

export interface RequiredJob {
  workflow: string;
  job: string;
}

type Triggers = string | string[] | Record<string, unknown> | null | undefined;

function runsOnSynchronize(on: Triggers): boolean {
  if (typeof on === "string") return on === "pull_request";
  if (Array.isArray(on)) return on.includes("pull_request");
  if (!on || typeof on !== "object" || !("pull_request" in on)) return false;
  const pullRequest = on.pull_request as { types?: unknown } | null | undefined;
  const types = pullRequest?.types;
  if (types === undefined || types === null) return true;
  if (typeof types === "string") return types === "synchronize";
  return Array.isArray(types) && types.includes("synchronize");
}

export function requiredJobs(files: { path: string; text: string }[]): RequiredJob[] {
  const required: RequiredJob[] = [];
  for (const file of files) {
    if (!/\.ya?ml$/.test(file.path)) continue;
    const doc = parse(file.text) as { name?: unknown; on?: Triggers; jobs?: Record<string, { name?: unknown; if?: unknown } | null> } | null;
    if (!doc || !runsOnSynchronize(doc.on)) continue;
    const workflow = typeof doc.name === "string" ? doc.name : file.path;
    for (const [id, job] of Object.entries(doc.jobs ?? {})) {
      if (job?.if !== undefined) continue;
      required.push({ workflow, job: typeof job?.name === "string" ? job.name : id });
    }
  }
  return required;
}
