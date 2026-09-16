import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseAffected } from "./adopt.ts";
import { dataRoot } from "./data-root.ts";

export interface PlanBinding { ticket: string; path: string; contentHash: string; scopeHash: string; repositories: string[] }
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const contained = (root: string, path: string) => { const r = relative(root, path); return r !== "" && r !== ".." && !r.startsWith("../") && !isAbsolute(r); };

export function readRecordedPlanBinding(root: string, ticket: string): PlanBinding {
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(ticket)) throw new Error(`invalid approval ticket ${ticket}`);
  if (!existsSync(join(root, "yokemate.db"))) throw new Error(`${ticket}: no current recorded plan for approval: ${join(root, "yokemate.db")} is missing`);
  const db = new DatabaseSync(join(root, "yokemate.db"), { readOnly: true });
  let recorded: string | undefined;
  try { recorded = (db.prepare("SELECT plan FROM work WHERE ticket = ?").get(ticket) as { plan?: string } | undefined)?.plan; }
  finally { db.close(); }
  if (!recorded) throw new Error(`${ticket}: no current recorded plan for approval`);
  const path = resolve(root, recorded);
  const knowledge = resolve(dataRoot(root), "knowledge");
  if (!contained(knowledge, path)) throw new Error(`${ticket}: plan is not contained in ${knowledge}`);
  if (!lstatSync(path).isFile()) throw new Error(`${ticket}: plan must be a regular file, not a symlink: ${path}`);
  const canonical = realpathSync(path);
  if (!contained(realpathSync(knowledge), canonical)) throw new Error(`${ticket}: plan symlink escape from knowledge: ${path}`);
  const bytes = readFileSync(canonical);
  const text = bytes.toString("utf8");
  if (!new RegExp(`^#\\s+${ticket}(?:\\s|$)`).test(text.split(/\r?\n/, 1)[0]!)) throw new Error(`${ticket}: plan heading does not match ticket: ${path}`);
  const parts = parseAffected(text);
  if (!parts.length || parts.some((part) => !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(part.repo))) throw new Error(`${ticket}: Affected repositories must name canonical org/repo`);
  const repositories = parts.map((part) => part.repo).sort();
  if (new Set(repositories).size !== repositories.length) throw new Error(`${ticket}: duplicate affected repository`);
  const scope = text.split(/(?=^##\s)/m).filter((section) => /^##\s+(Goal|Affected repositories|Cross-repository contract|Steps|Assumptions|Out of scope|Acceptance)\s*$/m.test(section)).map((section) => section.replace(/\r\n/g, "\n").trim());
  return { ticket, path: canonical, contentHash: hash(bytes), scopeHash: hash(JSON.stringify([ticket, repositories, scope])), repositories };
}

export function assertPlanBinding(expected: PlanBinding, actual: PlanBinding): void {
  for (const [key, reason] of [["ticket", "ticket"], ["path", "path"], ["repositories", "repositories"], ["scopeHash", "scope"], ["contentHash", "content hash"]] as const) {
    if (JSON.stringify(expected[key]) !== JSON.stringify(actual[key])) throw new Error(`do approval ${reason} changed for ${expected.ticket}; approve the current recorded plan again`);
  }
}
