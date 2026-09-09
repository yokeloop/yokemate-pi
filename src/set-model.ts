// Change the model on every passport of one tracker key at once. The model
// lives per passport row but resolves per key (src/project-model.ts): the
// passports of a key must agree, so the change never lands on a subset.
// A repeated add-project is not the way — its upsert overwrites figma_mcp,
// figma_url and subsystem with the flags given, and a flag not passed wipes
// the field to NULL.
//
// This is the way to change a model — the project default, one panel mode, or
// both — without losing the rest of the passport. What is not named here is
// left as it stands, per-mode overrides included; taking an override off is
// the one thing this command cannot do, and it takes a repeated add-project
// without that token (YM-159).
//
// Usage: pnpm set-model <KEY> [<model>] [<mode>=<model> …]
//   e.g. pnpm set-model YM openai-codex/gpt-5.6-terra review=openai-codex/gpt-5.6-luna

import { join, resolve } from "node:path";
import { dataRoot } from "./data-root.ts";
import { openDb } from "./db.ts";
import { assertModel } from "./pi-model.ts";
import { writeManifest } from "./manifest.ts";
import {
  parseModeModels,
  parseModelToken,
  serializeModeModels,
  type ModeModels,
} from "./project-model.ts";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const usage = "usage: set-model <KEY> [<model>] [<mode>=<model> …]";

const argv = process.argv.slice(2).filter((a) => a !== "--");
const key = argv[0] ?? fail(usage);
const tokens = argv.slice(1);
if (tokens.length === 0) fail(usage);

let def: string | undefined;
const overrides: ModeModels = {};
for (const token of tokens) {
  // `fail` возвращает never, поэтому IIFE даёт типизированный результат
  // без «used before assigned».
  const parsed = (() => {
    try {
      return parseModelToken(token);
    } catch (e) {
      return fail((e as Error).message);
    }
  })();
  if (parsed.mode === null) {
    if (def !== undefined)
      fail("the project default is given twice — a per-mode value is written as <mode>=<pattern>");
    def = parsed.model;
  } else overrides[parsed.mode] = parsed.model;
}

if (def) assertModel(def);
for (const m of Object.values(overrides)) assertModel(m);

const db = openDb(join(ROOT, "yokemate.db"));
// Row by row: the passports of one key may hold different maps, and this
// command changes only the modes it was given.
const rows = db
  .prepare("SELECT id, org, repo, mode_models FROM project WHERE tracker_key = ?")
  .all(key) as unknown as { id: number; org: string; repo: string; mode_models: string | null }[];
if (rows.length === 0) fail(`no passports with key ${key}`);
const upd = db.prepare("UPDATE project SET model = COALESCE(?, model), mode_models = ? WHERE id = ?");
for (const r of rows)
  upd.run(
    def ?? null,
    serializeModeModels({ ...parseModeModels(r.mode_models), ...overrides }),
    r.id,
  );

const repos = rows.map((r) => `${r.org}/${r.repo}`);
writeManifest(db, dataRoot(ROOT));
console.log(
  `${key} → ${[def, ...Object.entries(overrides).map(([k, v]) => `${k}=${v}`)]
    .filter(Boolean)
    .join(", ")} (${rows.length} passports: ${repos.join(", ")}) · projects.json updated`,
);
