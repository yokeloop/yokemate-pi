import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sha256, type ChildIdentity } from "./subagent-runs.ts";

export type PublicationKind = "scout" | "plan";
export type PublicationError = "auth" | "permission" | "rate_limit" | "size" | "unavailable" | "target_unavailable" | "target_changed" | "incomplete_listing" | "remote_conflict" | "unsafe_document" | "binding_changed" | "artifact_invalid";
export interface PublicationOutcome {
  kind: PublicationKind;
  state: "complete" | "pending";
  target: string;
  revision: string;
  publicationId?: number;
  error?: PublicationError;
}
export interface ArtifactMetadata { artifact_path: string; content_hash: string; bytes: number }
export interface PublicationRow extends ArtifactMetadata {
  id: number;
  target: string;
  target_hash: string;
  canonical_url: string | null;
  ticket: string;
  kind: PublicationKind;
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
export interface PublicationAcceptanceRow extends ArtifactMetadata {
  id: number;
  publication_id: number | null;
  ticket: string;
  run_id: string;
  owner_run_id: string;
  owner_session_id: string;
  batch_id: string;
  task_hash: string;
}
export interface PlanRecordRow extends ArtifactMetadata {
  id: number;
  ticket: string;
  publication_id: number | null;
  plan_path: string;
  scope_hash: string;
  scout_publication: number | null;
  scout_acceptance: number | null;
  successful_record: 0 | 1;
  side_effects_started: 0 | 1;
}
export interface PlanRecordInput {
  ticket: string;
  planPath: string;
  contentHash: string;
  scopeHash: string;
  artifactPath: string;
  bytes: number;
  scoutAcceptance: number;
  publicationId?: number;
  scoutPublication?: number;
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
  const row = db.prepare("SELECT * FROM plan_publication WHERE target=? AND ticket=? AND kind=? AND content_hash=?").get(input.target, input.ticket, input.kind, contentHash) as unknown as PublicationRow;
  if (row.target_hash !== input.targetHash || row.artifact_path !== artifact || row.bytes !== input.bytes.length) throw new Error("artifact_invalid");
  return row;
}

function deliveryRow(db: DatabaseSync, child: ChildIdentity): PublicationAcceptanceRow | undefined {
  return db.prepare(`SELECT * FROM plan_publication_acceptance
    WHERE owner_run_id=? AND owner_session_id=? AND batch_id=? AND run_id=? AND task_hash=?`).get(
    child.ownerRunId, child.ownerSessionId, child.batchId, child.runId, child.taskHash,
  ) as unknown as PublicationAcceptanceRow | undefined;
}

function acceptDelivery(db: DatabaseSync, child: ChildIdentity, artifact: ArtifactMetadata, publicationId?: number): PublicationAcceptanceRow {
  if (child.agent !== "plan-scout" || !child.ticket) throw new Error("artifact_invalid");
  db.prepare(`INSERT INTO plan_publication_acceptance
    (publication_id,ticket,run_id,owner_run_id,owner_session_id,batch_id,task_hash,artifact_path,content_hash,bytes)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_run_id,owner_session_id,batch_id,run_id,task_hash) DO NOTHING`).run(
    publicationId ?? null, child.ticket, child.runId, child.ownerRunId, child.ownerSessionId, child.batchId, child.taskHash,
    artifact.artifact_path, artifact.content_hash, artifact.bytes,
  );
  let row = deliveryRow(db, child);
  if (!row || row.ticket !== child.ticket || row.run_id !== child.runId || row.artifact_path !== artifact.artifact_path || row.content_hash !== artifact.content_hash || row.bytes !== artifact.bytes) throw new Error("artifact_invalid");
  if (publicationId !== undefined) {
    if (row.publication_id !== null && row.publication_id !== publicationId) throw new Error("artifact_invalid");
    db.prepare("UPDATE plan_publication_acceptance SET publication_id=? WHERE id=? AND publication_id IS NULL").run(publicationId, row.id);
    row = publicationAcceptanceById(db, row.id)!;
  }
  return row;
}

export function acceptScoutArtifact(db: DatabaseSync, root: string, child: ChildIdentity, bytes: Buffer): PublicationAcceptanceRow {
  if (!child.ticket) throw new Error("artifact_invalid");
  const contentHash = sha256(bytes);
  const artifactPath = writePublicationArtifact(root, child.ticket, "scout", contentHash, bytes);
  return acceptDelivery(db, child, { artifact_path: artifactPath, content_hash: contentHash, bytes: bytes.length });
}

export function acceptPublicationDelivery(db: DatabaseSync, publicationId: number, child: ChildIdentity): PublicationAcceptanceRow {
  const publication = publicationById(db, publicationId);
  if (!publication || publication.kind !== "scout" || publication.ticket !== child.ticket) throw new Error("artifact_invalid");
  return acceptDelivery(db, child, publication, publicationId);
}

export function publicationAcceptanceById(db: DatabaseSync, id: number): PublicationAcceptanceRow | undefined {
  return db.prepare("SELECT * FROM plan_publication_acceptance WHERE id=?").get(id) as unknown as PublicationAcceptanceRow | undefined;
}

export function recordPublicationBlock(db: DatabaseSync, ticket: string, runId: string, reason: string): void {
  db.prepare("INSERT OR IGNORE INTO plan_publication_block (ticket,run_id,reason) VALUES (?,?,?)").run(ticket, runId, reason);
}

export function revokePendingPlanRecords(db: DatabaseSync, ticket: string): void {
  db.prepare("UPDATE plan_record SET scout_acceptance=NULL,updated_at=datetime('now') WHERE ticket=? AND successful_record=0 AND scout_acceptance IS NOT NULL").run(ticket);
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

export function readPublicationArtifact(root: string, row: ArtifactMetadata): Buffer {
  const basePath = join(root, ".pi", "plan-publications");
  if (!existsSync(basePath)) throw new Error("artifact_invalid");
  const base = realpathSync(basePath);
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

export function reserveCanonicalUrl(db: DatabaseSync, rowId: number, canonicalUrl: string): boolean {
  db.prepare("UPDATE plan_publication SET canonical_url=?,updated_at=datetime('now') WHERE id=? AND canonical_url IS NULL").run(canonicalUrl, rowId);
  return publicationById(db, rowId)?.canonical_url === canonicalUrl;
}

export function markPublicationResult(db: DatabaseSync, rowId: number, result: { complete: boolean; error?: PublicationError; canonicalUrl?: string }): void {
  db.prepare("UPDATE plan_publication SET complete=?,error_code=?,canonical_url=COALESCE(canonical_url,?),updated_at=datetime('now') WHERE id=?")
    .run(result.complete ? 1 : 0, result.error ?? null, result.canonicalUrl ?? null, rowId);
  const row = publicationById(db, rowId);
  if (row && result.complete) db.prepare("UPDATE work SET next=NULL WHERE ticket=? AND next LIKE 'plan publication pending:%'").run(row.ticket);
}

export function acceptPlanRecord(db: DatabaseSync, input: PlanRecordInput): PlanRecordRow {
  const acceptance = publicationAcceptanceById(db, input.scoutAcceptance);
  if (!acceptance || acceptance.ticket !== input.ticket) throw new Error("artifact_invalid");
  const planPublication = input.publicationId === undefined ? undefined : publicationById(db, input.publicationId);
  if (input.publicationId !== undefined && (!planPublication || planPublication.ticket !== input.ticket || planPublication.kind !== "plan" || planPublication.content_hash !== input.contentHash)) throw new Error("artifact_invalid");
  const scoutPublication = input.scoutPublication === undefined ? undefined : publicationById(db, input.scoutPublication);
  if (input.scoutPublication !== undefined && (!scoutPublication || scoutPublication.ticket !== input.ticket || scoutPublication.kind !== "scout" || scoutPublication.content_hash !== acceptance.content_hash || acceptance.publication_id !== input.scoutPublication)) throw new Error("artifact_invalid");
  db.prepare(`INSERT INTO plan_record
    (ticket,publication_id,plan_path,content_hash,scope_hash,artifact_path,bytes,scout_publication,scout_acceptance)
    VALUES (?,NULL,?,?,?,?,?,NULL,?) ON CONFLICT(ticket,plan_path,content_hash,scope_hash,scout_acceptance) WHERE scout_acceptance IS NOT NULL DO NOTHING`).run(
    input.ticket, input.planPath, input.contentHash, input.scopeHash, input.artifactPath, input.bytes, input.scoutAcceptance,
  );
  let row = db.prepare(`SELECT * FROM plan_record
    WHERE ticket=? AND plan_path=? AND content_hash=? AND scope_hash=? AND scout_acceptance=?`).get(
    input.ticket, input.planPath, input.contentHash, input.scopeHash, input.scoutAcceptance,
  ) as unknown as PlanRecordRow | undefined;
  if (!row || row.artifact_path !== input.artifactPath || row.bytes !== input.bytes) throw new Error("artifact_invalid");
  if (input.publicationId !== undefined) {
    if (row.publication_id !== null && row.publication_id !== input.publicationId) throw new Error("artifact_invalid");
    const desiredScout = input.scoutPublication ?? row.scout_publication;
    const collision = desiredScout === null ? undefined : db.prepare(`SELECT id FROM plan_record
      WHERE ticket=? AND publication_id=? AND plan_path=? AND content_hash=? AND scope_hash=? AND scout_publication=? AND id<>? LIMIT 1`).get(
      row.ticket, input.publicationId, row.plan_path, row.content_hash, row.scope_hash, desiredScout, row.id,
    );
    db.prepare("UPDATE plan_record SET publication_id=?,scout_publication=CASE WHEN ? THEN NULL ELSE scout_publication END WHERE id=? AND publication_id IS NULL").run(input.publicationId, collision ? 1 : 0, row.id);
    row = planRecordById(db, row.id)!;
  }
  if (input.scoutPublication !== undefined) {
    if (row.scout_publication !== null && row.scout_publication !== input.scoutPublication) throw new Error("artifact_invalid");
    const collision = row.publication_id === null ? undefined : db.prepare(`SELECT id FROM plan_record
      WHERE ticket=? AND publication_id=? AND plan_path=? AND content_hash=? AND scope_hash=? AND scout_publication=? AND id<>? LIMIT 1`).get(
      row.ticket, row.publication_id, row.plan_path, row.content_hash, row.scope_hash, input.scoutPublication, row.id,
    );
    if (!collision) db.prepare("UPDATE plan_record SET scout_publication=? WHERE id=? AND scout_publication IS NULL").run(input.scoutPublication, row.id);
  }
  row = planRecordById(db, row.id)!;
  if (row.successful_record && row.publication_id !== null) {
    db.prepare("UPDATE plan_publication SET plan_path=?,scope_hash=?,updated_at=datetime('now') WHERE id=? AND kind='plan' AND plan_path IS NULL AND scope_hash IS NULL").run(row.plan_path, row.scope_hash, row.publication_id);
  }
  return row;
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
  const row = planRecordById(db, recordId);
  if (row) db.prepare("UPDATE work SET next=NULL WHERE ticket=? AND next LIKE 'plan publication pending:%'").run(row.ticket);
}

export function markSideEffectsStarted(db: DatabaseSync, recordId: number): boolean {
  const changed = db.prepare("UPDATE plan_record SET side_effects_started=1,updated_at=datetime('now') WHERE id=? AND successful_record=1 AND side_effects_started=0").run(recordId).changes;
  return changed === 1;
}
