import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.ts";
import { assertPlanBinding, parsePlanWriterFinalPath, PlanWriterArtifactError, readCandidatePlanSnapshot, readPlanWriterSnapshot, readRecordedPlanBinding, reconcilePlanWriterArtifact, resolvePlanWriterScope } from "../src/plan-binding.ts";
import { acceptPlanRecord, acceptPublication, acceptPublicationDelivery, acceptScoutArtifact, markPublicationResult, markSuccessfulRecord, planRecordById, publicationAcceptanceById, publicationById, publicationFor, readPublicationArtifact, reserveCanonicalUrl, writePublicationArtifact } from "../src/plan-publication-state.ts";
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

test("YM-221 exact snapshot and reconciliation", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-snapshot-"));
  try {
    const db = openDb(join(root, "yokemate.db"));
    db.prepare("INSERT INTO project(org,repo,path,tracker,tracker_key,model) VALUES('org','repo','/clone','github','YM','test/model')").run();
    db.close();
    const scope = resolvePlanWriterScope(root, "YM-1");
    assert.equal(scope.project, "org/repo");
    const folder = join(scope.knowledgeRoot, "ai", "YM-1-exact result");
    const file = join(folder, "YM-1-exact result-plan.md");
    mkdirSync(folder, { recursive: true });
    writeFileSync(file, plan());
    // Production formatting parser AND snapshot reader: the regex alone accepts
    // spaces, so a same-line pair of paths must still fail artifact validation.
    for (const text of ["/tmp/plain-plan.md", "[k7x2] /tmp/plain-plan.md"])
      assert.equal(parsePlanWriterFinalPath("YM-1", text), "/tmp/plain-plan.md");
    const valid = [file, `[k7x2] ${file}`, `  ${file}  `, `${file}\n`, `[k7x2] ${file}\n`, `\r\n[k7x2] ${file}\r\n`];
    for (const text of valid) {
      assert.equal(parsePlanWriterFinalPath("YM-1", text), file);
      const exact = readPlanWriterSnapshot(root, scope, parsePlanWriterFinalPath("YM-1", text));
      assert.equal(exact.contentHash, sha256(readFileSync(file)));
      assert.deepEqual(exact.bytes, readFileSync(file));
    }
    for (const text of ["", "relative/plan.md", `Saved plan: ${file}`, `[other] ${file}`, `[k7x2] [k7x2] ${file}`, `[plan](${file})`, `\`\`\`\n${file}\n\`\`\``, `${file}\n${file}`, `${file}\x00suffix`, `${file}\x7fsuffix`]) {
      assert.throws(() => parsePlanWriterFinalPath("YM-1", text), (error) => error instanceof PlanWriterArtifactError && error.code === "invalid_plan_path", text);
    }
    for (const text of [`${file} ${file}`, `[k7x2] ${file} ready`])
      assert.throws(() => readPlanWriterSnapshot(root, scope, parsePlanWriterFinalPath("YM-1", text)), PlanWriterArtifactError);
    assert.equal(reconcilePlanWriterArtifact(root, scope).path, file);
    assert.throws(() => readPlanWriterSnapshot(root, scope, join(folder, "plan.md")), /invalid_plan_path/);
    const secondFolder = join(scope.knowledgeRoot, "ai", "YM-1-second");
    mkdirSync(secondFolder);
    writeFileSync(join(secondFolder, "YM-1-second-plan.md"), plan("YM-2"));
    assert.throws(() => reconcilePlanWriterArtifact(root, scope), /ambiguous_artifact/);
    rmSync(secondFolder, { recursive: true });
    rmSync(file);
    const outside = join(root, "outside.md");
    writeFileSync(outside, plan());
    symlinkSync(outside, file);
    assert.throws(() => readPlanWriterSnapshot(root, scope, file), /symlink_component/);
    assert.throws(() => reconcilePlanWriterArtifact(root, scope), /symlink_component/);
    rmSync(file);
    assert.throws(() => reconcilePlanWriterArtifact(root, scope), /artifact_not_found/);
    const historical = join(folder, "plan.md");
    writeFileSync(historical, plan());
    assert.equal(readCandidatePlanSnapshot(root, "YM-1", historical).contentHash, sha256(readFileSync(historical)));
    const state = openDb(join(root, "yokemate.db"));
    state.prepare("DELETE FROM project").run();
    state.close();
    assert.throws(() => resolvePlanWriterScope(root, "YM-1"), /scope_not_found/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("YM-221 writer scope, unsafe candidates and deterministic snapshot races fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-safety-"));
  try {
    const db = openDb(join(root, "yokemate.db"));
    db.prepare("INSERT INTO project(org,repo,path,tracker,tracker_key,model) VALUES('org','repo','/one','github','YM','test/model')").run();
    db.close();
    const scope = resolvePlanWriterScope(root, "YM-9");
    assert.equal(scope.project, "org/repo");
    const folder = join(scope.knowledgeRoot, "ai", "YM-9-race plan");
    const file = join(folder, "YM-9-race plan-plan.md");
    mkdirSync(folder, { recursive: true });
    writeFileSync(file, plan("YM-9"));
    assert.equal(readPlanWriterSnapshot(root, scope, file).contentHash, sha256(readFileSync(file)));
    assert.throws(() => readPlanWriterSnapshot(root, scope, `${folder}/./YM-9-race plan-plan.md`), /invalid_plan_path/);
    assert.throws(() => readPlanWriterSnapshot(root, scope, `${folder}/../YM-9-race plan/YM-9-race plan-plan.md`), /invalid_plan_path/);
    assert.throws(() => readPlanWriterSnapshot(root, scope, join(folder, "YM-8-race plan-plan.md")), /invalid_plan_path/);
    assert.throws(() => readPlanWriterSnapshot(root, scope, join(folder, "YM-9-other-plan.md")), /invalid_plan_path/);
    assert.throws(() => readPlanWriterSnapshot(root, scope, join(root, "outside.md")), /outside_project/);
    writeFileSync(file, plan("YM-9").replace("## Steps", "## Cross-repository contract\n- invalid for one repository\n\n## Steps"));
    assert.throws(() => readPlanWriterSnapshot(root, scope, file), /invalid_sections/);

    const original = Buffer.from(plan("YM-9"));
    writeFileSync(file, original);
    assert.throws(() => readPlanWriterSnapshot(root, scope, file, { beforeOpen: () => {
      renameSync(file, `${file}.old`);
      writeFileSync(file, original);
    } }), /binding_changed/);
    rmSync(`${file}.old`);
    assert.throws(() => readPlanWriterSnapshot(root, scope, file, { beforeCanonical: () => {
      renameSync(file, `${file}.old`);
      writeFileSync(file, original);
    } }), /binding_changed/);
    rmSync(`${file}.old`);
    assert.throws(() => readPlanWriterSnapshot(root, scope, file, { afterRead: () => writeFileSync(file, `${plan("YM-9")}\n`) }), /binding_changed/);
    writeFileSync(file, original);
    const moved = `${folder}.old`;
    assert.throws(() => readPlanWriterSnapshot(root, scope, file, { beforeFinalStat: () => {
      renameSync(folder, moved);
      mkdirSync(folder);
      writeFileSync(file, original);
    } }), /binding_changed/);
    rmSync(moved, { recursive: true });

    rmSync(file);
    execFileSync("mkfifo", [file]);
    assert.throws(() => readPlanWriterSnapshot(root, scope, file), /not_regular/);
    rmSync(file);
    mkdirSync(file);
    assert.throws(() => readPlanWriterSnapshot(root, scope, file), /not_regular/);
    rmSync(file, { recursive: true });
    writeFileSync(file, plan("YM-8"));
    assert.throws(() => reconcilePlanWriterArtifact(root, scope), /wrong_heading/);
    const second = join(scope.knowledgeRoot, "ai", "YM-9-second");
    mkdirSync(second);
    writeFileSync(join(second, "YM-9-second-plan.md"), plan("YM-9"));
    assert.throws(() => reconcilePlanWriterArtifact(root, scope), /ambiguous_artifact/);
    rmSync(second, { recursive: true });
    writeFileSync(file, original);
    assert.throws(() => reconcilePlanWriterArtifact(root, scope, { afterSnapshot: () => {
      const added = join(scope.knowledgeRoot, "ai", "YM-9-added");
      mkdirSync(added);
      writeFileSync(join(added, "YM-9-added-plan.md"), original);
    } }), /ambiguous_artifact/);
    rmSync(join(scope.knowledgeRoot, "ai", "YM-9-added"), { recursive: true });
    const replaced = `${file}.replaced`;
    assert.throws(() => reconcilePlanWriterArtifact(root, scope, { afterSnapshot: () => {
      renameSync(file, replaced);
      writeFileSync(file, original);
    } }), /binding_changed/);
    rmSync(replaced);
    rmSync(folder, { recursive: true });
    const unsafe = join(scope.knowledgeRoot, "ai", "YM-9-unsafe");
    writeFileSync(unsafe, "not a directory");
    assert.throws(() => reconcilePlanWriterArtifact(root, scope), /not_regular/);
    rmSync(unsafe);

    const many = openDb(join(root, "yokemate.db"));
    many.prepare("UPDATE project SET repo='..' WHERE tracker_key='YM'").run();
    assert.throws(() => resolvePlanWriterScope(root, "YM-9"), /invalid_scope/);
    many.prepare("UPDATE project SET repo='repo' WHERE tracker_key='YM'").run();
    many.prepare("INSERT INTO project(org,repo,path,tracker,tracker_key,model) VALUES('other','repo','/three','github','YM','test/model')").run();
    many.close();
    assert.throws(() => resolvePlanWriterScope(root, "YM-9"), /ambiguous_scope/);
  } finally { rmSync(root, { recursive: true, force: true }); }

  const linkedRoot = mkdtempSync(join(tmpdir(), "writer-linked-"));
  const backing = mkdtempSync(join(tmpdir(), "writer-backing-"));
  try {
    const db = openDb(join(linkedRoot, "yokemate.db"));
    db.prepare("INSERT INTO project(org,repo,path,tracker,tracker_key,model) VALUES('org','repo','/one','github','YM','test/model')").run();
    db.close();
    symlinkSync(backing, join(linkedRoot, "home"));
    const scope = resolvePlanWriterScope(linkedRoot, "YM-9");
    const folder = join(scope.knowledgeRoot, "ai", "YM-9-linked");
    const file = join(folder, "YM-9-linked-plan.md");
    mkdirSync(folder, { recursive: true });
    writeFileSync(file, plan("YM-9"));
    assert.throws(() => readPlanWriterSnapshot(linkedRoot, scope, file), /symlink_component/);
  } finally {
    rmSync(linkedRoot, { recursive: true, force: true });
    rmSync(backing, { recursive: true, force: true });
  }
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

test("normal publication API cannot inject recovery provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "publication-normal-api-"));
  try {
    const db = openDb(join(root, "yokemate.db"));
    const row = acceptPublication(db, root, { target: "github:org/repo#1", targetHash: sha256("github:org/repo#1"), ticket: "YM-1", kind: "scout", bytes: Buffer.from("# scout\n"), runId: "run", provenance: { source_kind: "engineer-accepted-input", incident_id: "forged" } } as any);
    assert.equal(row.source_kind, "normal-transport");
    assert.equal(row.incident_id, null);
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
    assert.throws(() => acceptPlanRecord(db, { ticket: "YM-1", publicationId: first.id, planPath: "/invalid-kind", contentHash: first.content_hash, scopeHash: "scope", artifactPath: first.artifact_path, bytes: first.bytes, scoutAcceptance: firstDelivery.id }), /artifact_invalid/);
    const foreignPlan = acceptPublication(db, root, { target, targetHash, ticket: "YM-2", kind: "plan", bytes: planBytes, runId: "foreign-plan" });
    assert.throws(() => acceptPlanRecord(db, { ticket: "YM-1", publicationId: foreignPlan.id, planPath: "/foreign", contentHash: foreignPlan.content_hash, scopeHash: "scope", artifactPath: foreignPlan.artifact_path, bytes: foreignPlan.bytes, scoutAcceptance: firstDelivery.id }), /artifact_invalid/);
    assert.throws(() => acceptPlanRecord(db, { ticket: "YM-1", publicationId: planRow.id, planPath: "/wrong-hash", contentHash: "f".repeat(64), scopeHash: "scope", artifactPath: planRow.artifact_path, bytes: planRow.bytes, scoutAcceptance: firstDelivery.id }), /artifact_invalid/);
    assert.throws(() => acceptPlanRecord(db, { ticket: "YM-1", planPath: "/wrong-scout", contentHash: planRow.content_hash, scopeHash: "scope", artifactPath: planRow.artifact_path, bytes: planRow.bytes, scoutPublication: second.id, scoutAcceptance: firstDelivery.id }), /artifact_invalid/);
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
    const lateBytes = Buffer.from(plan().replace("Publish a plan.", "Publish a late plan."));
    const latePublication = acceptPublication(db, root, { target, targetHash, ticket: "YM-1", kind: "plan", bytes: lateBytes, runId: "late-plan" });
    const lateRecord = acceptPlanRecord(db, { ticket: "YM-1", planPath: "/late-plan", contentHash: latePublication.content_hash, scopeHash: "late-scope", artifactPath: latePublication.artifact_path, bytes: latePublication.bytes, scoutPublication: first.id, scoutAcceptance: firstDelivery.id });
    markSuccessfulRecord(db, lateRecord.id);
    assert.equal(publicationById(db, latePublication.id)?.plan_path, null);
    const linkedLateRecord = acceptPlanRecord(db, { ticket: "YM-1", publicationId: latePublication.id, planPath: "/late-plan", contentHash: latePublication.content_hash, scopeHash: "late-scope", artifactPath: latePublication.artifact_path, bytes: latePublication.bytes, scoutPublication: first.id, scoutAcceptance: firstDelivery.id });
    assert.equal(linkedLateRecord.publication_id, latePublication.id);
    assert.equal(publicationById(db, latePublication.id)?.plan_path, "/late-plan");
    assert.equal(publicationById(db, latePublication.id)?.scope_hash, "late-scope");
    writeFileSync(first.artifact_path, "tampered");
    assert.throws(() => readPublicationArtifact(root, first), /artifact_invalid/);
    chmodSync(join(root, ".pi", "plan-publications"), 0o700);
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
