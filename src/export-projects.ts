// One-shot export of the passport table into projects.json — the first fill
// on a machine whose passports predate the manifest, and the repair when the
// file and the db diverge. Day to day the manifest keeps itself: add-project
// and set-model write it on every change.
//
// Usage: pnpm export-projects

import { join, resolve } from "node:path";
import { openDb } from "./db.ts";
import { writeManifest } from "./manifest.ts";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const db = openDb(join(ROOT, "yokemate.db"));
const count = writeManifest(db, ROOT);
console.log(`projects.json written: ${count} passports`);
