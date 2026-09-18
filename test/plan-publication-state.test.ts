import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { assertPlanBinding, readCandidatePlanSnapshot, readRecordedPlanBinding } from "../src/plan-binding.ts";
import { acceptPlanRecord, acceptPublication, acceptPublicationDelivery, markPublicationResult, markSuccessfulRecord, planRecordById, publicationAcceptanceById, publicationFor, readPublicationArtifact, reserveCanonicalUrl } from "../src/plan-publication-state.ts";
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
    const firstRecord = acceptPlanRecord(db, { ticket: "YM-1", publicationId: planRow.id, planPath: "/plan", contentHash: planRow.content_hash, scopeHash: "scope", scoutPublication: first.id });
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
    const secondRecord = acceptPlanRecord(db, { ticket: "YM-1", publicationId: planRow.id, planPath: "/other-plan", contentHash: planRow.content_hash, scopeHash: "scope", scoutPublication: second.id });
    assert.equal(planRecordById(db, firstRecord.id)?.successful_record, 1, "pre-CAS intent must not alter the current record");
    assert.equal(planRecordById(db, firstRecord.id)?.scout_publication, first.id);
    assert.equal(planRecordById(db, secondRecord.id)?.successful_record, 0);
    assert.equal(planRecordById(db, secondRecord.id)?.scout_publication, second.id);
    writeFileSync(first.artifact_path, "tampered");
    assert.throws(() => readPublicationArtifact(root, first), /artifact_invalid/);
    chmodSync(join(root, ".pi", "plan-publications"), 0o700);
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
