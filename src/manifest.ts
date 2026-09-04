// The passport manifest: projects.json in the yokemate root, in git — the
// portable half of the project table. The machine-local path stays out; the
// remote goes in, so import-projects on another machine can re-clone. Written
// by add-project/set-model after every passport change, read by
// import-projects.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export interface ManifestEntry {
  org: string;
  repo: string;
  remote: string;
  tracker: string;
  tracker_key: string;
  model: string;
  figma_mcp: string | null;
  figma_url: string | null;
  subsystem: string | null;
}

const REQUIRED = ["org", "repo", "remote", "tracker", "tracker_key", "model"] as const;

function manifestPath(root: string): string {
  return join(root, "projects.json");
}

/** Project the passport table into projects.json, sorted by org/repo. A row
 * whose clone cannot answer `remote get-url origin` keeps the remote the
 * existing manifest already has; with neither, the row is skipped with a
 * warning — a manifest entry without a remote cannot be imported anywhere. */
export function writeManifest(db: DatabaseSync, root: string): number {
  const rows = db
    .prepare(
      `SELECT org, repo, path, tracker, tracker_key, model, figma_mcp, figma_url, subsystem
       FROM project ORDER BY org, repo`,
    )
    .all() as unknown as (ManifestEntry & { path: string })[];

  let prior = new Map<string, ManifestEntry>();
  try {
    prior = new Map(readManifest(root).map((e) => [`${e.org}/${e.repo}`, e]));
  } catch {
    // no manifest yet, or an unreadable one — nothing to fall back on
  }

  const entries: ManifestEntry[] = [];
  for (const { path, ...row } of rows) {
    let remote: string | undefined;
    try {
      remote = execFileSync("git", ["-C", path, "remote", "get-url", "origin"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      remote = prior.get(`${row.org}/${row.repo}`)?.remote;
    }
    if (!remote) {
      console.warn(
        `${row.org}/${row.repo}: clone at ${path} unreachable and no prior manifest entry — skipped`,
      );
      continue;
    }
    entries.push({
      org: row.org,
      repo: row.repo,
      remote,
      tracker: row.tracker,
      tracker_key: row.tracker_key,
      model: row.model,
      figma_mcp: row.figma_mcp,
      figma_url: row.figma_url,
      subsystem: row.subsystem,
    });
  }

  writeFileSync(manifestPath(root), JSON.stringify(entries, null, 2) + "\n");
  return entries.length;
}

/** Parse projects.json, refusing entries that could not be imported. */
export function readManifest(root: string): ManifestEntry[] {
  let raw: string;
  try {
    raw = readFileSync(manifestPath(root), "utf8");
  } catch {
    throw new Error(`no projects.json in ${root} — run pnpm export-projects on a live machine first`);
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("projects.json: expected a top-level array");
  for (const entry of parsed) {
    for (const field of REQUIRED) {
      if (typeof entry[field] !== "string" || entry[field] === "")
        throw new Error(
          `projects.json: entry ${entry.org ?? "?"}/${entry.repo ?? "?"} is missing "${field}"`,
        );
    }
  }
  return parsed as ManifestEntry[];
}
