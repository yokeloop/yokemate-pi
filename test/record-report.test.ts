import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { recordReport } from "../src/record-report.ts";
import { git, green, notify, stand, withShim, writePr, writeReceipt, type Stand } from "./fixtures/gate-stand.ts";

const env = { YOKEMATE_MODE: "do", YOKEMATE_TICKET: "YM-9", YOKEMATE_ROLE: "coordinator" } as const;
const part = { repo: "org/repo", role: "app", branch: "YM-9", pr: "https://github.com/org/repo/pull/34" };
const passing = [green("checks"), green("pi-loader-smoke"), notify];

function running(s: Stand): void {
  openDb(join(s.root, "yokemate.db")).prepare("INSERT INTO work (ticket, url, stage) VALUES ('YM-9','u','running')").run();
}

function untouched(s: Stand): void {
  const db = openDb(join(s.root, "yokemate.db"));
  assert.equal((db.prepare("SELECT stage FROM work WHERE ticket = 'YM-9'").get() as { stage: string }).stage, "running");
  assert.equal((db.prepare("SELECT count(*) AS n FROM part").get() as { n: number }).n, 0);
  assert.equal(existsSync(join(s.root, "home", "journal")), false);
}

async function refused(setup: (s: Stand) => void, pattern: RegExp): Promise<void> {
  const s = stand();
  try {
    running(s);
    writeReceipt(s);
    writePr(s, "34", passing);
    setup(s);
    await withShim(s, () => assert.throws(() => recordReport(s.root, "YM-9", [part], env, { push: () => undefined }), pattern));
    untouched(s);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
}

test("record-report refuses a rollup with only the notify check", () => refused((s) => writePr(s, "34", [notify]), /required job ci\/checks is missing/));

test("record-report refuses without a ready receipt", () => refused((s) => rmSync(join(s.root, "work", "YM-9", "ready.json")), /no ready receipt/));

test("record-report refuses a receipt taken on another head", () => refused((s) => writeReceipt(s, { head: "f".repeat(40) }), /ready receipt is for/));

test("record-report refuses a PR head that differs from the local branch", () => refused((s) => writePr(s, "34", passing, { headRefOid: "e".repeat(40) }), /differs from local branch/));

test("record-report refuses when the base moved past the head", () => refused((s) => {
  writeFileSync(join(s.clone, "later.txt"), "later\n");
  git(s.clone, "add", "later.txt");
  git(s.clone, "commit", "-m", "later");
  git(s.clone, "push", "origin", "main");
}, /is not in the PR head/));

test("record-report refuses malformed settings before gathering gate facts", () => {
  const s = stand();
  try {
    running(s);
    mkdirSync(join(s.root, ".pi"), { recursive: true });
    writeFileSync(join(s.root, ".pi", "settings.json"), JSON.stringify({ subagent: { maxDetached: 0 } }));
    let gathered = 0;
    assert.throws(() => recordReport(s.root, "YM-9", [part], env, { gather: (() => { gathered++; throw new Error("unexpected gate gather"); }) as never, push: () => undefined }), /subagent.maxDetached/);
    assert.equal(gathered, 0);
    untouched(s);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("record-report records a green gate", async () => {
  const s = stand();
  try {
    running(s);
    writeReceipt(s);
    writePr(s, "34", passing);
    const out = await withShim(s, () => recordReport(s.root, "YM-9", [part], env, { push: () => undefined }));
    assert.deepEqual(out, { repeat: false });
    const db = openDb(join(s.root, "yokemate.db"));
    assert.equal((db.prepare("SELECT stage FROM work WHERE ticket = 'YM-9'").get() as { stage: string }).stage, "review");
    assert.deepEqual(db.prepare("SELECT repo, pr FROM part").all().map((row) => ({ ...row })), [{ repo: "org/repo", pr: part.pr }]);
    const journal = readdirSync(join(s.root, "home", "journal")).map((name) => readFileSync(join(s.root, "home", "journal", name), "utf8")).join("");
    assert.match(journal, /YM-9 сделано: PR #34/);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});
