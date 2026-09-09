// Connect a repository to yokemate. Only what the repo cannot answer itself
// (R5.7): the tracker with its project key, the Figma MCP and design file, and
// the tracker value that scopes the repo when several repos share one project.
// Everything else is derived. No interactivity (R6.3) — flags only.
//
// Usage:
//   pnpm add-project <path-to-clone> --tracker acme:ACME --model openai-codex/gpt-5.6-terra
//     [--figma figma-acme] [--figma-file <url>] [--subsystem "Страница подписки"]
//   pnpm add-project <path-to-clone> --tracker github:DEMO --model openai-codex/gpt-5.6-terra
//
// `--model` is required: the model every launch for this project's tickets
// runs on (YM-84).

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { dataRoot } from "./data-root.ts";
import { openDb } from "./db.ts";
import { assertModel } from "./pi-model.ts";
import { writeManifest } from "./manifest.ts";
import { validGithubPrefix } from "./github.ts";
import { trackers } from "./trackers.ts";
import { enumValues } from "./youtrack.ts";

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const argv = process.argv.slice(2).filter((a) => a !== "--");
const pos: string[] = [];
let trackerArg: string | undefined;
let model: string | undefined;
let figma: string | null = null;
let figmaUrl: string | null = null;
let subsystem: string | null = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--tracker") trackerArg = argv[++i];
  else if (argv[i] === "--model") model = argv[++i];
  else if (argv[i] === "--figma") figma = argv[++i];
  else if (argv[i] === "--figma-file") figmaUrl = argv[++i];
  else if (argv[i] === "--subsystem") subsystem = argv[++i];
  else if (!argv[i].startsWith("--")) pos.push(argv[i]);
  else
    fail(
      `unknown flag ${argv[i]} — known: --tracker <name:KEY>, --model <m>, --figma <mcp-name>, ` +
        `--figma-file <url>, --subsystem <value>`,
    );
}

const clonePath = pos[0] ?? fail("usage: add-project <path-to-clone> --tracker <name:KEY> --model <m> [--figma <mcp>]");
const [trackerName, trackerKey] = (trackerArg ?? "").split(":");
if (!trackerName || !trackerKey)
  fail("--tracker is required as <name:KEY>, e.g. --tracker acme:ACME");
if (!model)
  fail(
    "--model is required — the model every launch for this project runs on, " +
      "e.g. --model openai-codex/gpt-5.6-terra",
  );
assertModel(model);
const github = trackerName === "github";
if (github && !validGithubPrefix(trackerKey))
  fail(`--tracker github:${trackerKey} — префикс uppercase, буквы и цифры, e.g. --tracker github:DEMO`);
if (github && subsystem !== null)
  fail("--subsystem — enum YouTrack-проекта; для github-трекера не принимается");
const tracker = github
  ? null
  : (trackers().find((t) => t.name === trackerName) ??
    fail(
      `unknown tracker "${trackerName}" — configured: ${trackers().map((t) => t.name).join(", ")}`,
    ));

// The subsystem is an enum in the tracker, not free text: a typo here would
// silently route a repo's tickets nowhere. So the value is checked against what
// the project actually offers, and the field it belongs to is reported — the
// field's name is a per-tracker convention we never hardcode. Most projects
// have no such field at all, and the flag stays unused.
let subsystemField = "";
if (tracker && subsystem !== null) {
  const fields = await enumValues(tracker, trackerKey);
  const hit = [...fields].filter(([, vals]) => vals.includes(subsystem!));
  if (hit.length === 0) {
    const menu = [...fields]
      .filter(([, vals]) => vals.length <= 20)
      .map(([f, vals]) => `  ${f}: ${vals.join(" · ")}`)
      .join("\n");
    fail(
      `${trackerName}:${trackerKey} has no value "${subsystem}".\n` +
        (menu ? `values on offer:\n${menu}` : "this project offers no enum values"),
    );
  }
  subsystemField = hit.map(([f]) => f).join("/");
}

// Org comes from the remote, normalized to lowercase (R0.12): ACME-EU and acme-eu
// are one organization with two spellings.
let remote: string;
try {
  remote = execFileSync("git", ["-C", clonePath, "remote", "get-url", "origin"], {
    encoding: "utf8",
  }).trim();
} catch {
  fail(`${clonePath}: not a git clone or no "origin" remote`);
}
const m = remote.match(/[:/]([^/:]+)\/([^/]+?)(\.git)?$/);
if (!m) fail(`cannot parse org/repo from remote "${remote}"`);
const org = m[1].toLowerCase();
const repo = m[2];

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const db = openDb(join(ROOT, "yokemate.db"));
if (github) {
  const taken = db
    .prepare("SELECT org, repo FROM project WHERE tracker_key = ? AND NOT (org = ? AND repo = ?)")
    .get(trackerKey, org, repo) as { org: string; repo: string } | undefined;
  if (taken) fail(`prefix ${trackerKey} is already taken by ${taken.org}/${taken.repo}`);
}
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
).run(org, repo, resolve(clonePath), trackerName, trackerKey, model, figma, figmaUrl, subsystem);
writeManifest(db, dataRoot(ROOT));

// Knowledge moves in once, at connection time (R5.8): whatever the clone's
// .yoke/ accumulated — glossary, ADRs, task artifacts — lands in knowledge/.
// The clone itself is left untouched, committed .yoke/ included (R0.5).
const src = join(resolve(clonePath), ".yoke");
const dst = join(dataRoot(ROOT), "knowledge", org, repo);
let imported = "";
if (existsSync(src)) {
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true, force: false, errorOnExist: false });
  const adr = existsSync(join(dst, "adr"))
    ? readdirSync(join(dst, "adr")).length
    : 0;
  imported = ` · knowledge imported (${adr} ADR)`;
} else {
  mkdirSync(dst, { recursive: true });
  imported = " · no .yoke/ in clone, knowledge starts empty";
}

console.log(
  `${org}/${repo} → ${trackerName} (${trackerKey})` +
    (subsystem ? ` · ${subsystemField}: ${subsystem}` : "") +
    (figma ? ` · ${figma}` : "") +
    (figmaUrl ? ` · design file` : "") +
    imported +
    " · projects.json updated",
);
