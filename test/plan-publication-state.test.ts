import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.ts";
import { assertPlanBinding, readCandidatePlanSnapshot, readRecordedPlanBinding } from "../src/plan-binding.ts";
import { acceptPlanRecord, acceptPublication, acceptPublicationDelivery, acceptScoutArtifact, markPublicationResult, markSuccessfulRecord, planRecordById, publicationAcceptanceById, publicationFor, readPublicationArtifact, reserveCanonicalUrl, writePublicationArtifact } from "../src/plan-publication-state.ts";
import { sha256 } from "../src/subagent-runs.ts";

const plan = (ticket = "YM-1", repo = "org/repo") => `# ${ticket} — fixture

## Goal
Publish a plan.

## Affected repositories
- \`${repo}\` — app

## Steps
1. Publish it.

## Assumptions
- Existing tracker.

## Out of scope
- Other work.

## Acceptance
The source issue contains the plan.
`;

test("candidate and recorded readers share strict byte, path and section validation", () => {
  const root = mkdtempSync(join(tmpdir(), "plan-state-"));
  try {
    const folder = join(root, "home/knowledge/org/repo/ai/YM-1-work");
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "plan.md");
    writeFileSync(file, plan());
    const candidate = readCandidatePlanSnapshot(root, "YM-1", file);
    const db = openDb(join(root, "yokemate.db"));
    db.prepare("INSERT INTO work(ticket,url,stage,plan) VALUES('YM-1','u','planned',?)").run(file);
    assertPlanBinding(candidate, readRecordedPlanBinding(root, "YM-1"));
    writeFileSync(file, Buffer.from([0xff]));
    assert.throws(() => readCandidatePlanSnapshot(root, "YM-1", file), /UTF-8/);
    writeFileSync(file, plan().replace("## Steps", "## Acceptance").replace("## Acceptance\nThe", "## Steps\nThe"));
    assert.throws(() => readCandidatePlanSnapshot(root, "YM-1", file), /PLAN-FORMAT order/);
    writeFileSync(file, plan("YM-2"));
    assert.throws(() => readCandidatePlanSnapshot(root, "YM-1", file), /heading/);
    const outside = join(root, "outside.md");
    writeFileSync(outside, plan());
    rmSync(file);
    symlinkSync(outside, file);
    assert.throws(() => readCandidatePlanSnapshot(root, "YM-1", file), /regular|symlink/);
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("canonical reservation prevents concurrent and crash-resume publication to another URL", async () => {
  const root = mkdtempSync(join(tmpdir(), "publication-canonical-"));
  try {
    mkdirSync(join(root, ".pi"), { recursive: true });
    const dbPath = join(root, "yokemate.db");
    const db = openDb(dbPath);
    const target = "youtrack-yokeloop:YM-1";
    const row = acceptPublication(db, root, { target, targetHash: sha256(target), ticket: "YM-1", kind: "scout", bytes: Buffer.from("# scout\n"), runId: "run" });
    db.close();
    const posts: string[] = [];
    const attempt = async (url: string) => {
      const connection = openDb(dbPath);
      try { if (reserveCanonicalUrl(connection, row.id, url)) posts.push(url); }
      finally { connection.close(); }
    };
    await Promise.all([attempt("https://tracker.example/issue/YM-1"), attempt("https://other.example/issue/YM-1")]);
    await attempt("https://other.example/issue/YM-1");
    assert.deepEqual(posts, ["https://tracker.example/issue/YM-1"]);
    const reopened = openDb(dbPath);
    assert.equal(publicationFor(reopened, target, "YM-1", "scout", row.content_hash)?.canonical_url, "https://tracker.example/issue/YM-1");
    reopened.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("local acceptance and record do not require a publication target", () => {
  const root = mkdtempSync(join(tmpdir(), "publication-local-"));
  try {
    const planFolder = join(root, "home/knowledge/org/repo/ai/YM-1-work");
    mkdirSync(planFolder, { recursive: true });
    const planPath = join(planFolder, "plan.md");
    writeFileSync(planPath, plan());
    const binding = readCandidatePlanSnapshot(root, "YM-1", planPath);
    let db = openDb(join(root, "yokemate.db"));
    const identity = { ownerRunId: "owner", ownerSessionId: "session", batchId: "batch", runId: "run", agent: "plan-scout", taskHash: "a".repeat(64), cwd: root, ticket: "YM-1" } as const;
    const scoutBytes = Buffer.from("# Scout\n\nEVIDENCE-TAIL\n");
    const scout = acceptScoutArtifact(db, root, identity, scoutBytes);
    const sameBytesOtherDelivery = acceptScoutArtifact(db, root, { ...identity, runId: "run-two", taskHash: "b".repeat(64) }, scoutBytes);
    assert.notEqual(scout.id, sameBytesOtherDelivery.id);
    assert.equal(scout.publication_id, null);
    assert.deepEqual(readPublicationArtifact(root, scout), scoutBytes);
    assert.throws(() => acceptScoutArtifact(db, root, identity, Buffer.from("# changed\n")), /artifact_invalid/);
    const artifactPath = writePublicationArtifact(root, "YM-1", "plan", binding.contentHash, binding.bytes);
    const record = acceptPlanRecord(db, { ticket: "YM-1", planPath: binding.path, contentHash: binding.contentHash, scopeHash: binding.scopeHash, artifactPath, bytes: binding.bytes.length, scoutAcceptance: scout.id });
    assert.equal(record.publication_id, null);
    assert.equal(record.scout_publication, null);
    db.prepare("INSERT INTO work(ticket,url,stage,plan,next) VALUES('YM-1','u','new',NULL,'owned by another feature')").run();
    markPublicationResult(db, 999, { complete: false, error: "unavailable" });
    assert.deepEqual({ ...db.prepare("SELECT stage,plan,next FROM work WHERE ticket='YM-1'").get() }, { stage: "new", plan: null, next: "owned by another feature" });
    db.close();
    db = openDb(join(root, "yokemate.db"));
    assert.equal(publicationAcceptanceById(db, scout.id)?.content_hash, sha256(scoutBytes));
    assert.equal(planRecordById(db, record.id)?.scout_acceptance, scout.id);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    rmSync(scout.artifact_path);
    assert.throws(() => readPublicationArtifact(root, scout), /artifact_invalid/);
    const outside = join(root, "outside.md");
    writeFileSync(outside, scoutBytes);
    symlinkSync(outside, scout.artifact_path);
    assert.throws(() => readPublicationArtifact(root, scout), /artifact_invalid/);
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("delivery identity cannot be rebound", () => {
  const root = mkdtempSync(join(tmpdir(), "publication-rebind-"));
  try {
    const db = openDb(join(root, "yokemate.db"));
    const identity = { ownerRunId: "owner", ownerSessionId: "session", batchId: "batch", runId: "run", agent: "plan-scout", taskHash: "a".repeat(64), cwd: root, ticket: "YM-1" } as const;
    const bytes = Buffer.from("# Scout\n");
    const acceptance = acceptScoutArtifact(db, root, identity, bytes);
    const first = acceptPublication(db, root, { target: "youtrack-one:YM-1", targetHash: sha256("youtrack-one:YM-1"), ticket: "YM-1", kind: "scout", bytes, runId: identity.runId, child: identity });
    assert.equal(acceptPublicationDelivery(db, first.id, identity).id, acceptance.id);
    const second = acceptPublication(db, root, { target: "youtrack-two:YM-1", targetHash: sha256("youtrack-two:YM-1"), ticket: "YM-1", kind: "scout", bytes, runId: identity.runId, child: identity });
    assert.throws(() => acceptPublicationDelivery(db, second.id, identity), /artifact_invalid/);
    assert.equal(publicationAcceptanceById(db, acceptance.id)?.publication_id, first.id);
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("old publication ledger migrates without identity loss", () => {
  const root = mkdtempSync(join(tmpdir(), "publication-migration-"));
  try {
    const scoutBytes = Buffer.from("# old scout\n");
    const planBytes = Buffer.from(plan());
    const scoutPath = writePublicationArtifact(root, "YM-1", "scout", sha256(scoutBytes), scoutBytes);
    const planPath = writePublicationArtifact(root, "YM-1", "plan", sha256(planBytes), planBytes);
    const raw = new DatabaseSync(join(root, "yokemate.db"));
    raw.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE plan_publication (
        id INTEGER PRIMARY KEY, target TEXT NOT NULL, target_hash TEXT NOT NULL, canonical_url TEXT, ticket TEXT NOT NULL,
        kind TEXT NOT NULL, content_hash TEXT NOT NULL, artifact_path TEXT NOT NULL, bytes INTEGER NOT NULL, run_id TEXT NOT NULL,
        owner_run_id TEXT, owner_session_id TEXT, batch_id TEXT, task_hash TEXT, plan_path TEXT, scope_hash TEXT,
        scout_publication INTEGER REFERENCES plan_publication(id), successful_record INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0,
        error_code TEXT, side_effects_started INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(target,ticket,kind,content_hash));
      CREATE TABLE plan_publication_acceptance (
        id INTEGER PRIMARY KEY, publication_id INTEGER NOT NULL REFERENCES plan_publication(id), ticket TEXT NOT NULL, run_id TEXT NOT NULL,
        owner_run_id TEXT NOT NULL, owner_session_id TEXT NOT NULL, batch_id TEXT NOT NULL, task_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(owner_run_id,owner_session_id,batch_id,run_id,task_hash));
      CREATE TABLE plan_record (
        id INTEGER PRIMARY KEY, ticket TEXT NOT NULL, publication_id INTEGER NOT NULL REFERENCES plan_publication(id), plan_path TEXT NOT NULL,
        content_hash TEXT NOT NULL, scope_hash TEXT NOT NULL, scout_publication INTEGER NOT NULL REFERENCES plan_publication(id),
        successful_record INTEGER NOT NULL DEFAULT 0, side_effects_started INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(ticket,publication_id,plan_path,content_hash,scope_hash,scout_publication));
    `);
    const insertPublication = raw.prepare(`INSERT INTO plan_publication
      (id,target,target_hash,canonical_url,ticket,kind,content_hash,artifact_path,bytes,run_id,complete,error_code,successful_record,side_effects_started)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    insertPublication.run(10, "youtrack-yokeloop:YM-1", "target-hash", "https://tracker.example/YM-1", "YM-1", "scout", sha256(scoutBytes), scoutPath, scoutBytes.length, "scout-run", 1, null, 0, 0);
    insertPublication.run(11, "youtrack-yokeloop:YM-1", "target-hash", "https://tracker.example/YM-1", "YM-1", "plan", sha256(planBytes), planPath, planBytes.length, "plan-run", 0, "unavailable", 0, 0);
    raw.prepare("INSERT INTO plan_publication_acceptance(id,publication_id,ticket,run_id,owner_run_id,owner_session_id,batch_id,task_hash) VALUES(20,10,'YM-1','scout-run','owner','session','batch',?)").run("a".repeat(64));
    raw.prepare("INSERT INTO plan_record(id,ticket,publication_id,plan_path,content_hash,scope_hash,scout_publication,successful_record,side_effects_started) VALUES(30,'YM-1',11,'/old-plan',?,'scope',10,1,1)").run(sha256(planBytes));
    raw.close();
    let db = openDb(join(root, "yokemate.db"));
    const migratedAcceptance = publicationAcceptanceById(db, 20)!;
    assert.equal(migratedAcceptance.id, 20);
    assert.equal(migratedAcceptance.publication_id, 10);
    assert.equal(migratedAcceptance.owner_run_id, "owner");
    assert.equal(migratedAcceptance.owner_session_id, "session");
    assert.equal(migratedAcceptance.batch_id, "batch");
    assert.equal(migratedAcceptance.run_id, "scout-run");
    assert.equal(migratedAcceptance.task_hash, "a".repeat(64));
    assert.equal(migratedAcceptance.artifact_path, scoutPath);
    assert.equal(migratedAcceptance.content_hash, sha256(scoutBytes));
    assert.equal(migratedAcceptance.bytes, scoutBytes.length);
    const migrated = planRecordById(db, 30)!;
    assert.equal(migrated.artifact_path, planPath);
    assert.equal(migrated.bytes, planBytes.length);
    assert.equal(migrated.scout_acceptance, null);
    assert.equal(migrated.successful_record, 1);
    assert.equal(migrated.side_effects_started, 1);
    assert.equal(publicationFor(db, "youtrack-yokeloop:YM-1", "YM-1", "scout", sha256(scoutBytes))?.canonical_url, "https://tracker.example/YM-1");
    assert.equal(publicationFor(db, "youtrack-yokeloop:YM-1", "YM-1", "plan", sha256(planBytes))?.error_code, "unavailable");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.close();
    db = openDb(join(root, "yokemate.db"));
    assert.equal(planRecordById(db, 30)?.scout_acceptance, null);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("publication ledger keeps immutable identities, revisions and restart-verifiable private artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "publication-ledger-"));
  try {
    mkdirSync(join(root, ".pi"), { recursive: true });
    const db = openDb(join(root, "yokemate.db"));
    const target = "youtrack-yokeloop:YM-1";
    const targetHash = sha256(target);
    const firstBytes = Buffer.from("# scout one\n");
    const first = acceptPublication(db, root, { target, targetHash, ticket: "YM-1", kind: "scout", bytes: firstBytes, runId: "run-one" });
    const duplicate = acceptPublication(db, root, { target, targetHash, ticket: "YM-1", kind: "scout", bytes: firstBytes, runId: "run-two" });
    const firstDelivery = acceptPublicationDelivery(db, first.id, { ownerRunId: "owner-one", ownerSessionId: "session-one", batchId: "batch-one", runId: "run-one", agent: "plan-scout", taskHash: "a".repeat(64), cwd: root, ticket: "YM-1" });
    const restartDelivery = acceptPublicationDelivery(db, duplicate.id, { ownerRunId: "owner-two", ownerSessionId: "session-two", batchId: "batch-two", runId: "run-two", agent: "plan-scout", taskHash: "b".repeat(64), cwd: root, ticket: "YM-1" });
    const second = acceptPublication(db, root, { target, targetHash, ticket: "YM-1", kind: "scout", bytes: Buffer.from("# scout two\n"), runId: "run-three" });
    const secondDelivery = acceptPublicationDelivery(db, second.id, { ownerRunId: "owner-three", ownerSessionId: "session-three", batchId: "batch-three", runId: "run-three", agent: "plan-scout", taskHash: "c".repeat(64), cwd: root, ticket: "YM-1" });
    assert.equal(first.id, duplicate.id);
    assert.notEqual(firstDelivery.id, restartDelivery.id);
    assert.equal(publicationAcceptanceById(db, restartDelivery.id)?.publication_id, first.id);
    assert.equal(reserveCanonicalUrl(db, first.id, "https://tracker.example/issue/YM-1"), true);
    assert.equal(reserveCanonicalUrl(db, first.id, "https://other.example/issue/YM-1"), false);
    markPublicationResult(db, first.id, { complete: false, error: "unavailable", canonicalUrl: "https://tracker.example/issue/YM-1" });
    markPublicationResult(db, first.id, { complete: false, error: "remote_conflict", canonicalUrl: "https://other.example/issue/YM-1" });
    assert.equal(publicationFor(db, target, "YM-1", "scout", sha256(firstBytes))?.canonical_url, "https://tracker.example/issue/YM-1");
    assert.notEqual(first.id, second.id);
    assert.deepEqual(readPublicationArtifact(root, first), firstBytes);
    assert.equal(readFileSync(first.artifact_path).toString(), firstBytes.toString());
    assert.equal(statSync(first.artifact_path).mode & 0o777, 0o600);
    const planBytes = Buffer.from(plan());
    const planRow = acceptPublication(db, root, { target, targetHash, ticket: "YM-1", kind: "plan", bytes: planBytes, runId: "plan" });
    assert.equal(planRow.plan_path, null);
    const firstRecord = acceptPlanRecord(db, { ticket: "YM-1", publicationId: planRow.id, planPath: "/plan", contentHash: planRow.content_hash, scopeHash: "scope", artifactPath: planRow.artifact_path, bytes: planRow.bytes, scoutPublication: first.id, scoutAcceptance: firstDelivery.id });
    db.exec("BEGIN IMMEDIATE");
    markSuccessfulRecord(db, firstRecord.id);
    db.exec("ROLLBACK");
    assert.equal(planRecordById(db, firstRecord.id)?.successful_record, 0);
    assert.equal(publicationFor(db, target, "YM-1", "plan", sha256(planBytes))?.plan_path, null);
    markSuccessfulRecord(db, firstRecord.id);
    assert.equal(publicationFor(db, target, "YM-1", "plan", sha256(planBytes))?.plan_path, "/plan");
    const repeatedDocument = acceptPublication(db, root, { target, targetHash, ticket: "YM-1", kind: "plan", bytes: planBytes, runId: "new-plan-run", planPath: "/other-plan", scopeHash: "scope" });
    assert.equal(repeatedDocument.id, planRow.id);
    assert.equal(repeatedDocument.plan_path, "/plan", "document framing is immutable");
    const secondRecord = acceptPlanRecord(db, { ticket: "YM-1", publicationId: planRow.id, planPath: "/other-plan", contentHash: planRow.content_hash, scopeHash: "scope", artifactPath: planRow.artifact_path, bytes: planRow.bytes, scoutPublication: second.id, scoutAcceptance: secondDelivery.id });
    assert.equal(planRecordById(db, firstRecord.id)?.successful_record, 1, "pre-CAS intent must not alter the current record");
    assert.equal(planRecordById(db, firstRecord.id)?.scout_publication, first.id);
    assert.equal(planRecordById(db, secondRecord.id)?.successful_record, 0);
    assert.equal(planRecordById(db, secondRecord.id)?.scout_publication, second.id);
    const repeatedLocalRecord = acceptPlanRecord(db, { ticket: "YM-1", publicationId: planRow.id, planPath: "/plan", contentHash: planRow.content_hash, scopeHash: "scope", artifactPath: planRow.artifact_path, bytes: planRow.bytes, scoutPublication: first.id, scoutAcceptance: restartDelivery.id });
    assert.notEqual(repeatedLocalRecord.id, firstRecord.id);
    assert.equal(repeatedLocalRecord.publication_id, planRow.id);
    assert.equal(repeatedLocalRecord.scout_publication, null, "the legacy remote tuple stays unique while local acceptance identity remains distinct");
    assert.equal(repeatedLocalRecord.scout_acceptance, restartDelivery.id);
    writeFileSync(first.artifact_path, "tampered");
    assert.throws(() => readPublicationArtifact(root, first), /artifact_invalid/);
    chmodSync(join(root, ".pi", "plan-publications"), 0o700);
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
