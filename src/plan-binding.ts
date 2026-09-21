import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, type BigIntStats } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseAffected } from "./adopt.ts";
import { dataRoot } from "./data-root.ts";
import { assertMandatoryBoundary } from "./workflow-boundaries.ts";

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

function snapshotFromBytes(ticket: string, path: string, bytes: Buffer): CandidatePlanSnapshot {
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
  return { ticket, path, bytes, text, contentHash: hash(bytes), scopeHash: hash(JSON.stringify([ticket, repositories, scope])), repositories };
}

function assertTicket(ticket: string): void {
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(ticket)) throw new Error(`invalid approval ticket ${ticket}`);
}

export function readCandidatePlanSnapshot(root: string, ticket: string, candidatePath: string): CandidatePlanSnapshot {
  assertTicket(ticket);
  const path = resolve(root, candidatePath);
  const knowledge = resolve(dataRoot(root), "knowledge");
  if (!contained(knowledge, path)) throw new Error(`${ticket}: plan is not contained in ${knowledge}`);
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`${ticket}: plan must be a regular file, not a symlink: ${path}`);
  const canonicalKnowledge = realpathSync(knowledge);
  const canonical = realpathSync(path);
  if (!contained(canonicalKnowledge, canonical)) throw new Error(`${ticket}: plan symlink escape from knowledge: ${path}`);
  return snapshotFromBytes(ticket, canonical, readFileSync(canonical));
}

async function readCandidatePlanSnapshotAsync(root: string, ticket: string, candidatePath: string, signal: AbortSignal): Promise<CandidatePlanSnapshot> {
  assertTicket(ticket);
  signal.throwIfAborted();
  const path = resolve(root, candidatePath);
  const knowledge = resolve(dataRoot(root), "knowledge");
  if (!contained(knowledge, path)) throw new Error(`${ticket}: plan is not contained in ${knowledge}`);
  const status = await lstat(path);
  signal.throwIfAborted();
  if (!status.isFile()) throw new Error(`${ticket}: plan must be a regular file, not a symlink: ${path}`);
  const [canonicalKnowledge, canonical] = await Promise.all([realpath(knowledge), realpath(path)]);
  signal.throwIfAborted();
  if (!contained(canonicalKnowledge, canonical)) throw new Error(`${ticket}: plan symlink escape from knowledge: ${path}`);
  const bytes = await readFile(canonical);
  signal.throwIfAborted();
  return snapshotFromBytes(ticket, canonical, bytes);
}

export function readRecordedPlanBinding(root: string, ticket: string): PlanBinding {
  assertTicket(ticket);
  if (!existsSync(join(root, "yokemate.db"))) throw new Error(`${ticket}: no current recorded plan for approval: ${join(root, "yokemate.db")} is missing`);
  const db = new DatabaseSync(join(root, "yokemate.db"), { readOnly: true });
  let recorded: string | undefined;
  try { recorded = (db.prepare("SELECT plan FROM work WHERE ticket = ?").get(ticket) as { plan?: string } | undefined)?.plan; }
  finally { db.close(); }
  if (!recorded) throw new Error(`${ticket}: no current recorded plan for approval`);
  return toPlanBinding(readCandidatePlanSnapshot(root, ticket, recorded));
}

const yieldTurn = () => new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
export async function readWorkflowBindingSnapshot(root: string, signal: AbortSignal): Promise<PlanBinding[]> {
  signal.throwIfAborted();
  const databasePath = join(root, "yokemate.db");
  if (!existsSync(databasePath)) return [];
  const db = new DatabaseSync(databasePath, { readOnly: true });
  let iterator: Iterator<unknown> | undefined;
  const bindings: PlanBinding[] = [];
  try {
    iterator = db.prepare("SELECT ticket, plan FROM work WHERE plan IS NOT NULL ORDER BY ticket").iterate();
    for (;;) {
      signal.throwIfAborted();
      const next = iterator.next();
      if (next.done) break;
      const row = next.value as { ticket?: unknown; plan?: unknown };
      await yieldTurn();
      signal.throwIfAborted();
      try {
        if (typeof row.ticket !== "string" || typeof row.plan !== "string") continue;
        bindings.push(toPlanBinding(await readCandidatePlanSnapshotAsync(root, row.ticket, row.plan, signal)));
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
      }
    }
    return bindings;
  } finally {
    try { iterator?.return?.(); } finally { db.close(); }
  }
}

