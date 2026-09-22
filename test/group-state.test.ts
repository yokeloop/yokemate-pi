import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { activateGroupRevision, applyGroupMove, canonicalHash, createPlanningGroup, readGroupFactsSnapshot, recordGroupEffect, reserveMemberClaims, restoreGroupFacts, snapshotGroupFacts } from "../src/group-state.ts";
import { drop } from "../src/drop.ts";
import { applyMove } from "../src/transitions.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function prepared() {
  const db = openDb(":memory:");
  const groupId = createPlanningGroup(db, { id: "group-1", rootIdentity: "youtrack:yokeloop:YM-1", rootTicket: "YM-1", ownerProject: "yokeloop/yokemate-pi" });
  reserveMemberClaims(db, { groupId, treeHash: HASH_A, members: ["youtrack:yokeloop:YM-1", "youtrack:yokeloop:YM-2"], owners: [{ runtimeId: "runtime", runId: "run", sessionId: "session" }] });
  activateGroupRevision(db, {
    groupId,
    revisionHash: HASH_B,
    treeHash: HASH_A,
    manifest: { root: "YM-1" },
    bindings: [{ ticket: "YM-1" }, { ticket: "YM-2" }],
    compatibility: { conflicts: [] },
    approachReceiptId: "receipt",
    members: [
      { identity: "youtrack:yokeloop:YM-1", ticket: "YM-1", parentIdentity: null },
      { identity: "youtrack:yokeloop:YM-2", ticket: "YM-2", parentIdentity: "youtrack:yokeloop:YM-1" },
    ],
  });
  return { db, groupId };
}

test("group schema migrates an old work database and reopening is idempotent", () => {
  const directory = mkdtempSync(join(tmpdir(), "yokemate-group-state-"));
  const path = join(directory, "state.db");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE work (id INTEGER PRIMARY KEY,ticket TEXT NOT NULL UNIQUE,url TEXT NOT NULL,title TEXT,stage TEXT NOT NULL DEFAULT 'new',owner TEXT,folder TEXT,plan TEXT,next TEXT,artifact TEXT,pr TEXT,updated_at TEXT); CREATE TABLE part (id INTEGER PRIMARY KEY,work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,repo TEXT,role TEXT,branch TEXT,pr TEXT); CREATE TABLE plan_record (id INTEGER PRIMARY KEY,ticket TEXT,publication_id INTEGER,plan_path TEXT,content_hash TEXT,scope_hash TEXT,artifact_path TEXT,bytes INTEGER,scout_publication INTEGER,scout_acceptance INTEGER,successful_record INTEGER DEFAULT 0,side_effects_started INTEGER DEFAULT 0,created_at TEXT,updated_at TEXT); CREATE TABLE plan_publication (id INTEGER PRIMARY KEY,target TEXT,target_hash TEXT,canonical_url TEXT,ticket TEXT,kind TEXT,content_hash TEXT,provenance_key TEXT,artifact_path TEXT,bytes INTEGER,run_id TEXT,owner_run_id TEXT,owner_session_id TEXT,batch_id TEXT,task_hash TEXT,plan_path TEXT,scope_hash TEXT,scout_publication INTEGER,successful_record INTEGER DEFAULT 0,complete INTEGER DEFAULT 0,error_code TEXT,side_effects_started INTEGER DEFAULT 0,created_at TEXT,updated_at TEXT); CREATE TABLE plan_publication_acceptance (id INTEGER PRIMARY KEY,publication_id INTEGER,ticket TEXT,run_id TEXT,owner_run_id TEXT,owner_session_id TEXT,batch_id TEXT,task_hash TEXT,artifact_path TEXT,content_hash TEXT,bytes INTEGER,created_at TEXT)");
  old.close();
  const db = openDb(path);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='task_group'").get());
  db.close();
  const again = openDb(path);
  assert.ok(again.prepare("SELECT name FROM sqlite_master WHERE name='group_effect'").get());
  again.close();
  rmSync(directory, { recursive: true, force: true });
});

test("group survives queue deletion and keeps root own stage separate from phase", () => {
  const { db, groupId } = prepared();
  db.prepare("INSERT INTO work (ticket,url,stage) VALUES ('YM-1','https://t/YM-1','running')").run();
  db.prepare("DELETE FROM work WHERE ticket='YM-1'").run();
  const group = db.prepare("SELECT phase FROM task_group WHERE id=?").get(groupId) as { phase: string };
  const member = db.prepare("SELECT stage FROM group_member WHERE group_id=? AND ticket='YM-1'").get(groupId) as { stage: string };
  assert.equal(group.phase, "planned");
  assert.equal(member.stage, "planned");
});

