import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { assertPlanBinding, readCandidatePlanSnapshot, readRecordedPlanBinding } from "../src/plan-binding.ts";
import { acceptPublication, markSuccessfulRecord, publicationFor, readPublicationArtifact } from "../src/plan-publication-state.ts";
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
    const second = acceptPublication(db, root, { target, targetHash, ticket: "YM-1", kind: "scout", bytes: Buffer.from("# scout two\n"), runId: "run-three" });
    assert.equal(first.id, duplicate.id);
    assert.notEqual(first.id, second.id);
    assert.deepEqual(readPublicationArtifact(root, first), firstBytes);
    assert.equal(readFileSync(first.artifact_path).toString(), firstBytes.toString());
    assert.equal(statSync(first.artifact_path).mode & 0o777, 0o600);
    const planBytes = Buffer.from(plan());
    const planRow = acceptPublication(db, root, { target, targetHash, ticket: "YM-1", kind: "plan", bytes: planBytes, runId: "plan", planPath: "/plan", scopeHash: "scope", scoutPublication: first.id });
    db.exec("BEGIN IMMEDIATE");
    markSuccessfulRecord(db, planRow.id, first.id);
    db.exec("ROLLBACK");
    assert.equal(publicationFor(db, target, "YM-1", "plan", sha256(planBytes))?.successful_record, 0);
    markSuccessfulRecord(db, planRow.id, second.id);
    assert.equal(publicationFor(db, target, "YM-1", "plan", sha256(planBytes))?.scout_publication, second.id);
    writeFileSync(first.artifact_path, "tampered");
    assert.throws(() => readPublicationArtifact(root, first), /artifact_invalid/);
    chmodSync(join(root, ".pi", "plan-publications"), 0o700);
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