export function assertPlanBinding(expected: PlanBinding, actual: PlanBinding): void {
  for (const [key, reason] of [["ticket", "ticket"], ["path", "path"], ["repositories", "repositories"], ["scopeHash", "scope"], ["contentHash", "content hash"]] as const)
    assertMandatoryBoundary("workflow.plan-binding", JSON.stringify(expected[key]) === JSON.stringify(actual[key]), `do approval ${reason} changed for ${expected.ticket}; approve the current recorded plan again`);
}

export interface PlanWriterScope { ticket: string; project: string; knowledgeRoot: string }
export type PlanWriterArtifactReason = "scope_not_found" | "ambiguous_scope" | "invalid_scope" | "invalid_plan_path" | "outside_project" | "symlink_component" | "not_regular" | "invalid_utf8" | "wrong_heading" | "invalid_sections" | "invalid_repositories" | "binding_changed" | "artifact_not_found" | "ambiguous_artifact" | "artifact_unavailable";
export class PlanWriterArtifactError extends Error {
  readonly code: PlanWriterArtifactReason;
  readonly candidateCount?: number;
  constructor(ticket: string, code: PlanWriterArtifactReason, candidateCount?: number) {
    super(`${ticket}: ${code}${candidateCount === undefined ? "" : ` (${candidateCount} candidates)`}`);
    this.code = code;
    this.candidateCount = candidateCount;
  }
}

const canonicalOrg = /^[A-Za-z0-9_-]+$/;
const canonicalRepo = /^[A-Za-z0-9_.-]+$/;
const writerSlug = /^[^/\x00-\x1f\x7f]+$/;

export function resolvePlanWriterScope(root: string, ticket: string): PlanWriterScope {
  assertTicket(ticket);
  const trackerKey = ticket.slice(0, ticket.lastIndexOf("-"));
  const databasePath = join(root, "yokemate.db");
  if (!existsSync(databasePath)) throw new PlanWriterArtifactError(ticket, "scope_not_found");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  let rows: { org?: unknown; repo?: unknown }[];
  try { rows = db.prepare("SELECT org, repo FROM project WHERE tracker_key = ?").all(trackerKey) as { org?: unknown; repo?: unknown }[]; }
  catch { throw new PlanWriterArtifactError(ticket, "artifact_unavailable"); }
  finally { db.close(); }
  const projects = new Set<string>();
  for (const row of rows) {
    if (typeof row.org !== "string" || typeof row.repo !== "string" || !canonicalOrg.test(row.org) || !canonicalRepo.test(row.repo) || [row.org, row.repo].some((part) => part === "." || part === "..")) throw new PlanWriterArtifactError(ticket, "invalid_scope");
    projects.add(`${row.org}/${row.repo}`);
  }
  if (!projects.size) throw new PlanWriterArtifactError(ticket, "scope_not_found");
  if (projects.size !== 1) throw new PlanWriterArtifactError(ticket, "ambiguous_scope", projects.size);
  const project = [...projects][0]!;
  const knowledgeBase = resolve(dataRoot(root), "knowledge");
  const knowledgeRoot = resolve(knowledgeBase, ...project.split("/"));
  const scoped = relative(knowledgeBase, knowledgeRoot).split(sep);
  if (scoped.length !== 2 || scoped.some((part) => !part || part === "." || part === "..") || isAbsolute(relative(knowledgeBase, knowledgeRoot))) throw new PlanWriterArtifactError(ticket, "invalid_scope");
  return Object.freeze({ ticket, project, knowledgeRoot });
}

function lexicalComponents(value: string): string[] {
  return value.slice(parse(value).root.length).split(/[\\/]/).filter(Boolean);
}

function writerPath(scope: PlanWriterScope, requestedPath: string): { path: string; components: string[] } {
  if (!isAbsolute(requestedPath)) throw new PlanWriterArtifactError(scope.ticket, "invalid_plan_path");
  const raw = lexicalComponents(requestedPath);
  if (raw.includes(".") || raw.includes("..")) throw new PlanWriterArtifactError(scope.ticket, "invalid_plan_path");
  const path = resolve(requestedPath);
  const lexical = relative(scope.knowledgeRoot, path);
  if (!lexical || lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) throw new PlanWriterArtifactError(scope.ticket, "outside_project");
  const components = lexical.split(sep);
  if (components.length !== 3 || components[0] !== "ai") throw new PlanWriterArtifactError(scope.ticket, "invalid_plan_path");
  const folder = components[1]!;
  const file = components[2]!;
  const prefix = `${scope.ticket}-`;
  if (!folder.startsWith(prefix) || !file.startsWith(prefix) || !file.endsWith("-plan.md")) throw new PlanWriterArtifactError(scope.ticket, "invalid_plan_path");
  const folderSlug = folder.slice(prefix.length);
  const fileSlug = file.slice(prefix.length, -"-plan.md".length);
  if (!folderSlug || folderSlug !== fileSlug || !writerSlug.test(folderSlug)) throw new PlanWriterArtifactError(scope.ticket, "invalid_plan_path");
  return { path, components };
}

