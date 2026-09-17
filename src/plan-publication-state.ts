import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sha256, type ChildIdentity } from "./subagent-runs.ts";

export type PublicationKind = "scout" | "plan";
export type PublicationError = "auth" | "permission" | "rate_limit" | "size" | "unavailable" | "incomplete_listing" | "remote_conflict" | "unsafe_document" | "binding_changed" | "artifact_invalid";
export interface PublicationRow {
  id: number;
  target: string;
  target_hash: string;
  canonical_url: string | null;
  ticket: string;
  kind: PublicationKind;
  content_hash: string;
  artifact_path: string;
  bytes: number;
  run_id: string;
  owner_run_id: string | null;
  owner_session_id: string | null;
  batch_id: string | null;
  task_hash: string | null;
  plan_path: string | null;
  scope_hash: string | null;
  scout_publication: number | null;
  successful_record: 0 | 1;
  complete: 0 | 1;
  error_code: PublicationError | null;
  side_effects_started: 0 | 1;
}
export interface PublicationIdentityInput {
  target: string;
  targetHash: string;
  ticket: string;
  kind: PublicationKind;
  bytes: Buffer;
  runId: string;
  child?: ChildIdentity;
  planPath?: string;
  scopeHash?: string;
}

export interface PlanRecordRow {
  id: number;
  ticket: string;
  publication_id: number;
  plan_path: string;
  content_hash: string;
  scope_hash: string;
  scout_publication: number;
  successful_record: 0 | 1;
  side_effects_started: 0 | 1;
}

export interface PlanRecordInput {
  ticket: string;
  publicationId: number;
  planPath: string;
  contentHash: string;
  scopeHash: string;
  scoutPublication: number;
}

const contained = (root: string, candidate: string): boolean => {
  const value = relative(root, candidate);
  return value !== "" && value !== ".." && !value.startsWith("../") && !isAbsolute(value);
};

function artifactDirectory(root: string, ticket: string): string {
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(ticket)) throw new Error("artifact_invalid");
  const base = join(root, ".pi", "plan-publications");
  const directory = join(base, ticket);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const item of [base, directory]) {
    const stat = lstatSync(item);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("artifact_invalid");
    chmodSync(item, 0o700);
  }
  return directory;
}