test("group CAS and idempotency refuse stale moves and repeat exact effects", () => {
  const { db, groupId } = prepared();
  const first = applyGroupMove(db, { groupId, revisionHash: HASH_B, expectedPhase: "planned", toPhase: "running", idempotencyKey: "start" });
  assert.deepEqual(first, { ok: true, repeat: false, from: "planned", to: "running" });
  const repeat = applyGroupMove(db, { groupId, revisionHash: HASH_B, expectedPhase: "planned", toPhase: "running", idempotencyKey: "start" });
  assert.equal(repeat.ok && repeat.repeat, true);
  const stale = applyGroupMove(db, { groupId, revisionHash: HASH_B, expectedPhase: "planned", toPhase: "review", idempotencyKey: "review" });
  assert.equal(stale.ok, false);
  assert.deepEqual(recordGroupEffect(db, { key: "merge:r:p:h:t", groupId, revisionHash: HASH_B, type: "integrate", scope: { repo: "o/r" }, input: { head: "h" }, state: "intent" }), { repeat: false, state: "intent" });
  assert.deepEqual(recordGroupEffect(db, { key: "merge:r:p:h:t", groupId, revisionHash: HASH_B, type: "integrate", scope: { repo: "o/r" }, input: { head: "h" }, state: "intent" }), { repeat: true, state: "intent" });
});

test("single transitions cannot move a claimed group member", () => {
  const { db, groupId } = prepared();
  db.prepare("INSERT INTO work (ticket,url,stage) VALUES ('YM-2','https://t/YM-2','planned')").run();
  let wrote = false;
  const refused = applyMove(db, "spawn", {}, "YM-2", () => { wrote = true; });
  assert.equal(refused.ok, false);
  assert.equal(wrote, false);
  assert.match(refused.ok ? "" : refused.refuse, new RegExp(groupId));
  const allowed = applyMove(db, "spawn", {}, "YM-2", () => { db.prepare("UPDATE work SET stage='running' WHERE ticket='YM-2'").run(); }, { groupScope: { groupId, revisionHash: HASH_B, memberIdentity: "youtrack:yokeloop:YM-2" } });
  assert.equal(allowed.ok, true);
});

test("canonical group hashes ignore object key insertion order", () => {
  assert.equal(canonicalHash({ b: 2, a: { d: 4, c: 3 } }), canonicalHash({ a: { c: 3, d: 4 }, b: 2 }));
});

test("portable facts restore confirmed outcomes but no process authority", () => {
  const { db, groupId } = prepared();
  db.prepare("UPDATE group_member SET execution='ready',stage='review' WHERE ticket='YM-2'").run();
  recordGroupEffect(db, { key: "done", groupId, revisionHash: HASH_B, type: "done", scope: { ticket: "YM-2" }, input: { state: "Done" }, state: "confirmed", outcome: { state: "Done" } });
  const directory = mkdtempSync(join(tmpdir(), "yokemate-group-facts-"));
  const path = join(directory, "facts.json");
  snapshotGroupFacts(db, groupId, path);
  const facts = readGroupFactsSnapshot(path);
  assert.equal(facts.confirmedEffects.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(facts, "claims"), false);
  db.prepare("UPDATE group_member SET execution='queued',stage='planned' WHERE ticket='YM-2'").run();
  assert.deepEqual(restoreGroupFacts(db, path, () => true), { restored: true });
  const member = db.prepare("SELECT execution,stage FROM group_member WHERE ticket='YM-2'").get() as { execution: string; stage: string };
  assert.deepEqual({ ...member }, { execution: "ready", stage: "review" });
  rmSync(directory, { recursive: true, force: true });
});

test("drop cannot remove a group member or its claim", () => {
  const { db } = prepared();
  db.prepare("INSERT INTO work (ticket,url,stage) VALUES ('YM-2','https://t/YM-2','planned')").run();
  assert.throws(() => drop(db, "YM-2"), /belongs to group/);
  assert.ok(db.prepare("SELECT 1 FROM work WHERE ticket='YM-2'").get());
  assert.ok(db.prepare("SELECT 1 FROM member_claim WHERE member_identity='youtrack:yokeloop:YM-2'").get());
});
