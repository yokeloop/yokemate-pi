// Change the model on every passport of one tracker key at once. The model
// lives per passport row but resolves per key (src/project-model.ts): the
// passports of a key must agree, so the change never lands on a subset.
// A repeated add-project is not the way — its upsert overwrites figma_mcp,
// figma_url and subsystem with the flags given, and a flag not passed wipes
// the field to NULL.
//
// Usage: pnpm set-model <KEY> <model>

import { join, resolve } from "node:path";
import { openDb } from "./db.ts";
import { writeManifest } from "./manifest.ts";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const argv = process.argv.slice(2).filter((a) => a !== "--");
const key = argv[0] ?? fail("usage: set-model <KEY> <model>");
const model = argv[1] ?? fail("usage: set-model <KEY> <model>");

const db = openDb(join(ROOT, "yokemate.db"));
const { changes } = db.prepare("UPDATE project SET model = ? WHERE tracker_key = ?").run(model, key);
if (changes === 0) fail(`no passports with key ${key}`);

const repos = (
  db.prepare("SELECT org, repo FROM project WHERE tracker_key = ?").all(key) as unknown as
    { org: string; repo: string }[]
).map((r) => `${r.org}/${r.repo}`);
writeManifest(db, ROOT);
console.log(
  `${key} → ${model} (${repos.length} passports: ${repos.join(", ")}) · projects.json updated`,
);
