// The manifest replayed onto this machine: for every projects.json entry with
// no local passport — clone into projects/<org>/<repo> when nothing stands
// there, then upsert the passport with that path. Existing passports are never
// touched: their path is this machine's choice. Knowledge is not imported —
// knowledge/ arrives with the yokemate clone itself; the .yoke/ import is the
// one-time act of connection that already happened on the first machine.
//
// Usage: pnpm import-projects [--only <org/repo>]

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { dataRoot as dataRootOf } from "./data-root.ts";
import { openDb } from "./db.ts";
import { readManifest, type ManifestEntry } from "./manifest.ts";

export type ImportDecision = "skip" | "clone" | "upsert";

/** A passport means this machine already decided where the repo lives — skip.
 * Otherwise the clone's presence decides how much work is left. */
export function decideImport(hasPassport: boolean, cloneExists: boolean): ImportDecision {
  if (hasPassport) return "skip";
  return cloneExists ? "upsert" : "clone";
}

function upsertPassport(db: DatabaseSync, e: ManifestEntry, path: string): void {
  db.prepare(
    `INSERT INTO project (org, repo, path, tracker, tracker_key, model, figma_mcp, figma_url, subsystem)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (org, repo) DO UPDATE
       SET path = excluded.path,
           tracker = excluded.tracker,
           tracker_key = excluded.tracker_key,
           model = excluded.model,
           figma_mcp = excluded.figma_mcp,
           figma_url = excluded.figma_url,
           subsystem = excluded.subsystem`,
  ).run(e.org, e.repo, path, e.tracker, e.tracker_key, e.model, e.figma_mcp, e.figma_url, e.subsystem);
}

export function importProjects(
  db: DatabaseSync,
  root: string,
  dataRoot: string,
  only?: string,
): void {
  let entries = readManifest(dataRoot);
  if (only) {
    entries = entries.filter((e) => `${e.org}/${e.repo}` === only);
    if (entries.length === 0)
      throw new Error(`no manifest entry ${only} — check projects.json for the exact org/repo`);
  }

  const counts = { skip: 0, clone: 0, upsert: 0 };
  for (const entry of entries) {
    const path = join(root, "projects", entry.org, entry.repo);
    const hasPassport = !!db
      .prepare("SELECT 1 FROM project WHERE org = ? AND repo = ?")
      .get(entry.org, entry.repo);
    const decision = decideImport(hasPassport, existsSync(path));
    counts[decision]++;
    if (decision === "skip") {
      console.log(`${entry.org}/${entry.repo}: passport exists — skipped`);
      continue;
    }
    if (decision === "clone") {
      mkdirSync(dirname(path), { recursive: true });
      execFileSync("git", ["clone", entry.remote, path], { stdio: "inherit" });
    }
    upsertPassport(db, entry, path);
    console.log(
      `${entry.org}/${entry.repo}: ${decision === "clone" ? "cloned and " : "clone in place, "}passport written`,
    );
  }
  console.log(
    `${entries.length} manifest entries: ${counts.clone} cloned, ${counts.upsert} adopted, ${counts.skip} skipped`,
  );
}

if (import.meta.filename === process.argv[1]) {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  let only: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only") {
      only = argv[++i];
      if (only === undefined || only.startsWith("--")) {
        console.error("--only needs a value — usage: import-projects [--only <org/repo>]");
        process.exit(1);
      }
    } else {
      console.error(`unknown argument ${argv[i]} — usage: import-projects [--only <org/repo>]`);
      process.exit(1);
    }
  }
  const ROOT = resolve(new URL("..", import.meta.url).pathname);
  const db = openDb(join(ROOT, "yokemate.db"));
  try {
    importProjects(db, ROOT, dataRootOf(ROOT), only);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