function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.mode === right.mode;
}

function checkedComponents(scope: PlanWriterScope, target: string): { path: string; stat: BigIntStats }[] {
  const parsed = parse(target);
  let current = parsed.root;
  const paths = lexicalComponents(target).map((component) => {
    current = join(current, component);
    return current;
  });
  return paths.map((path, index) => {
    let stat: BigIntStats;
    try { stat = lstatSync(path, { bigint: true }); }
    catch (error) {
      throw new PlanWriterArtifactError(scope.ticket, "artifact_unavailable");
    }
    if (stat.isSymbolicLink()) throw new PlanWriterArtifactError(scope.ticket, "symlink_component");
    if (index < paths.length - 1 && !stat.isDirectory()) throw new PlanWriterArtifactError(scope.ticket, "not_regular");
    return { path, stat };
  });
}

function validationReason(error: unknown): PlanWriterArtifactReason {
  if (error instanceof PlanWriterArtifactError) return error.code;
  const message = error instanceof Error ? error.message : "";
  if (/UTF-8/.test(message)) return "invalid_utf8";
  if (/heading/.test(message)) return "wrong_heading";
  if (/Affected repositories|duplicate affected repository/.test(message)) return "invalid_repositories";
  if (/section|PLAN-FORMAT|Cross-repository contract/.test(message)) return "invalid_sections";
  return "artifact_unavailable";
}

export interface PlanWriterReadHooks { beforeOpen?(): void; afterOpen?(): void; afterRead?(): void; beforeFinalStat?(): void; beforeCanonical?(): void; afterSnapshot?(): void }

