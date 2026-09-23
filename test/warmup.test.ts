// The warmup digest: a deterministic, offline projection of yokemate.db,
// work/ and the journal tail — what a fresh session reads before the first
// prompt. Fixtures live in a temp root; nothing touches the real pool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { buildDigest } from "../src/warmup.ts";
import { activateGroupRevision, createPlanningGroup, reserveMemberClaims } from "../src/group-state.ts";

function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "warmup-"));
}

function seedDb(root: string) {
  const db = openDb(join(root, "yokemate.db"));
  db.prepare("INSERT INTO work (ticket, url, title, stage) VALUES (?, ?, ?, ?)").run(
    "BBB-1",
    "https://t/BBB-1",
    "first fixture ticket",
    "planned",
  );
  db.prepare("INSERT INTO work (ticket, url, title, stage) VALUES (?, ?, ?, ?)").run(
    "BBB-2",
    "https://t/BBB-2",
    "second fixture ticket",
    "review",
  );
  db.close();
}

function appendJournal(root: string, day: string, body: string) {
  const dir = join(root, "home", "journal");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${day.slice(0, 7)}.md`), body, { flag: "a" });
}

test("digest shows the queue, work/ folders and the fresh journal tail", () => {
  const root = makeRoot();
  try {
    seedDb(root);
    mkdirSync(join(root, "work", "AAA-1"), { recursive: true });
    mkdirSync(join(root, "work", "BBB-1"), { recursive: true });

    const fresh = isoDay(daysAgo(0));
    const stale = isoDay(daysAgo(5));
    appendJournal(root, stale, `## ${stale} — org/old — CCC-9\n\n- stale narrative line\n\n`);
    appendJournal(root, fresh, `## ${fresh} — org/new — BBB-1\n\n- fresh narrative line\n\n`);
    appendJournal(root, stale, `- ${stale} 10:00 CCC-9 сделано: stale outcome\n`);
    appendJournal(root, fresh, `- ${fresh} 11:00 BBB-1 запланировано: fresh outcome\n`);

    const digest = buildDigest(root, join(root, "home"));
    assert.match(digest, /BBB-1\s+planned/);
    assert.match(digest, /BBB-2\s+review/);
    assert.ok(digest.includes("AAA-1"));
    assert.ok(digest.includes("есть в work/, нет в очереди"));
    assert.ok(digest.includes("fresh narrative line"));
    assert.ok(digest.includes("fresh outcome"));
    assert.ok(!digest.includes("stale narrative line"), "narrative older than 3 days must be dropped");
    assert.ok(!digest.includes("stale outcome"), "outcome older than 3 days must be dropped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a work/ folder with a queue row carries no orphan mark", () => {
  const root = makeRoot();
  try {
    seedDb(root);
    mkdirSync(join(root, "work", "BBB-1"), { recursive: true });
    const digest = buildDigest(root, join(root, "home"));
    assert.ok(digest.includes("BBB-1"));
    assert.ok(!digest.includes("нет в очереди"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("group root and durable member execution states remain distinct in the digest", () => {
  const root = makeRoot();
  try {
    const db = openDb(join(root, "yokemate.db"));
    const treeHash = "a".repeat(64);
    const revisionHash = "b".repeat(64);
    const groupId = createPlanningGroup(db, { id: "g", rootIdentity: "yt:BBB-1", rootTicket: "BBB-1", ownerProject: "o/r" });
    reserveMemberClaims(db, { groupId, treeHash, members: ["yt:BBB-1", "yt:BBB-2"], owners: [{ runtimeId: "r", runId: "x", sessionId: "s" }] });
    activateGroupRevision(db, { groupId, revisionHash, treeHash, manifest: {}, bindings: {}, compatibility: {}, approachReceiptId: "a", members: [{ identity: "yt:BBB-1", ticket: "BBB-1", parentIdentity: null, execution: "queued" }, { identity: "yt:BBB-2", ticket: "BBB-2", parentIdentity: "yt:BBB-1", execution: "integrated", stage: "integrated" }] });
    db.prepare("UPDATE task_group SET phase='running' WHERE id=?").run(groupId);
    db.close();
    const digest = buildDigest(root, join(root, "home"));
    assert.match(digest, /BBB-1 group\/running revision b{12}/);
    assert.match(digest, /BBB-1 planned\/queued/);
    assert.match(digest, /BBB-2 integrated\/integrated/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing db, journal and work/ do not throw", () => {
  const root = makeRoot();
  try {
    const digest = buildDigest(root, join(root, "home"));
    assert.ok(digest.includes("нет данных"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the digest never exceeds 120 lines and names the full journal on trim", () => {
  const root = makeRoot();
  try {
    seedDb(root);
    const fresh = isoDay(daysAgo(0));
    const lines = Array.from(
      { length: 200 },
      (_, i) => `- ${fresh} 09:${String(i % 60).padStart(2, "0")} DDD-${i} сделано: bulk outcome ${i}\n`,
    ).join("");
    appendJournal(root, fresh, lines);
    const digest = buildDigest(root, join(root, "home"));
    const count = digest.split("\n").length;
    assert.ok(count <= 120, `digest is ${count} lines`);
    assert.ok(digest.includes("обрезано"));
    assert.match(digest, /journal\/\d{4}-\d{2}\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