export function writePublicationArtifact(root: string, ticket: string, kind: PublicationKind, contentHash: string, bytes: Buffer): string {
  if (!/^[a-f0-9]{64}$/.test(contentHash) || sha256(bytes) !== contentHash) throw new Error("artifact_invalid");
  const directory = artifactDirectory(root, ticket);
  const target = join(directory, `${kind}-${contentHash}.md`);
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || sha256(readFileSync(target)) !== contentHash) throw new Error("artifact_invalid");
    chmodSync(target, 0o600);
    return target;
  }
  const temporary = join(directory, `.${kind}-${contentHash}-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch {}
  }
  return target;
}

export function acceptPublication(db: DatabaseSync, root: string, input: PublicationIdentityInput): PublicationRow {
  const contentHash = sha256(input.bytes);
  const artifact = writePublicationArtifact(root, input.ticket, input.kind, contentHash, input.bytes);
  db.prepare(`INSERT INTO plan_publication
    (target,target_hash,ticket,kind,content_hash,artifact_path,bytes,run_id,owner_run_id,owner_session_id,batch_id,task_hash,plan_path,scope_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(target,ticket,kind,content_hash) DO NOTHING`).run(
    input.target, input.targetHash, input.ticket, input.kind, contentHash, artifact, input.bytes.length, input.runId,
    input.child?.ownerRunId ?? null, input.child?.ownerSessionId ?? null, input.child?.batchId ?? null, input.child?.taskHash ?? null,
    input.planPath ?? null, input.scopeHash ?? null,
  );
  return db.prepare("SELECT * FROM plan_publication WHERE target=? AND ticket=? AND kind=? AND content_hash=?").get(input.target, input.ticket, input.kind, contentHash) as unknown as PublicationRow;
}

export function recordPublicationBlock(db: DatabaseSync, ticket: string, runId: string, reason: string): void {
  db.prepare("INSERT OR IGNORE INTO plan_publication_block (ticket,run_id,reason) VALUES (?,?,?)").run(ticket, runId, reason);
}

export function publicationById(db: DatabaseSync, id: number): PublicationRow | undefined {
  return db.prepare("SELECT * FROM plan_publication WHERE id=?").get(id) as unknown as PublicationRow | undefined;
}

export function publicationFor(db: DatabaseSync, target: string, ticket: string, kind: PublicationKind, contentHash: string): PublicationRow | undefined {
  return db.prepare("SELECT * FROM plan_publication WHERE target=? AND ticket=? AND kind=? AND content_hash=?").get(target, ticket, kind, contentHash) as unknown as PublicationRow | undefined;
}

export function latestScout(db: DatabaseSync, target: string, ticket: string): PublicationRow | undefined {
  return db.prepare("SELECT * FROM plan_publication WHERE target=? AND ticket=? AND kind='scout' ORDER BY id DESC LIMIT 1").get(target, ticket) as unknown as PublicationRow | undefined;
}

export function readPublicationArtifact(root: string, row: PublicationRow): Buffer {
  const base = realpathSync(join(root, ".pi", "plan-publications"));
  const candidate = resolve(row.artifact_path);
  if (!contained(base, candidate) || !existsSync(candidate)) throw new Error("artifact_invalid");
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("artifact_invalid");
  const canonical = realpathSync(candidate);
  if (!contained(base, canonical)) throw new Error("artifact_invalid");
  const bytes = readFileSync(canonical);
  if (bytes.length !== row.bytes || sha256(bytes) !== row.content_hash) throw new Error("artifact_invalid");
  return bytes;
}

export function markPublicationResult(db: DatabaseSync, rowId: number, result: { complete: boolean; error?: PublicationError; canonicalUrl?: string }): void {
  db.prepare("UPDATE plan_publication SET complete=?,error_code=?,canonical_url=COALESCE(?,canonical_url),updated_at=datetime('now') WHERE id=?")
    .run(result.complete ? 1 : 0, result.error ?? null, result.canonicalUrl ?? null, rowId);
  const row = publicationById(db, rowId);
  if (!row) return;
  const prefix = `plan publication pending: ${row.target} ${row.kind}`;
  if (result.complete) db.prepare("UPDATE work SET next=NULL WHERE ticket=? AND next LIKE ?").run(row.ticket, `${prefix}%`);
  else db.prepare("UPDATE work SET next=? WHERE ticket=?").run(`${prefix} ${result.error ?? "unavailable"}`, row.ticket);
}

export function acceptPlanRecord(db: DatabaseSync, input: PlanRecordInput): PlanRecordRow {
  db.prepare(`INSERT INTO plan_record
    (ticket,publication_id,plan_path,content_hash,scope_hash,scout_publication)
    VALUES (?,?,?,?,?,?) ON CONFLICT(ticket,publication_id,plan_path,content_hash,scope_hash,scout_publication) DO NOTHING`).run(
    input.ticket, input.publicationId, input.planPath, input.contentHash, input.scopeHash, input.scoutPublication,
  );
  return db.prepare(`SELECT * FROM plan_record
    WHERE ticket=? AND publication_id=? AND plan_path=? AND content_hash=? AND scope_hash=? AND scout_publication=?`).get(
    input.ticket, input.publicationId, input.planPath, input.contentHash, input.scopeHash, input.scoutPublication,
  ) as unknown as PlanRecordRow;
}

export function planRecordById(db: DatabaseSync, id: number): PlanRecordRow | undefined {
  return db.prepare("SELECT * FROM plan_record WHERE id=?").get(id) as unknown as PlanRecordRow | undefined;
}

export function currentPlanRecord(db: DatabaseSync, ticket: string): PlanRecordRow | undefined {
  return db.prepare("SELECT * FROM plan_record WHERE ticket=? AND successful_record=1 ORDER BY id DESC LIMIT 1").get(ticket) as unknown as PlanRecordRow | undefined;
}

export function markSuccessfulRecord(db: DatabaseSync, recordId: number): void {
  db.prepare("UPDATE plan_record SET successful_record=1,updated_at=datetime('now') WHERE id=?").run(recordId);
  db.prepare(`UPDATE plan_publication SET
    plan_path=(SELECT plan_path FROM plan_record WHERE id=?),
    scope_hash=(SELECT scope_hash FROM plan_record WHERE id=?),
    updated_at=datetime('now')
    WHERE id=(SELECT publication_id FROM plan_record WHERE id=?) AND kind='plan' AND plan_path IS NULL AND scope_hash IS NULL`).run(recordId, recordId, recordId);
}

export function markSideEffectsStarted(db: DatabaseSync, recordId: number): boolean {
  const changed = db.prepare("UPDATE plan_record SET side_effects_started=1,updated_at=datetime('now') WHERE id=? AND successful_record=1 AND side_effects_started=0").run(recordId).changes;
  return changed === 1;
}