export function readPlanWriterSnapshot(root: string, scope: PlanWriterScope, requestedPath: string, hooks: PlanWriterReadHooks = {}): CandidatePlanSnapshot {
  assertTicket(scope.ticket);
  let parsed: ReturnType<typeof writerPath>;
  try { parsed = writerPath(scope, requestedPath); }
  catch (error) { throw error instanceof PlanWriterArtifactError ? error : new PlanWriterArtifactError(scope.ticket, "invalid_plan_path"); }
  const before = checkedComponents(scope, parsed.path);
  const final = before.at(-1)!;
  if (!final.stat.isFile()) throw new PlanWriterArtifactError(scope.ticket, "not_regular");
  let descriptor: number | undefined;
  try {
    hooks.beforeOpen?.();
    descriptor = openSync(parsed.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(descriptor, { bigint: true });
    hooks.afterOpen?.();
    if (!opened.isFile()) throw new PlanWriterArtifactError(scope.ticket, "not_regular");
    if (!sameStat(final.stat, opened)) throw new PlanWriterArtifactError(scope.ticket, "binding_changed");
    const bytes = readFileSync(descriptor);
    hooks.afterRead?.();
    const afterDescriptor = fstatSync(descriptor, { bigint: true });
    hooks.beforeFinalStat?.();
    const after = checkedComponents(scope, parsed.path);
    if (!sameStat(opened, afterDescriptor) || before.length !== after.length || before.some((entry, index) => entry.path !== after[index]!.path || !sameStat(entry.stat, after[index]!.stat))) throw new PlanWriterArtifactError(scope.ticket, "binding_changed");
    hooks.beforeCanonical?.();
    try {
      const canonicalRoot = realpathSync(scope.knowledgeRoot);
      const canonical = realpathSync(parsed.path);
      if (!contained(canonicalRoot, canonical)) throw new PlanWriterArtifactError(scope.ticket, "outside_project");
      const canonicalStat = lstatSync(canonical, { bigint: true });
      const finalComponents = checkedComponents(scope, parsed.path);
      if (!sameStat(opened, canonicalStat) || before.length !== finalComponents.length || before.some((entry, index) => entry.path !== finalComponents[index]!.path || !sameStat(entry.stat, finalComponents[index]!.stat)) || !sameStat(opened, fstatSync(descriptor, { bigint: true }))) throw new PlanWriterArtifactError(scope.ticket, "binding_changed");
    } catch (error) {
      if (error instanceof PlanWriterArtifactError && error.code === "outside_project") throw error;
      throw new PlanWriterArtifactError(scope.ticket, "binding_changed");
    }
    try { return snapshotFromBytes(scope.ticket, parsed.path, bytes); }
    catch (error) { throw new PlanWriterArtifactError(scope.ticket, validationReason(error)); }
  } catch (error) {
    if (error instanceof PlanWriterArtifactError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new PlanWriterArtifactError(scope.ticket, code === "ELOOP" ? "symlink_component" : "artifact_unavailable");
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function enumeratePlanWriterArtifacts(scope: PlanWriterScope): { candidates: Array<{ path?: string; reason?: PlanWriterArtifactReason }>; signature: string } {
  const ai = join(scope.knowledgeRoot, "ai");
  let entries: import("node:fs").Dirent[];
  let aiStat: BigIntStats;
  try {
    aiStat = lstatSync(ai, { bigint: true });
    if (aiStat.isSymbolicLink()) throw new PlanWriterArtifactError(scope.ticket, "symlink_component");
    if (!aiStat.isDirectory()) throw new PlanWriterArtifactError(scope.ticket, "not_regular");
    entries = readdirSync(ai, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (error instanceof PlanWriterArtifactError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PlanWriterArtifactError(scope.ticket, "artifact_not_found", 0);
    throw new PlanWriterArtifactError(scope.ticket, "artifact_unavailable");
  }
  const candidates: Array<{ path?: string; reason?: PlanWriterArtifactReason }> = [];
  const observed: string[] = [];
  for (const entry of entries.filter((item) => item.name.startsWith(`${scope.ticket}-`))) {
    const folder = join(ai, entry.name);
    const kind = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
    observed.push(`${entry.name}\u0000${kind}`);
    if (entry.isSymbolicLink()) { candidates.push({ reason: "symlink_component" }); continue; }
    if (!entry.isDirectory()) { candidates.push({ reason: "not_regular" }); continue; }
    let children: import("node:fs").Dirent[];
    try { children = readdirSync(folder, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)); }
    catch { candidates.push({ reason: "artifact_unavailable" }); continue; }
    for (const child of children) if (child.name.startsWith(`${scope.ticket}-`) && child.name.endsWith("-plan.md")) {
      const childKind = child.isSymbolicLink() ? "symlink" : child.isDirectory() ? "directory" : child.isFile() ? "file" : "other";
      observed.push(`${entry.name}\u0000${child.name}\u0000${childKind}`);
      candidates.push({ path: join(folder, child.name) });
    }
  }
  return { candidates, signature: JSON.stringify([String(aiStat.dev), String(aiStat.ino), String(aiStat.mtimeNs), String(aiStat.ctimeNs), observed]) };
}

export function reconcilePlanWriterArtifact(root: string, scope: PlanWriterScope, hooks: PlanWriterReadHooks = {}): CandidatePlanSnapshot {
  const before = enumeratePlanWriterArtifacts(scope);
  if (!before.candidates.length) throw new PlanWriterArtifactError(scope.ticket, "artifact_not_found", 0);
  if (before.candidates.length !== 1) throw new PlanWriterArtifactError(scope.ticket, "ambiguous_artifact", before.candidates.length);
  const candidate = before.candidates[0]!;
  if (candidate.reason) throw new PlanWriterArtifactError(scope.ticket, candidate.reason, 1);
  const snapshot = readPlanWriterSnapshot(root, scope, candidate.path!, hooks);
  hooks.afterSnapshot?.();
  let after: ReturnType<typeof enumeratePlanWriterArtifacts>;
  try { after = enumeratePlanWriterArtifacts(scope); }
  catch { throw new PlanWriterArtifactError(scope.ticket, "binding_changed"); }
  if (after.candidates.length > 1) throw new PlanWriterArtifactError(scope.ticket, "ambiguous_artifact", after.candidates.length);
  if (after.candidates.length !== 1 || before.signature !== after.signature) throw new PlanWriterArtifactError(scope.ticket, "binding_changed");
  return snapshot;
}
