// The passport manifest: projects.json in the data root home/, in the
// engineer's own git — the portable half of the project table. The machine-local path stays out; the
// remote goes in, so import-projects on another machine can re-clone. Written
// by add-project/set-model after every passport change, read by
// import-projects. The per-mode model map rides along as an optional object
// field, so a manifest written before it reads without complaint (YM-159).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { MODES } from "./mode-guard.ts";
import { parseModeModels, type ModeModels } from "./project-model.ts";

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
  mode_models: ModeModels | null;
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
      `SELECT org, repo, path, tracker, tracker_key, model, figma_mcp, figma_url, subsystem,
              mode_models
       FROM project ORDER BY org, repo`,
    )
    .all() as unknown as (Omit<ManifestEntry, "remote" | "mode_models"> & {
      path: string;
      mode_models: string | null;
    })[];

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
      mode_models: (() => {
        const map = parseModeModels(row.mode_models);
        return Object.keys(map).length === 0 ? null : map;
      })(),
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
    throw new Error(
      `no projects.json in ${root} — personal data (home/) is not set up: see scripts/bootstrap.sh, ` +
        `or run pnpm export-projects on a live machine`,
    );
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
    // The map is optional, but a hand-edited one must not lose overrides in
    // silence: what is there is checked, what is absent is no overrides.
    const mm = entry.mode_models;
    if (mm !== undefined && mm !== null) {
      const who = `${entry.org ?? "?"}/${entry.repo ?? "?"}`;
      if (typeof mm !== "object" || Array.isArray(mm))
        throw new Error(
          `projects.json: entry ${who}: "mode_models" must be an object of "<mode>": "<model>" pairs`,
        );
      for (const [k, v] of Object.entries(mm)) {
        if (!(MODES as readonly string[]).includes(k))
          throw new Error(
            `projects.json: entry ${who}: unknown mode "${k}" in mode_models — ` +
              `the panel modes are: ${MODES.join(", ")}`,
          );
        if (typeof v !== "string" || v === "")
          throw new Error(`projects.json: entry ${who}: mode_models.${k} must be a model pattern`);
      }
    }
  }
  return parsed as ManifestEntry[];
}
