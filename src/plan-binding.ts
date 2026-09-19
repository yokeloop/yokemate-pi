import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseAffected } from "./adopt.ts";
import { dataRoot } from "./data-root.ts";

export interface PlanBinding { ticket: string; path: string; contentHash: string; scopeHash: string; repositories: string[] }
export interface CandidatePlanSnapshot extends PlanBinding { bytes: Buffer; text: string }
export function toPlanBinding(value: PlanBinding): PlanBinding {
  return { ticket: value.ticket, path: value.path, contentHash: value.contentHash, scopeHash: value.scopeHash, repositories: [...value.repositories] };
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const contained = (root: string, path: string) => { const r = relative(root, path); return r !== "" && r !== ".." && !r.startsWith("../") && !isAbsolute(r); };
const headings = ["Goal", "Affected repositories", "Steps", "Assumptions", "Out of scope", "Acceptance"];

function validateSections(ticket: string, path: string, text: string, repositoryCount: number): void {
  const found = [...text.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1]!);
  const required = repositoryCount > 1
    ? ["Goal", "Affected repositories", "Cross-repository contract", "Steps", "Assumptions", "Out of scope", "Acceptance"]
    : headings;
  if (repositoryCount === 1 && found.includes("Cross-repository contract")) throw new Error(`${ticket}: single-repository plan must omit Cross-repository contract: ${path}`);
  if (required.some((section, index) => found[index] !== section) || found.length !== required.length) throw new Error(`${ticket}: plan sections must be present once and in PLAN-FORMAT order: ${path}`);
  for (const section of required) {
    const start = text.indexOf(`## ${section}`) + section.length + 3;
    const end = text.indexOf("\n## ", start);
    if (!text.slice(start, end < 0 ? undefined : end).trim()) throw new Error(`${ticket}: plan section ${section} is empty: ${path}`);
  }
}

export function readCandidatePlanSnapshot(root: string, ticket: string, candidatePath: string): CandidatePlanSnapshot {
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(ticket)) throw new Error(`invalid approval ticket ${ticket}`);
  const path = resolve(root, candidatePath);
  const knowledge = resolve(dataRoot(root), "knowledge");
  if (!contained(knowledge, path)) throw new Error(`${ticket}: plan is not contained in ${knowledge}`);
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`${ticket}: plan must be a regular file, not a symlink: ${path}`);
  const canonicalKnowledge = realpathSync(knowledge);
  const canonical = realpathSync(path);
  if (!contained(canonicalKnowledge, canonical)) throw new Error(`${ticket}: plan symlink escape from knowledge: ${path}`);
  const bytes = readFileSync(canonical);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`${ticket}: plan is not valid UTF-8: ${path}`); }
  if (!new RegExp(`^#\\s+${ticket}(?:\\s|$)`).test(text.split(/\r?\n/, 1)[0]!)) throw new Error(`${ticket}: plan heading does not match ticket: ${path}`);
  const parts = parseAffected(text);
  if (!parts.length || parts.some((part) => !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(part.repo))) throw new Error(`${ticket}: Affected repositories must name canonical org/repo`);
  const repositories = parts.map((part) => part.repo).sort();
  if (new Set(repositories).size !== repositories.length) throw new Error(`${ticket}: duplicate affected repository`);
  validateSections(ticket, path, text, repositories.length);
  const sectionNames = new Set([...headings, "Cross-repository contract"]);
  const scope = text.split(/(?=^##\s)/m).filter((section) => {
    const title = /^##\s+(.+?)\s*$/m.exec(section)?.[1];
    return title !== undefined && sectionNames.has(title);
  }).map((section) => section.replace(/\r\n?/g, "\n").trim());
  return { ticket, path: canonical, bytes, text, contentHash: hash(bytes), scopeHash: hash(JSON.stringify([ticket, repositories, scope])), repositories };
}

export function readRecordedPlanBinding(root: string, ticket: string): PlanBinding {
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(ticket)) throw new Error(`invalid approval ticket ${ticket}`);
  if (!existsSync(join(root, "yokemate.db"))) throw new Error(`${ticket}: no current recorded plan for approval: ${join(root, "yokemate.db")} is missing`);
  const db = new DatabaseSync(join(root, "yokemate.db"), { readOnly: true });
  let recorded: string | undefined;
  try { recorded = (db.prepare("SELECT plan FROM work WHERE ticket = ?").get(ticket) as { plan?: string } | undefined)?.plan; }
  finally { db.close(); }
  if (!recorded) throw new Error(`${ticket}: no current recorded plan for approval`);
  return toPlanBinding(readCandidatePlanSnapshot(root, ticket, recorded));
}

export function assertPlanBinding(expected: PlanBinding, actual: PlanBinding): void {
  for (const [key, reason] of [["ticket", "ticket"], ["path", "path"], ["repositories", "repositories"], ["scopeHash", "scope"], ["contentHash", "content hash"]] as const) {
    if (JSON.stringify(expected[key]) !== JSON.stringify(actual[key])) throw new Error(`do approval ${reason} changed for ${expected.ticket}; approve the current recorded plan again`);
  }
}
