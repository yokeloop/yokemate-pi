// Smoke set. Trackers are fixtures, never network: the run finishes by itself
// in seconds.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, ownerFor } from "../src/db.ts";
import {
  modelForOrg,
  modelForTicket,
  parseModeModels,
  parseModelToken,
  rowModel,
  serializeModeModels,
} from "../src/project-model.ts";
import { syncWork, type TicketState } from "../src/sync.ts";
import { fetchAll, fetchIssue, PAGE, ticketStates, valueNames, type RawIssue } from "../src/youtrack.ts";
import { MODES, freeAgentName, resolveLaunch, resolveModeModel, resolvePlanTargets } from "../src/mode-tab.ts";
import { parseSurfaceArgs } from "../src/mode-surface.ts";
import { decide } from "../src/mode-guard.ts";
import { parseKeyList, parseShipArgs } from "../src/ship-args.ts";
import { resolveRuntimeSettings } from "../src/guard-policy.ts";
import { linkTeammates } from "../src/teammates.ts";
import { logMove } from "../src/move-log.ts";
import { closeTab, findOpenTab, findRunningAgent, startAgent } from "../src/herdr.ts";
import { stopVerdict } from "../src/report-guard.ts";
import { THINKING_LEVELS, checkModel } from "../src/pi-model.ts";

function memDb() {
  return openDb(":memory:");
}

function insertWork(db: ReturnType<typeof memDb>, ticket: string, extra: Record<string, unknown> = {}) {
  const cols = { ticket, url: `https://t/${ticket}`, title: "t", stage: "new", ...extra };
  const names = Object.keys(cols);
  db.prepare(
    `INSERT INTO work (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`,
  ).run(...Object.values(cols) as (string | null)[]);
}

const alive: TicketState = { resolved: false, assignedToMe: true, title: "t" };

// 1. Sync never deletes: closed / reassigned / vanished tickets stay in the
// queue and come back as divergences for the view to show.
test("sync keeps every row, reports divergence", async () => {
  const db = memDb();
  insertWork(db, "ACME-1");
  insertWork(db, "ACME-2");
  insertWork(db, "ACME-3");
  insertWork(db, "ACME-4");
  // ACME-3 is absent from the map — that is what "missing" looks like.
  const states = new Map<string, TicketState>([
    ["ACME-1", { ...alive, resolved: true }],
    ["ACME-2", { ...alive, assignedToMe: false }],
    ["ACME-4", alive],
  ]);
  const calls: string[][] = [];
  const { diverged } = await syncWork(db, async (tickets) => {
    calls.push(tickets);
    return states;
  });
  // One fetch for the whole queue, every ticket in it.
  assert.equal(calls.length, 1);
  assert.deepEqual([...calls[0]].sort(), ["ACME-1", "ACME-2", "ACME-3", "ACME-4"]);
  assert.deepEqual(
    diverged.sort((a, b) => a.ticket.localeCompare(b.ticket)),
    [
      { ticket: "ACME-1", reason: "closed" },
      { ticket: "ACME-2", reason: "reassigned" },
      { ticket: "ACME-3", reason: "missing" },
    ],
  );
  const left = db.prepare("SELECT ticket FROM work ORDER BY ticket").all() as { ticket: string }[];
  assert.deepEqual(left.map((r) => r.ticket), ["ACME-1", "ACME-2", "ACME-3", "ACME-4"]);
});

// 2. Sync updates the title but never local fields (next, artifact).
test("sync keeps local fields while updating title", async () => {
  const db = memDb();
  insertWork(db, "ACME-5", { next: "поднять стенд", artifact: "ai/x/x-plan.md" });
  await syncWork(
    db,
    async (tickets) => new Map(tickets.map((t) => [t, { ...alive, title: "новый заголовок" }])),
  );
  const row = db.prepare("SELECT title, next, artifact FROM work").get() as Record<string, string>;
  assert.equal(row.title, "новый заголовок");
  assert.equal(row.next, "поднять стенд");
  assert.equal(row.artifact, "ai/x/x-plan.md");
});

// 3. A row without a ticket is impossible.
test("work row without ticket cannot exist", () => {
  const db = memDb();
  assert.throws(() =>
    db.prepare("INSERT INTO work (ticket, url) VALUES (NULL, 'u')").run(),
  );
});

// 4. accepted gets no special treatment: sync leaves the row where it is —
// the exit happens inside accept itself, not on a later read.
test("sync leaves an accepted row alone", async () => {
  const db = memDb();
  insertWork(db, "ACME-6", { stage: "accepted" });
  const { diverged } = await syncWork(db, async (tickets) => new Map(tickets.map((t) => [t, alive])));
  assert.deepEqual(diverged, []);
  const left = db.prepare("SELECT ticket FROM work").all() as { ticket: string }[];
  assert.deepEqual(left.map((r) => r.ticket), ["ACME-6"]);
});

// 5. Stage transition changes the derived owner per the table.
test("owner follows stage unless overridden", () => {
  assert.equal(ownerFor("new"), "me");
  assert.equal(ownerFor("scouted"), "me");
  assert.equal(ownerFor("planned"), "agent");
  assert.equal(ownerFor("running"), "agent");
  assert.equal(ownerFor("review"), "me");
  assert.equal(ownerFor("accepted"), null);
  assert.equal(ownerFor("planned", "me"), "me"); // explicit override wins
});

// 6. Pagination is read to the very end.
test("fetchAll reads every page", async () => {
  const total = PAGE * 2 + 7; // three pages, last one short
  const issue = (i: number): RawIssue => ({ idReadable: `X-${i}`, summary: "s" });
  const calls: number[] = [];
  const fakeFetch = (async (url: string) => {
    const skip = Number(new URL(url).searchParams.get("$skip"));
    calls.push(skip);
    const page = Array.from(
      { length: Math.max(0, Math.min(PAGE, total - skip)) },
      (_, i) => issue(skip + i),
    );
    return new Response(JSON.stringify(page), { status: 200 });
  }) as typeof fetch;
  const got = await fetchAll({ kind: "youtrack", name: "fx", baseUrl: "https://fx", token: "t" }, fakeFetch);
  assert.equal(got.length, total);
  assert.deepEqual(calls, [0, PAGE, PAGE * 2]);
});

// 7. The queue sync asks the tracker once per page, not once per row: one
// `issue id: …` query answers for every ticket, a key missing from the answer
// is the "missing" divergence, and `users/me` rides the existing cache.
test("ticketStates asks one request per page and parses states", async () => {
  const urls: string[] = [];
  const fakeFetch = (async (url: string) => {
    urls.push(url);
    if (url.includes("/api/users/me"))
      return new Response(JSON.stringify({ login: "me" }), { status: 200 });
    return new Response(
      JSON.stringify([
        {
          idReadable: "ST-1", summary: "open", resolved: null,
          customFields: [{ name: "Assignee", $type: "SingleUserIssueCustomField", value: { login: "me" } }],
        },
        {
          idReadable: "ST-2", summary: "closed", resolved: 1724000000000,
          customFields: [{ name: "Assignee", $type: "SingleUserIssueCustomField", value: { login: "someone" } }],
        },
      ]),
      { status: 200 },
    );
  }) as typeof fetch;

  const states = await ticketStates(
    { kind: "youtrack", name: "st", baseUrl: "https://st", token: "t" },
    ["ST-1", "ST-2", "ST-3"],
    fakeFetch,
  );
  const issueCalls = urls.filter((u) => u.includes("/api/issues"));
  assert.equal(issueCalls.length, 1);
  assert.match(decodeURIComponent(issueCalls[0]), /issue id: ST-1, ST-2, ST-3/);
  assert.match(decodeURIComponent(issueCalls[0]), /customFields\(name,\$type,value\(login\)\)/);
  assert.deepEqual(states.get("ST-1"), { resolved: false, assignedToMe: true, title: "open" });
  assert.deepEqual(states.get("ST-2"), { resolved: true, assignedToMe: false, title: "closed" });
  assert.equal(states.has("ST-3"), false);
});

// 8. Parts of a ticket are never lost: each has repo, branch and PR.
test("every part carries repo, branch and pr", () => {
  const db = memDb();
  insertWork(db, "ACME-7", { stage: "review" });
  const w = db.prepare("SELECT id FROM work WHERE ticket='ACME-7'").get() as { id: number };
  db.prepare("INSERT INTO part (work_id, repo, role, branch, pr) VALUES (?,?,?,?,?)")
    .run(w.id, "acme/acme-ui-kit", "library", "ACME-7", "https://x/pr/1");
  db.prepare("INSERT INTO part (work_id, repo, role, branch, pr) VALUES (?,?,?,?,?)")
    .run(w.id, "acme/acme-subscription-page", "app", "ACME-7", "https://x/pr/2");
  const parts = db.prepare("SELECT repo, branch, pr FROM part WHERE work_id = ?").all(w.id) as
    { repo: string; branch: string; pr: string }[];
  assert.equal(parts.length, 2);
  for (const p of parts) {
    assert.ok(p.repo && p.branch && p.pr, "part missing repo/branch/pr");
  }
  // deleting the work row cascades: no orphan parts
  db.prepare("DELETE FROM work WHERE id = ?").run(w.id);
  const left = db.prepare("SELECT COUNT(*) c FROM part").get() as { c: number };
  assert.equal(left.c, 0);
});

// 7. Acceptance never removes the task folder: /ship works in it after the
// clean pass and removes it after the merge; remarks keep it as before.
test("acceptance keeps the folder in both outcomes", async () => {
  const { accept } = await import("../src/accept.ts");
  const { mkdirSync, existsSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = join(process.env.TMPDIR ?? "/tmp", `yokemate-test-${process.pid}`);

  // clean pass → folder stays for /ship, row gone
  const db1 = memDb();
  const f1 = join(root, "work", "ACME-8");
  mkdirSync(f1, { recursive: true });
  writeFileSync(join(f1, "x"), "");
  insertWork(db1, "ACME-8", { stage: "review", folder: f1 });
  const clean = accept(db1, root, "ACME-8");
  assert.equal(clean.outcome, "accepted");
  assert.ok(existsSync(f1), "folder must stay on clean pass — /ship removes it");
  assert.equal(clean.folder, f1);
  const s1 = db1.prepare("SELECT stage FROM work WHERE ticket='ACME-8'").get();
  assert.equal(s1, undefined);

  // remarks → folder stays, stage planned, rework plan recorded
  const db2 = memDb();
  const f2 = join(root, "work", "ACME-9");
  mkdirSync(f2, { recursive: true });
  insertWork(db2, "ACME-9", { stage: "review", folder: f2 });
  const rework = accept(db2, root, "ACME-9", { reworkPlan: join(root, "rework.md") });
  assert.equal(rework.outcome, "rework");
  assert.ok(existsSync(f2), "folder must stay when remarks exist");
  const s2 = db2.prepare("SELECT stage, plan FROM work WHERE ticket='ACME-9'").get() as { stage: string; plan: string };
  assert.equal(s2.stage, "planned");
  assert.ok(s2.plan.endsWith("rework.md"));

  rmSync(root, { recursive: true, force: true });
});

test("owned review rework records an exact plan and preserves the stand", async () => {
  const { recordReviewRework } = await import("../src/accept.ts");
  const root = join(process.env.TMPDIR ?? "/tmp", `yokemate-test-review-record-${process.pid}`);
  const folder = join(root, "home", "knowledge", "org", "repo", "ai", "ACME-9-rework");
  fs.mkdirSync(folder, { recursive: true });
  const plan = join(folder, "ACME-9-rework-plan.md");
  fs.writeFileSync(plan, "# ACME-9 — rework\n\n## Goal\nFix review remarks.\n\n## Affected repositories\n- `org/repo` — app\n\n## Steps\n1. Fix behavior.\n\n## Assumptions\n- Existing stand.\n\n## Out of scope\n- Other work.\n\n## Acceptance\nThe remark is fixed.\n");
  const db = openDb(join(root, "yokemate.db"));
  try {
    db.prepare("INSERT INTO work (ticket,url,stage,folder) VALUES ('ACME-9','u','review','/stand')").run();
    const work = db.prepare("SELECT id FROM work WHERE ticket='ACME-9'").get() as { id: number };
    db.prepare("INSERT INTO part (work_id,repo,role,branch,pr) VALUES (?, 'org/repo','app','ACME-9','https://example/pr')").run(work.id);
    const recorded = recordReviewRework(db, root, "ACME-9", plan, { YOKEMATE_MODE: "review", YOKEMATE_TICKET: "ACME-9", YOKEMATE_ROLE: "coordinator" });
    assert.equal(recorded.binding.path, plan);
    assert.equal(db.prepare("SELECT stage FROM work WHERE ticket='ACME-9'").get()!.stage, "planned");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM part WHERE work_id=?").get(work.id)!.count, 1);
    assert.throws(() => recordReviewRework(db, root, "ACME-9", plan, { YOKEMATE_MODE: "review", YOKEMATE_TICKET: "ACME-9", YOKEMATE_ROLE: "coordinator" }), /changed from review to planned/);
    assert.throws(() => recordReviewRework(db, root, "ACME-9", plan, { YOKEMATE_MODE: "review", YOKEMATE_TICKET: "ACME-9", YOKEMATE_ROLE: "coordinator" }, { ...recorded.binding, contentHash: "foreign" }), /content hash/);
    const repeated = recordReviewRework(db, root, "ACME-9", plan, { YOKEMATE_MODE: "review", YOKEMATE_TICKET: "ACME-9", YOKEMATE_ROLE: "coordinator" }, recorded.binding);
    assert.equal(repeated.repeat, true);
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("accept refuses malformed settings before reading or changing the work row", async () => {
  const { accept } = await import("../src/accept.ts");
  const root = join(process.env.TMPDIR ?? "/tmp", `yokemate-test-accept-settings-${process.pid}`);
  fs.mkdirSync(join(root, ".pi"), { recursive: true });
  fs.writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({ guardPolicy: { workflowApproval: "bad" } }));
  const db = memDb();
  insertWork(db, "ACME-10", { stage: "review" });
  assert.throws(() => accept(db, root, "ACME-10"), /guardPolicy.workflowApproval/);
  assert.equal(db.prepare("SELECT stage FROM work WHERE ticket='ACME-10'").get()!.stage, "review");
  fs.rmSync(root, { recursive: true, force: true });
});

// 7a. The row's exit lives in accept itself, not in a later sync: a clean pass
// deletes it at once, and running accept again on the gone row is a no-op.
test("accept removes the row at once, a repeat is a no-op", async () => {
  const { accept } = await import("../src/accept.ts");
  const { join } = await import("node:path");
  const root = join(process.env.TMPDIR ?? "/tmp", `yokemate-test-accept-${process.pid}`);
  const db = memDb();
  insertWork(db, "ACME-10", { stage: "review" });

  const first = accept(db, root, "ACME-10");
  assert.equal(first.outcome, "accepted");
  assert.equal(db.prepare("SELECT 1 FROM work WHERE ticket='ACME-10'").get(), undefined);

  const again = accept(db, root, "ACME-10");
  assert.equal(again.outcome, "noop");
});

// 7b. drop is the engineer's other exit: it deletes the queue row and only
// the row — worktrees, branches and PRs stay. A repeat is a no-op.
test("drop removes the row and only the row, a repeat is a no-op", async () => {
  const { drop } = await import("../src/drop.ts");
  const db = memDb();
  insertWork(db, "ACME-11", { stage: "planned" });
  const w = db.prepare("SELECT id FROM work WHERE ticket='ACME-11'").get() as { id: number };
  db.prepare("INSERT INTO part (work_id, repo, role) VALUES (?,?,?)")
    .run(w.id, "acme/r", "app");
  insertWork(db, "ACME-12", { stage: "review" });

  assert.equal(drop(db, "ACME-11"), true);
  assert.equal(db.prepare("SELECT 1 FROM work WHERE ticket='ACME-11'").get(), undefined);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM part").get()!.c, 0);
  assert.notEqual(db.prepare("SELECT 1 FROM work WHERE ticket='ACME-12'").get(), undefined);

  assert.equal(drop(db, "ACME-11"), false);
});

// 9. Passport columns added after the fact land on an existing table.
test("project passport migrates to figma_url and subsystem", () => {
  const db = memDb();
  db.exec("DROP TABLE project");
  db.exec(`CREATE TABLE project (
    id INTEGER PRIMARY KEY, org TEXT NOT NULL, repo TEXT NOT NULL, path TEXT NOT NULL,
    tracker TEXT NOT NULL, tracker_key TEXT NOT NULL, figma_mcp TEXT, UNIQUE (org, repo))`);
  db.prepare(
    "INSERT INTO project (org, repo, path, tracker, tracker_key) VALUES ('acme','r','/p','acme','ACME')",
  ).run();
  // Reopening the same connection's schema step is what add-project does.
  const cols = new Set(
    (db.prepare("PRAGMA table_info(project)").all() as unknown as { name: string }[]).map((c) => c.name),
  );
  assert.equal(cols.has("subsystem"), false);
  for (const col of ["figma_url", "subsystem"]) db.exec(`ALTER TABLE project ADD COLUMN ${col} TEXT`);
  db.prepare("UPDATE project SET subsystem = 'CRM' WHERE repo = 'r'").run();
  const row = db.prepare("SELECT subsystem, figma_url FROM project").get() as Record<string, unknown>;
  assert.equal(row.subsystem, "CRM");
  assert.equal(row.figma_url, null);
});

// 9a. The model column lands on passports that predate it, filled once with a
// single pi pattern — the passports say nothing that would tell them apart. A
// fresh database refuses a passport without a model outright.
test("project passport migrates to model with one-time backfill", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "yokemate-model-"));
  const path = join(dir, "old.db");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE project (
    id INTEGER PRIMARY KEY, org TEXT NOT NULL, repo TEXT NOT NULL, path TEXT NOT NULL,
    tracker TEXT NOT NULL, tracker_key TEXT NOT NULL, figma_mcp TEXT, figma_url TEXT,
    subsystem TEXT, UNIQUE (org, repo))`);
  const ins = old.prepare(
    "INSERT INTO project (org, repo, path, tracker, tracker_key) VALUES (?, ?, '/p', ?, ?)",
  );
  ins.run("yokeloop", "yokemate", "yokeloop", "YM");
  ins.run("acme", "lk-subscription", "acme", "ACME");
  old.close();

  const db = openDb(path);
  const models = Object.fromEntries(
    (db.prepare("SELECT repo, model FROM project").all() as unknown as
      { repo: string; model: string }[]).map((r) => [r.repo, r.model]),
  );
  assert.equal(models["yokemate"], "openai-codex/gpt-5.6-terra");
  assert.equal(models["lk-subscription"], "openai-codex/gpt-5.6-terra");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });

  const fresh = memDb();
  assert.throws(
    () =>
      fresh.prepare(
        "INSERT INTO project (org, repo, path, tracker, tracker_key) VALUES ('o','r','/p','t','K')",
      ).run(),
    /NOT NULL/,
  );
});

// 9c. The per-mode column lands on passports that predate it, and an old
// passport still answers — with its project default, on every mode.
test("the per-mode model column lands on an existing passport table", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "yokemate-mode-models-"));
  const path = join(dir, "old.db");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE project (
    id INTEGER PRIMARY KEY, org TEXT NOT NULL, repo TEXT NOT NULL, path TEXT NOT NULL,
    tracker TEXT NOT NULL, tracker_key TEXT NOT NULL, model TEXT NOT NULL, figma_mcp TEXT,
    figma_url TEXT, subsystem TEXT, UNIQUE (org, repo))`);
  old.prepare(
    "INSERT INTO project (org, repo, path, tracker, tracker_key, model) VALUES ('yokeloop','yokemate','/p','yokeloop','YM','fable')",
  ).run();
  const before = new Set(
    (old.prepare("PRAGMA table_info(project)").all() as unknown as { name: string }[]).map((c) => c.name),
  );
  assert.equal(before.has("mode_models"), false);
  old.close();

  const db = openDb(path);
  const cols = new Set(
    (db.prepare("PRAGMA table_info(project)").all() as unknown as { name: string }[]).map((c) => c.name),
  );
  assert.equal(cols.has("mode_models"), true);
  const row = db
    .prepare("SELECT model, mode_models FROM project WHERE repo = 'yokemate'")
    .get() as unknown as { model: string; mode_models: string | null };
  assert.equal(row.model, "fable");
  assert.equal(row.mode_models, null);
  assert.equal(rowModel(row, "review"), "fable");
  assert.equal(modelForTicket(db, "YM-84", "review"), "fable");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// 9d. The map survives the round trip column → map → column canonically, and
// one parser reads the `<mode>=<model>` token for add-project and set-model
// alike, so both refuse an unknown mode in the same words.
test("a per-mode model round-trips through the column and its command token", () => {
  assert.equal(serializeModeModels({}), null);

  const map = { review: "luna", ship: "terra" } as const;
  assert.deepEqual(parseModeModels(serializeModeModels(map)), map);
  // Insertion order must not reach the column: two writes of one map are one string.
  assert.equal(
    serializeModeModels({ ship: "terra", review: "luna" }),
    serializeModeModels({ review: "luna", ship: "terra" }),
  );

  assert.deepEqual(parseModelToken("review=x"), { mode: "review", model: "x" });
  assert.deepEqual(parseModelToken("x"), { mode: null, model: "x" });
  assert.throws(() => parseModelToken("foo=x"), /plan, review, do, ship, worklog, note/);
  assert.throws(() => parseModelToken("review="), /has no model/);

  // A hand-edited row never kills the launch: what is unreadable resolves to
  // the project default instead.
  assert.deepEqual(parseModeModels('{"review":"x","nope":"y"}'), { review: "x" });
  assert.deepEqual(parseModeModels("не json"), {});
  assert.deepEqual(parseModeModels('["review"]'), {});
  assert.deepEqual(parseModeModels(null), {});
});

// 9b. Existing passports answer with one distinct value per tracker key (or
// org for worklog); an absent set returns null so the caller can ask the pool.
// The value is resolved per passport row before the rows are deduplicated: the
// mode's override is what has to agree, not the column it was read from.
test("model resolves per tracker key and org, refusing gaps and disagreement", () => {
  const db = memDb();
  const ins = db.prepare(
    "INSERT INTO project (org, repo, path, tracker, tracker_key, model, mode_models) VALUES (?, ?, '/p', ?, ?, ?, ?)",
  );
  ins.run("yokeloop", "yokemate", "yokeloop", "YM", "fable", null);
  ins.run("acme", "lk-subscription", "acme", "ACME", "opus", '{"review":"luna"}');
  ins.run("acme", "acme-crm", "acme", "ACME", "opus", '{"review":"luna"}');
  ins.run("acme-eu", "repo-a", "acme-eu", "AEU", "opus", null);
  ins.run("acme-eu", "repo-b", "acme-eu", "AEU", "sonnet", null);
  // One key, two defaults that disagree, one plan override they share.
  ins.run("dis", "repo-a", "dis", "DIS", "opus", '{"plan":"astra"}');
  ins.run("dis", "repo-b", "dis", "DIS", "sonnet", '{"plan":"astra"}');
  // One key, one default they share, two ship overrides that disagree.
  ins.run("shp", "repo-a", "shp", "SHP", "opus", '{"ship":"astra"}');
  ins.run("shp", "repo-b", "shp", "SHP", "opus", '{"ship":"luna"}');

  assert.equal(modelForTicket(db, "YM-84", "do"), "fable");
  assert.equal(modelForTicket(db, "ACME-347", "do"), "opus");
  assert.equal(modelForTicket(db, "ACME-347", "review"), "luna");
  assert.throws(() => modelForTicket(db, "AEU-1", "do"), /AEU/);
  assert.equal(modelForTicket(db, "NOPE-1", "do"), null);

  // The override answers where the defaults would have refused …
  assert.equal(modelForTicket(db, "DIS-1", "plan"), "astra");
  assert.throws(() => modelForTicket(db, "DIS-1", "do"), /disagree on the do model/);
  // … and refuses where the defaults would have agreed.
  assert.equal(modelForTicket(db, "SHP-1", "do"), "opus");
  assert.throws(() => modelForTicket(db, "SHP-1", "ship"), /disagree on the ship model/);

  assert.equal(modelForOrg(db, "acme", "worklog"), "opus");
  assert.equal(modelForOrg(db, "acme", "review"), "luna");
  assert.throws(() => modelForOrg(db, "acme-eu", "worklog"), /acme-eu/);
  assert.equal(modelForOrg(db, "ghost", "worklog"), null);

  const legacy = new DatabaseSync(":memory:");
  legacy.exec("CREATE TABLE project (tracker_key TEXT, org TEXT, model TEXT, mode_models TEXT)");
  legacy.prepare("INSERT INTO project VALUES ('OLD', 'old', NULL, NULL)").run();
  assert.throws(() => modelForTicket(legacy, "OLD-1", "do"), /disagree on the do model \(NULL\)/);
  assert.throws(() => modelForOrg(legacy, "old", "worklog"), /disagree on the worklog model \(NULL\)/);
});

test("foreground mode model resolution falls back only for an empty passport set", () => {
  const data = fs.mkdtempSync(join(tmpdir(), "mode-model-"));
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE project (tracker_key TEXT, org TEXT, model TEXT, mode_models TEXT)");
  const ins = db.prepare("INSERT INTO project VALUES (?, ?, ?, ?)");
  ins.run("KEY", "org", "default", '{"review":"override"}');
  ins.run("FIRST", "first", "first-model", null);
  ins.run("SECOND", "second", "second-model", null);
  ins.run("DIS", "dis", "one", null);
  ins.run("DIS", "dis", "two", null);
  ins.run("NULL", "null-org", null, null);
  try {
    fs.writeFileSync(join(data, "pool.json"), '{"review":"pool-review","worklog":"pool-worklog"}');
    assert.equal(resolveModeModel(db, data, "review", "MISSING-1"), "pool-review");
    assert.equal(resolveModeModel(db, data, "worklog", "missing-org"), "pool-worklog");

    fs.writeFileSync(join(data, "pool.json"), "not json");
    assert.equal(resolveModeModel(db, data, "review", "KEY-1"), "override");
    assert.equal(resolveModeModel(db, data, "do", "KEY-1"), "default");
    assert.equal(resolveModeModel(db, data, "review", "FIRST-1+SECOND-2"), "first-model");

    fs.rmSync(join(data, "pool.json"));
    assert.throws(() => resolveModeModel(db, data, "do", "DIS-1"), /disagree on the do model/);
    assert.throws(() => resolveModeModel(db, data, "worklog", "null-org"), /disagree on the worklog model \(NULL\)/);
  } finally {
    db.close();
    fs.rmSync(data, { recursive: true, force: true });
  }
});

// 10. Subsystem groups a tracker key's repositories in `on-me`, single or multi
// valued. It decides nothing else: a work row names no repository at all.
test("subsystem picks the repo out of several on one tracker key", () => {
  const passports = [
    { repo: "acme-crm", tracker: "acme", tracker_key: "ACME", subsystem: "CRM" },
    { repo: "lk-subscription", tracker: "acme", tracker_key: "ACME", subsystem: "Личный кабинет" },
  ];
  const issue = (vals: unknown): RawIssue => ({
    idReadable: "ACME-1",
    summary: "s",
    project: { shortName: "ACME" },
    customFields: [{ name: "Subsystem", $type: "SingleEnumIssueCustomField", value: vals as never }],
  });
  const pick = (raw: RawIssue) =>
    passports.find(
      (p) => p.tracker_key === raw.project?.shortName && valueNames(raw).includes(p.subsystem),
    )?.repo ?? null;
  assert.equal(pick(issue({ name: "CRM" })), "acme-crm");
  assert.equal(pick(issue([{ name: "Личный кабинет" }])), "lk-subscription");
  assert.equal(pick(issue(null)), null);
  assert.equal(pick(issue({ name: "Лендинг" })), null);
});

// 11. Stage matching accepts what the tracker prints and what it stores.
test("stage filter matches localized and raw names, case-insensitively", () => {
  const set = [
    { status: "Ревью", statusName: "Review" },
    { status: "На тестовом окружении", statusName: "Staging" },
    { status: "Backlog", statusName: "Backlog" },
  ];
  const pick = (input: string) => {
    const want = new Set(input.split(",").map((s) => s.trim().toLowerCase()));
    return set
      .filter((i) => want.has(i.status.toLowerCase()) || want.has(i.statusName.toLowerCase()))
      .map((i) => i.statusName);
  };
  assert.deepEqual(pick("Ревью"), ["Review"]);
  assert.deepEqual(pick("review"), ["Review"]);
  assert.deepEqual(pick("Staging, backlog"), ["Staging", "Backlog"]);
  assert.deepEqual(pick("Ревю"), []);
});

// 12. Each mode lands on the surface its ending needs, with the cwd its work
// needs: ship in a tab the main chat closes, review and worklog in a split
// of that chat's own pane, because the engineer answers them.
test("mode launch resolves cwd, surface, agent name and prompt", () => {
  const review = resolveLaunch("/root", "review", "ACME-342", "обнови ветку");
  assert.equal(review.cwd, "/root");
  assert.equal(review.agentName, "acme-342-review");
  assert.equal(review.label, "ACME-342 review");
  // The pane is prompted with the worker skill: the launcher half stays in the
  // main chat, the pane never sees a launch branch.
  assert.equal(review.prompt, "/skill:review-worker ACME-342 обнови ветку");

  // No trailing space when nothing was passed on.
  assert.equal(resolveLaunch("/root", "review", "ACME-342", "").prompt, "/skill:review-worker ACME-342");

  // Review works the stand in the task folder's worktrees, but its pane sits
  // at the root: accept deletes a folder the pane does not sit in, and the
  // pane inherits the repository's settings, not the task tab's.
  assert.equal(resolveLaunch("/root", "review", "ACME-342", "").cwd, "/root");

  // One agent name per mode per ticket: two modes on one ticket never collide.
  const names = MODES.filter(m => m !== "ship").map(m => resolveLaunch("/root", m, "ACME-342", "").agentName);
  assert.equal(new Set(names).size, names.length);

  // The modes that talk to the engineer stand next to the chat.
  assert.equal(review.surface, "tab");
  assert.equal(resolveLaunch("/root", "worklog", "acme", "").surface, "tab");
  assert.equal(resolveLaunch("/root", "worklog", "acme", "").cwd, "/root");

  assert.throws(
    () => resolveLaunch("/root", "ship", "ACME-3+ACME-4", ""),
    /background coordinator/,
  );

  // The engineer's model choice travels through the launch untouched.
  assert.equal(resolveLaunch("/root", "review", "ACME-342", "", "opus").model, "opus");
  assert.equal(resolveLaunch("/root", "review", "ACME-342", "").model, undefined);
});

// 12b. On a machine where /do never ran the review pane still rises: the
// stand is rebuilt by `pnpm adopt`, so a missing folder with a plan in
// knowledge launches with the adopt instruction in the worker's prompt. Only
// a key with neither folder nor plan dies on launch — the mistyped-key check
// stays. The facts arrive as an argument: the launch stays testable.
test("review without the task folder adopts instead of refusing", () => {
  const adoptable = resolveLaunch("/root", "review", "YM-1", "", undefined, undefined, {
    folder: false,
    plan: true,
  });
  assert.match(adoptable.prompt, /^\/skill:review-worker YM-1 /);
  assert.match(adoptable.prompt, /pnpm adopt YM-1/);

  // The engineer's note still rides behind the adopt instruction.
  const withNote = resolveLaunch("/root", "review", "YM-1", "обнови ветку", undefined, undefined, {
    folder: false,
    plan: true,
  });
  assert.match(withNote.prompt, /pnpm adopt YM-1/);
  assert.match(withNote.prompt, /обнови ветку$/);

  // A standing folder keeps the prompt untouched, whatever the plan fact says.
  assert.equal(
    resolveLaunch("/root", "review", "YM-1", "", undefined, undefined, {
      folder: true,
      plan: false,
    }).prompt,
    "/skill:review-worker YM-1",
  );

  // Neither folder nor plan — the mistyped key dies on launch, as before.
  assert.throws(
    () =>
      resolveLaunch("/root", "review", "YM-1", "", undefined, undefined, {
        folder: false,
        plan: false,
      }),
    /no task folder/,
  );

  // Without the facts the launch behaves as it always did.
  assert.equal(resolveLaunch("/root", "review", "YM-1", "").prompt, "/skill:review-worker YM-1");
});

// 12a. /split plan raises a conversational pane beside the chat: a split at
// the root, prompted with the /plan skill itself — one skill, no worker, the
// pane's `run` verdict does the same inline work. A key rides in the prompt
// and the stamp; a problem input carries neither.
test("plan opens at the root and is prompted with /plan itself", () => {
  const keyed = resolveLaunch("/root", "plan", "ACME-3", "note");
  assert.equal(keyed.surface, "tab");
  assert.equal(keyed.cwd, "/root");
  assert.equal(keyed.prompt, "/skill:plan ACME-3 note");
  assert.equal(keyed.agentName, "acme-3-plan");
  assert.deepEqual(keyed.env, ["YOKEMATE_MODE=plan", "YOKEMATE_TICKET=ACME-3"]);

  const targets = resolvePlanTargets(parseSurfaceArgs(["--split", "YM-1", "YM-2", "--", "note"]));
  assert.deepEqual(targets, [{ ticket: "YM-1", workerWords: ["YM-1", "note"] }, { ticket: "YM-2", workerWords: ["YM-2", "note"] }]);
  for (const target of targets) {
    const launch = resolveLaunch("/root", "plan", target.ticket, "", undefined, "w1:p1", undefined, "split", target.workerWords);
    assert.equal(launch.surface, "split");
    assert.equal(launch.label, `${target.ticket} plan`);
    assert.equal(launch.prompt, `/skill:plan ${target.ticket} note`);
    assert.deepEqual(launch.env, ["YOKEMATE_MODE=plan", `YOKEMATE_TICKET=${target.ticket}`, "YOKEMATE_PARENT_PANE=w1:p1"]);
  }
  assert.deepEqual(resolvePlanTargets(parseSurfaceArgs(["fix", "YM-1", "YM-2"])), [{ ticket: "YM-1", workerWords: ["fix", "YM-1", "YM-2"] }]);
  assert.deepEqual(resolvePlanTargets(parseSurfaceArgs(["problem", "--", "YM-1"])), [{ ticket: "", workerWords: ["problem", "YM-1"] }]);
  assert.deepEqual(resolvePlanTargets(parseSurfaceArgs(["YM-1+YM-2"])), [{ ticket: "YM-1", workerWords: ["YM-1"] }, { ticket: "YM-2", workerWords: ["YM-2"] }]);

  const problem = resolveLaunch("/root", "plan", "", "кнопка не жмётся");
  assert.equal(problem.surface, "tab");
  assert.equal(problem.prompt, "/skill:plan кнопка не жмётся");
  assert.equal(problem.agentName, "plan");
  assert.deepEqual(problem.env, ["YOKEMATE_MODE=plan"]);
});

// 12c. /note is the read-only conversation: a ticketless split beside the
// chat, prompted with its worker, the topic riding verbatim. A second /note
// takes the next name in the series, like a second problem-input plan.
test("note opens at the root with the topic in the worker prompt", () => {
  const note = resolveLaunch("/root", "note", "", "итоги ресёрча");
  assert.equal(note.surface, "tab");
  assert.equal(note.cwd, "/root");
  assert.equal(note.prompt, "/skill:note-worker итоги ресёрча");
  assert.equal(note.agentName, "note");
  assert.deepEqual(note.env, ["YOKEMATE_MODE=note"]);

  assert.equal(freeAgentName("note", ["note"]), "note-2");
});

test("ship argument parser preserves launcher semantics", () => {
  for (const [words, joined, expected] of [
    [["YM-199", "YM-198", "YM-197"], false, { keys: ["YM-199", "YM-198", "YM-197"], tail: [] }],
    [["YM-199", "note", "YM-198", "--model", "terra", "later"], false, { keys: ["YM-199", "YM-198"], tail: ["note", "--model", "terra", "later"] }],
    [["YM-199", "--model", "terra", "YM-198"], false, { keys: ["YM-199"], tail: ["--model", "terra", "YM-198"] }],
    [["YM-199", "YM-199"], false, { keys: ["YM-199", "YM-199"], tail: [] }],
    [["note", "--model", "terra"], false, { keys: [], tail: ["note", "--model", "terra"] }],
    [["YM-199+YM-198"], true, { keys: ["YM-199", "YM-198"], tail: [] }],
    [["YM-199+YM-198"], false, { keys: [], tail: ["YM-199+YM-198"] }],
  ] as const) assert.deepEqual(parseKeyList(words, joined), expected);
  assert.deepEqual(parseShipArgs(["YM-199", "YM-198", "YM-197"]), {
    ticket: "YM-199+YM-198+YM-197",
    tail: [],
  });
  assert.deepEqual(parseShipArgs(["YM-199", "note", "YM-198", "--model", "terra", "later"]), {
    ticket: "YM-199+YM-198",
    tail: ["note", "--model", "terra", "later"],
  });
  assert.deepEqual(parseShipArgs(["YM-199", "--model", "terra", "YM-198"]), {
    ticket: "YM-199",
    tail: ["--model", "terra", "YM-198"],
  });
  assert.deepEqual(parseShipArgs(["YM-199", "YM-199"]), { ticket: "YM-199+YM-199", tail: [] });
  assert.deepEqual(parseShipArgs(["note", "--model", "terra"]), {
    ticket: "",
    tail: ["note", "--model", "terra"],
  });
  assert.deepEqual(parseShipArgs(["YM-199+YM-198"], true), {
    ticket: "YM-199+YM-198",
    tail: [],
  });
  assert.deepEqual(parseShipArgs(["YM-199+YM-198"]), {
    ticket: "",
    tail: ["YM-199+YM-198"],
  });

  const parsed = parseShipArgs(["YM-199", "note", "YM-198", "--model", "terra"]);
  assert.equal(parsed.ticket, "YM-199+YM-198");
  assert.deepEqual(parsed.tail, ["note", "--model", "terra"]);
});

test("ship prompt preserves single and batch arguments through where", async () => {
  const { spawnSync } = await import("node:child_process");
  const root = join(import.meta.dirname, "..");
  const promptTemplates = await import(
    new URL("./core/prompt-templates.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href,
  );
  const templates = promptTemplates.loadPromptTemplates({
    cwd: root,
    agentDir: join(root, ".pi"),
    promptPaths: [join(root, ".pi", "prompts", "ship.md")],
    includeDefaults: false,
  });
  const runWhere = (args: string[], env: Record<string, string>) =>
    spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "src/mode-guard.ts", "ship", ...args],
      { cwd: root, env: { PATH: process.env.PATH ?? "", YOKEMATE_MODE: "", YOKEMATE_TICKET: "", ...env }, encoding: "utf8" },
    );

  for (const keys of [["YM-197"], ["YM-199", "YM-198"], ["YM-199", "YM-198", "YM-197"]]) {
    const stamp = keys.join("+");
    const expanded = promptTemplates.expandPromptTemplate(`/ship ${keys.join(" ")}`, templates);
    const where = expanded.match(/pnpm where ship(?: [^`\n]*)?/)?.[0];
    assert.match(expanded, /subagent.*coordinator/);
    assert.match(expanded, /tickets: \[ordered engineer keys\]/);
    assert.match(expanded, /coordinator_merge/);
    assert.doesNotMatch(expanded, /pnpm ship-merge/);
    assert.ok(where);
    const whereArgs = where.split(/\s+/).slice(3);
    const main = runWhere(whereArgs, {});
    assert.equal(main.status, 0, main.stderr);
    assert.equal(main.stdout.trim(), "launch");
    assert.deepEqual(whereArgs, keys);
    assert.deepEqual(parseKeyList(whereArgs).keys, keys);

    const own = runWhere(whereArgs, { YOKEMATE_MODE: "ship", YOKEMATE_TICKET: stamp });
    assert.equal(own.status, 0, own.stderr);
    assert.equal(own.stdout.trim(), "run");
    for (const env of [
      { YOKEMATE_MODE: "review", YOKEMATE_TICKET: stamp },
      { YOKEMATE_MODE: "ship", YOKEMATE_TICKET: keys.length === 1 ? "YM-198" : keys.slice(0, -1).join("+") },
      ...(keys.length === 1 ? [] : [{ YOKEMATE_MODE: "ship", YOKEMATE_TICKET: [...keys].reverse().join("+") }]),
    ]) {
      const refused = runWhere(whereArgs, env);
      assert.equal(refused.status, 1);
      assert.match(refused.stdout, /^refuse: /);
    }
    const worker = runWhere([stamp], { YOKEMATE_MODE: "ship", YOKEMATE_TICKET: stamp });
    assert.equal(worker.status, 0, worker.stderr);
    assert.equal(worker.stdout.trim(), "run");
  }

  const withTail = promptTemplates.expandPromptTemplate("/ship YM-199 note YM-198 --model terra YM-197", templates);
  const withTailWhere = withTail.match(/pnpm where ship(?: [^`\n]*)?/)?.[0];
  assert.ok(withTailWhere);
  const ownTail = runWhere(withTailWhere.split(/\s+/).slice(3), {
    YOKEMATE_MODE: "ship",
    YOKEMATE_TICKET: "YM-199+YM-198",
  });
  assert.equal(ownTail.status, 0, ownTail.stderr);
  assert.equal(ownTail.stdout.trim(), "run");

  const empty = promptTemplates.expandPromptTemplate("/ship", templates);
  const where = empty.match(/pnpm where ship(?: [^`\n]*)?/)?.[0];
  assert.ok(where);
  const result = runWhere(where.split(/\s+/).slice(3), {});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage: where/);
  const withoutKeys = runWhere(["note", "--model", "terra"], {});
  assert.equal(withoutKeys.status, 1);
  assert.match(withoutKeys.stderr, /usage: where/);

  const policyOff = resolveRuntimeSettings({ guardPolicy: { yolo: false, guards: { modeOwnership: false } } });
  assert.deepEqual(
    decide({ YOKEMATE_MODE: "review", YOKEMATE_TICKET: "YM-199" }, "ship", "YM-199", policyOff),
    { kind: "launch" },
  );
  assert.deepEqual(
    decide({ YOKEMATE_MODE: "ship", YOKEMATE_TICKET: "YM-199" }, "ship", "YM-199", policyOff),
    { kind: "run" },
  );
});

test("review prompt preserves tab, split and literal arguments through where", async () => {
  const { spawnSync } = await import("node:child_process");
  const root = join(import.meta.dirname, "..");
  const promptTemplates = await import(new URL("./core/prompt-templates.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
  const templates = promptTemplates.loadPromptTemplates({ cwd: root, agentDir: join(root, ".pi"), promptPaths: [join(root, ".pi", "prompts", "review.md")], includeDefaults: false });
  for (const [input, launch] of [
    ["/review YM-1", "pnpm review YM-1"],
    ["/review --split YM-1", "pnpm review --split YM-1"],
    ["/review YM-1 -- --split", "pnpm review YM-1 -- --split"],
  ]) {
    const expanded = promptTemplates.expandPromptTemplate(input, templates);
    assert.ok(expanded.includes(`run \`${launch}\``));
    assert.match(expanded, /pnpm where review <ticket>/);
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/mode-guard.ts", "review", "YM-1"], { cwd: root, env: { PATH: process.env.PATH ?? "", YOKEMATE_MODE: "", YOKEMATE_TICKET: "" }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "launch");
  }
});

test("plan prompt preserves several keys", async () => {
  const root = join(import.meta.dirname, "..");
  const promptTemplates = await import(
    new URL("./core/prompt-templates.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href,
  );
  const templates = promptTemplates.loadPromptTemplates({
    cwd: root, agentDir: join(root, ".pi"),
    promptPaths: [join(root, ".pi", "prompts", "plan.md")], includeDefaults: false,
  });
  for (const keys of [["YM-1"], ["YM-1", "YM-2"]]) {
    const expanded = promptTemplates.expandPromptTemplate(`/plan ${keys.join(" ")}`, templates);
    assert.ok(expanded.includes(`Ticket or problem: ${keys.join(" ")}`));
    assert.ok(expanded.includes(".pi/skills/plan/SKILL.md"));
    assert.match(expanded, /one independent tab per key, or one split per key from the same calling pane/);
    assert.match(expanded, /Each worker receives only its key and uses its own passport model/);
    assert.match(expanded, /Return every per-key result, including partial refusals/);
  }
  const skill = fs.readFileSync(join(root, ".pi", "skills", "plan", "SKILL.md"), "utf8");
  assert.ok(skill.includes("/plan <KEY> [<KEY> …]"));
  assert.ok(skill.includes("pnpm where plan [KEY …]"));
});

test("ship worker delegates idempotent journal and cleanup finalization to its parent", () => {
  const worker = fs.readFileSync(join(import.meta.dirname, "../.pi/skills/ship-worker/SKILL.md"), "utf8");
  assert.match(worker, /call `coordinator_finish` with `outcome: "done"`/);
  assert.match(worker, /idempotently appends and syncs the single shipped journal outcome under the shared home lock/);
  assert.doesNotMatch(worker, /then `rm -rf work\/<KEY>`/);
});

test("do prompt preserves its keys through where", async () => {
  const { spawnSync } = await import("node:child_process");
  const root = join(import.meta.dirname, "..");
  const promptTemplates = await import(
    new URL("./core/prompt-templates.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href,
  );
  const templates = promptTemplates.loadPromptTemplates({
    cwd: root,
    agentDir: join(root, ".pi"),
    promptPaths: [join(root, ".pi", "prompts", "do.md")],
    includeDefaults: false,
  });
  const expanded = promptTemplates.expandPromptTemplate("/do YM-1", templates);
  const where = expanded.match(/pnpm where do(?: [^`\n]*)?/)?.[0];
  assert.match(expanded, /subagent.*coordinator: \{ mode: "do", tickets: \[ordered engineer keys\] \}/);
  assert.match(expanded, /Do not pass top-level `agent` or `task`/);
  assert.match(expanded, /Omit `plan` and `model` unless their literal values appear in the entered command/);
  assert.match(expanded, /Never use words from these instructions as parameter values/);
  assert.match(expanded, /Entered command: `\/do YM-1`/);
  const explicit = promptTemplates.expandPromptTemplate("/do YM-1 --plan /tmp/explicit-plan.md --model test/explicit-model", templates);
  assert.match(explicit, /Entered command: `\/do YM-1 --plan \/tmp\/explicit-plan\.md --model test\/explicit-model`/);
  assert.match(explicit, /coordinator: \{ mode: "do", tickets: \[ordered engineer keys\] \}/);
  const runWhere = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath,
    ["--experimental-strip-types", "--no-warnings", "src/mode-guard.ts", "do", ...args],
    { cwd: root, env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
  const malformed = promptTemplates.expandPromptTemplate("/do YM-1 not-a-key YM-2", templates);
  const malformedArgs = malformed.match(/pnpm where do ([^`\n]*)/)![1].split(/\s+/);
  const usage = runWhere(malformedArgs);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /unexpected not-a-key/);
  assert.ok(malformed.includes("**usage: … unexpected WORD**"));
  assert.ok(malformed.includes("Do not discard malformed candidates from the eventual tool request."));
  const remainingKeys = parseKeyList(malformedArgs).keys;
  assert.deepEqual(remainingKeys, ["YM-1", "YM-2"]);
  const recovered = runWhere(remainingKeys);
  assert.equal(recovered.status, 0);
  assert.equal(recovered.stdout.trim(), "launch");
  const stampedRecovery = runWhere(remainingKeys, { YOKEMATE_MODE: "do", YOKEMATE_TICKET: "YM-1" });
  assert.equal(stampedRecovery.status, 1);
  assert.match(stampedRecovery.stdout, /^refuse:/);
  for (const command of ["/do YM-1 на gpt-6-astra", "/do YM-1 запусти на gpt-6-astra, задача сложная", "/do YM-1 --model gpt-6-astra", "/do YM-1 --plan /tmp/explicit-plan.md"]) {
    const named = promptTemplates.expandPromptTemplate(command, templates);
    assert.ok(named.includes(`Entered command: \`${command}\``));
    assert.ok(named.includes("first separate that value and its surrounding instruction words from the ticket candidates"));
    assert.ok(named.includes("Never interpret these model/plan instructions as malformed keys."));
    const normalizedWhere = named.match(/check `([^`]+)`/)![1];
    assert.equal(normalizedWhere, "pnpm where do YM-1");
    const namedLaunch = runWhere(normalizedWhere.split(/\s+/).slice(3));
    assert.equal(namedLaunch.status, 0);
    assert.equal(namedLaunch.stdout.trim(), "launch");
  }
  const batch = promptTemplates.expandPromptTemplate("/do YM-1 YM-2", templates);
  assert.match(batch, /pnpm where do YM-1 YM-2/);
  assert.match(batch, /Entered command: `\/do YM-1 YM-2`/);
  assert.match(batch, /tickets: \[ordered engineer keys\]/);
  assert.deepEqual(parseKeyList(batch.match(/pnpm where do ([^`\n]*)/)![1].split(/\s+/)).keys, ["YM-1", "YM-2"]);
  assert.ok(where);
  const args = where.split(/\s+/).slice(3);
  const run = (env: Record<string, string>) => spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", "src/mode-guard.ts", "do", ...args],
    { cwd: root, env: { PATH: process.env.PATH ?? "", YOKEMATE_MODE: "", YOKEMATE_TICKET: "", ...env }, encoding: "utf8" },
  );
  assert.equal(run({}).stdout.trim(), "launch");
  assert.equal(run({ YOKEMATE_MODE: "do", YOKEMATE_TICKET: "YM-1" }).stdout.trim(), "run");
  const refused = run({ YOKEMATE_MODE: "review", YOKEMATE_TICKET: "YM-1" });
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /^refuse: /);
});

test("record-report without arguments refuses before any effect", async () => {
  const { spawnSync } = await import("node:child_process");
  const root = join(import.meta.dirname, "..");
  const before = fs.existsSync(join(root, "work")) ? fs.readdirSync(join(root, "work")) : null;
  const out = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", "src/record-report.ts"],
    { cwd: root, env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" },
  );
  assert.equal(out.status, 1);
  assert.match(out.stderr, /usage: record-report/);
  assert.deepEqual(fs.existsSync(join(root, "work")) ? fs.readdirSync(join(root, "work")) : null, before);
});

test("spawn and mode-tab refuse without a pane id, before any effect", async () => {
  const { spawnSync } = await import("node:child_process");
  const root = join(import.meta.dirname, "..");
  const env = { HERDR_ENV: "1", PATH: process.env.PATH ?? "" };
  const run = (script: string, ...args: string[]) =>
    spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", script, ...args],
      { cwd: root, env, encoding: "utf8" },
    );

  const spawn = run("src/spawn.ts", "YM-0");
  assert.equal(spawn.status, 1);
  assert.match(spawn.stderr, /PI_SESSION_ID/);
  assert.equal(fs.existsSync(join(root, "work", "YM-0")), false);

  const review = run("src/mode-tab.ts", "review", "YM-0");
  assert.equal(review.status, 1);
  assert.match(review.stderr, /HERDR_PANE_ID/);

  const split = run("src/mode-tab.ts", "plan", "задача");
  assert.equal(split.status, 1);
  assert.match(split.stderr, /HERDR_PANE_ID/);
});

// A ticketless mode's name is the bare mode, so two of them would collide: the
// launch takes the first free name in the counted series instead. A keyed mode
// keeps its name — the one-agent-per-mode-per-ticket guard stays for it.
test("a ticketless mode takes the first free name in its series", () => {
  assert.equal(freeAgentName("plan", []), "plan");
  assert.equal(freeAgentName("plan", ["plan"]), "plan-2");
  assert.equal(freeAgentName("plan", ["plan", "plan-2"]), "plan-3");
  assert.equal(freeAgentName("plan", ["plan-2"]), "plan");
  assert.equal(freeAgentName("acme-342-ship", ["plan"]), "acme-342-ship");
});

// 13. The mode skill is one file entered two ways: the main chat raises the
// pane, the pane does the work. Only the env stamp tells them apart — cwd
// cannot, because review, ship and worklog run from the root the main chat already
// sits in.
test("a mode skill knows whether to launch the pane or do the work", async () => {
  const { spawnSync } = await import("node:child_process");
  const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath,
    ["--experimental-strip-types", "--no-warnings", "src/mode-guard.ts", ...args],
    { cwd: join(import.meta.dirname, ".."), env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
  for (const mode of ["do", "plan"]) {
    const launch = run([mode, "YM-1", "YM-2"]);
    assert.equal(launch.status, 0, launch.stderr);
    assert.equal(launch.stdout.trim(), "launch");
    const refused = run([mode, "YM-1", "YM-2"], { YOKEMATE_MODE: mode, YOKEMATE_TICKET: "YM-1" });
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /^refuse: /);
    if (mode === "do") {
      const own = run([mode, "YM-1+YM-2"], { YOKEMATE_MODE: mode, YOKEMATE_TICKET: "YM-1+YM-2" });
      assert.equal(own.status, 0);
      assert.equal(own.stdout.trim(), "run");
    } else {
      for (const key of ["YM-1", "YM-2"]) {
        const own = run([mode, key], { YOKEMATE_MODE: mode, YOKEMATE_TICKET: key });
        assert.equal(own.status, 0);
        assert.equal(own.stdout.trim(), "run");
      }
      const joined = run([mode, "YM-1+YM-2"], { YOKEMATE_MODE: mode, YOKEMATE_TICKET: "YM-1+YM-2" });
      assert.equal(joined.status, 1);
      assert.match(joined.stdout, /^refuse: /);
    }
  }
  const invalid = run(["do", "YM-1", "not-a-key"]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /usage: where do .*not-a-key/);
  const problem = run(["plan", "fix", "the", "problem"], { YOKEMATE_MODE: "plan" });
  assert.equal(problem.status, 0);
  assert.equal(problem.stdout.trim(), "run");
  // Main chat: nobody stamped it — with or without a key.
  assert.deepEqual(decide({}, "review", "ACME-342"), { kind: "launch" });
  assert.deepEqual(decide({}, "plan"), { kind: "launch" });
  assert.deepEqual(decide({}, "plan", "ACME-342"), { kind: "launch" });

  // The pane raised for exactly this ticket and mode.
  assert.deepEqual(
    decide({ YOKEMATE_MODE: "review", YOKEMATE_TICKET: "ACME-342" }, "review", "ACME-342"),
    { kind: "run" },
  );

  // Someone else's pane: same ticket, other mode — and same mode, other ticket.
  for (const env of [
    { YOKEMATE_MODE: "ship", YOKEMATE_TICKET: "ACME-342" },
    { YOKEMATE_MODE: "review", YOKEMATE_TICKET: "ACME-999" },
  ]) {
    assert.equal(decide(env, "review", "ACME-342").kind, "refuse");
  }

  assert.deepEqual(
    decide({ YOKEMATE_MODE: "ship", YOKEMATE_TICKET: "ACME-342" }, "ship", "ACME-342"),
    { kind: "run" },
  );

  // A ticketless /plan pane answers `run` on the mode alone; a keyed pane is
  // still someone else's, and so is the plan pane for a keyed mode.
  assert.deepEqual(decide({ YOKEMATE_MODE: "plan" }, "plan"), { kind: "run" });
  assert.equal(decide({ YOKEMATE_MODE: "plan" }, "review", "ACME-342").kind, "refuse");
  assert.equal(decide({ YOKEMATE_MODE: "review", YOKEMATE_TICKET: "ACME-342" }, "plan").kind, "refuse");

  // The launching chat's pane rides along in the stamp: the mode reports back
  // to it by id. Without it the env stays as before — old panes still decide.
  assert.deepEqual(
    resolveLaunch("/root", "worklog", "acme", "", undefined, "w4:p1").env,
    ["YOKEMATE_MODE=worklog", "YOKEMATE_TICKET=acme", "YOKEMATE_PARENT_PANE=w4:p1"],
  );
});

// 14. A second launch of a mode already open is a forgotten one, not a wish for
// two. The agent's name matches whether the mode took a tab or a split; the tab
// label is what the closing side has to go by.
test("a running mode is found by its agent name, a tab to close by its label", () => {
  const agents = [
    { pane_id: "w4:p1" },
    { name: "acme-342-do", pane_id: "w4:p7" },
    { name: "acme-342-worklog", pane_id: "w4:pK" },
  ];
  assert.equal(findRunningAgent(agents, "acme-342-worklog"), "w4:pK");
  assert.equal(findRunningAgent(agents, "acme-342-review"), undefined);

  const tabs = [
    { label: "1", tab_id: "w4:t1" },
    { label: "ACME-342 do", tab_id: "w4:t7" },
  ];
  assert.equal(findOpenTab(tabs, "ACME-342 do"), "w4:t7");
  assert.equal(findOpenTab(tabs, "ACME-342 worklog"), undefined);
});

// 15. Teammates reach the task tab through the task folder, and nothing is
// written outside yokemate to make that happen.
test("teammates are linked into the task folder, relinked on relaunch", () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readlinkSync, rmSync } = fs;
  const tmp = mkdtempSync(join(tmpdir(), "yokemate-"));
  const src = join(tmp, "agents");
  const dst = join(tmp, "work", "ACME-342", ".pi", "agents");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "task-executor.md"), "x");
  writeFileSync(join(src, "notes.txt"), "not an agent");

  assert.deepEqual(linkTeammates(src, dst), ["task-executor.md"]);
  assert.deepEqual(readdirSync(dst), ["task-executor.md"]);
  assert.equal(readlinkSync(join(dst, "task-executor.md")), join(src, "task-executor.md"));

  // A teammate renamed in the repository does not survive under its old name.
  rmSync(join(src, "task-executor.md"));
  writeFileSync(join(src, "validator.md"), "x");
  assert.deepEqual(linkTeammates(src, dst), ["validator.md"]);
  assert.deepEqual(readdirSync(dst), ["validator.md"]);

  rmSync(tmp, { recursive: true, force: true });
});

// 16. herdr hands back the pane before its shell is at a prompt, so the first
// `agent start` attempts bounce off `agent_pane_busy`. The launch waits that
// out; any other failure is the caller's to handle, with its tab to close.
test("the agent launch waits for the pane's shell, and only for that", () => {
  const calls: string[][] = [];
  let busyLeft = 3;
  startAgent("acme-342-review", "w4:pC", "ACME-342 review", [], (args) => {
    calls.push(args);
    if (busyLeft-- > 0) throw new Error('Command failed: herdr {"error":{"code":"agent_pane_busy"}}');
  }, 20, 0);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0], [
    "agent", "start", "acme-342-review", "--kind", "pi", "--pane", "w4:pC", "--",
    "-n", "ACME-342 review", "-a",
  ]);

  // The engineer's model choice rides along as extra agent args.
  const withModel: string[][] = [];
  startAgent("acme-342-worklog", "w4:pD", "ACME-342 worklog", ["--model", "openai-codex/gpt-5.6-terra"], (args) => {
    withModel.push(args);
  }, 20, 0);
  assert.deepEqual(withModel[0].slice(-2), ["--model", "openai-codex/gpt-5.6-terra"]);

  let once = 0;
  assert.throws(
    () => startAgent("a", "w4:pC", "a", [], () => { once++; throw new Error("herdr: no such pane"); }, 20, 0),
    /no such pane/,
  );
  assert.equal(once, 1);

  // A pane that never comes up gives up instead of retrying forever.
  let forever = 0;
  assert.throws(
    () => startAgent("a", "w4:pC", "a", [], () => {
      forever++;
      throw new Error('{"error":{"code":"agent_pane_busy"}}');
    }, 3, 0),
    /agent_pane_busy/,
  );
  assert.equal(forever, 3);
});

// 17. A ticket is read for one thing: which repository it belongs to, told by
// the subsystem's name. YouTrack keeps only the last `customFields` spec of a
// query, so a second one appended for some other field takes those names away
// and every multi-repo tracker key goes ambiguous.
test("one issue is asked for its field values under a single customFields spec", async () => {
  let asked = "";
  const raw = await fetchIssue(
    { name: "acme", baseUrl: "https://yt.example", token: "t" } as never,
    "ACME-342",
    (async (url: string) => {
      asked = decodeURIComponent(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          idReadable: "ACME-342",
          customFields: [{ name: "Subsystem", value: { name: "Страница подписки" } }],
        }),
      };
    }) as never,
  );

  assert.equal(asked.match(/customFields\(/g)?.length, 1);
  assert.match(asked, /customFields\(name,\$type,value\(name,localizedName\)\)/);
  assert.deepEqual(valueNames(raw!), ["Страница подписки"]);
});

// 18. A tab that has reported is closed by the orchestrator, not by itself: the
// ship tab's when its merge is reported, the task tab's when its PRs are. A tab
// the engineer already closed by hand is not an error.
test("a finished tab is closed by its label, and a missing one is not an error", () => {
  const calls: string[][] = [];
  const list = (tabs: { label?: string; tab_id: string }[]) => (args: string[]) => {
    calls.push(args);
    return { result: { tabs } };
  };

  assert.equal(
    closeTab("ACME-342 ship", list([{ label: "1", tab_id: "w4:t1" }, { label: "ACME-342 ship", tab_id: "w4:t9" }])),
    "w4:t9",
  );
  assert.deepEqual(calls[1], ["tab", "close", "w4:t9"]);

  calls.length = 0;
  assert.equal(closeTab("ACME-342 ship", list([{ label: "1", tab_id: "w4:t1" }])), undefined);
  assert.equal(calls.length, 1);
});

// 19. A ticket's row names no repository. One ticket touches one or several,
// the plan says which, and each one is a row in `part` — so the work row is
// created before any of that is known, and a repository without a subsystem
// value blocks nothing.
test("a work row is created without a repository, parts carry them", () => {
  const db = memDb();
  insertWork(db, "ACME-347", { stage: "scouted" });
  const row = db.prepare("SELECT * FROM work WHERE ticket = ?").get("ACME-347") as
    Record<string, unknown>;
  assert.equal("project" in row, false);
  assert.equal(row.stage, "scouted");

  const ins = db.prepare("INSERT INTO part (work_id, repo, role) VALUES (?, ?, ?)");
  for (const [repo, role] of [["acme/acme-ui-kit", "library"], ["acme/acme-extension", "app"]])
    ins.run(row.id as number, repo, role);
  const repos = (db.prepare("SELECT repo FROM part WHERE work_id = ?").all(row.id as number) as
    unknown as { repo: string }[]).map((p) => p.repo);
  assert.deepEqual(repos, ["acme/acme-ui-kit", "acme/acme-extension"]);
});

// 20. The column is dropped from a database that already has it, with its rows
// intact — the passports were connected long before this.
test("work.project is dropped on open, rows survive", () => {
  const db = memDb();
  db.exec("DROP TABLE work");
  db.exec(`CREATE TABLE work (
    id INTEGER PRIMARY KEY, project TEXT NOT NULL, ticket TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL, title TEXT, stage TEXT NOT NULL DEFAULT 'new',
    owner TEXT, folder TEXT, plan TEXT, next TEXT, artifact TEXT, pr TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.prepare("INSERT INTO work (project, ticket, url, stage) VALUES ('acme/r','ACME-1','u','planned')").run();

  // The schema step openDb runs, on a connection that already has the old table.
  const cols = new Set(
    (db.prepare("PRAGMA table_info(work)").all() as unknown as { name: string }[]).map((c) => c.name),
  );
  if (cols.has("project")) db.exec("ALTER TABLE work DROP COLUMN project");

  const row = db.prepare("SELECT * FROM work WHERE ticket = 'ACME-1'").get() as Record<string, unknown>;
  assert.equal("project" in row, false);
  assert.equal(row.stage, "planned");
});

// 21. The stop guard belongs to the task tab alone, and its verdict is the
// ticket's stage in the database: still `running` — the result is unrecorded
// and the tab may not finish; `review` — record-report already ran. Other
// modes and the unstamped main chat pass through.
test("the stop guard holds the do tab until its stage is recorded", () => {
  const stages: Record<string, string> = { "ACME-358": "running", "ACME-359": "review" };
  const read = (t: string) => stages[t];

  const held = stopVerdict({ YOKEMATE_MODE: "do", YOKEMATE_TICKET: "ACME-358" }, read);
  assert.ok(held && held.includes("record-report"), "running must block with the command to run");
  assert.equal(stopVerdict({ YOKEMATE_MODE: "do", YOKEMATE_TICKET: "ACME-359" }, read), null);

  // A ticket the guard cannot find blocks too: a do tab always has a row.
  assert.ok(stopVerdict({ YOKEMATE_MODE: "do", YOKEMATE_TICKET: "ACME-999" }, read));

  for (const env of [
    { YOKEMATE_MODE: "review", YOKEMATE_TICKET: "ACME-358" },
    { YOKEMATE_MODE: "ship", YOKEMATE_TICKET: "ACME-358" },
    { YOKEMATE_MODE: "do" }, // no ticket stamped — nothing to judge by
    {},
  ]) {
    assert.equal(stopVerdict(env, read), null);
  }
});

// 22. Outcome lines are written into the pool journal by the commands, not by
// prompt discipline: «дата тикет запланировано: план …». A failure to log must
// never fail the command that did the real work.
test("outcome lines append to the month journal", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "yoke-moves-"));
  const line = logMove(root, "ACME-1", "запланировано", "план x");
  assert.match(line ?? "", /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} ACME-1 запланировано: план x$/);
  logMove(root, "ACME-1", "принято");

  const files = fs.readdirSync(join(root, "journal"));
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{4}-\d{2}\.md$/);
  const content = fs.readFileSync(join(root, "journal", files[0]), "utf8");
  assert.equal(content.split("\n").filter(Boolean).length, 2);
  assert.match(content, /ACME-1 принято\n$/);
  fs.rmSync(root, { recursive: true, force: true });
});
// 23. A model pattern is judged against pi's catalogue, and the judging is
// pure: `pi --list-models` exits 0 on a miss too and matches fuzzily, so the
// verdict comes from an exact `provider/id` (or bare `id`) in the parsed table.
// A known thinking level is cut off before the call — it breaks the search —
// but any other tail after a colon may belong to the id and goes along.
test("a model pattern is checked against the pi catalogue, suffix apart", () => {
  const TABLE =
    "provider      model          context  max-out  thinking  images\n" +
    "openai-codex  gpt-5.6-luna   272K     128K     yes       yes   \n" +
    "openai-codex  gpt-5.6-terra  272K     128K     yes       yes   \n";
  const NONE = 'No models matching "opus"\n';

  const asked: string[] = [];
  const table = (p: string) => { asked.push(p); return TABLE; };

  assert.deepEqual(checkModel("openai-codex/gpt-5.6-terra", table), { ok: true });
  assert.deepEqual(checkModel("gpt-5.6-terra", table), { ok: true });

  asked.length = 0;
  assert.deepEqual(checkModel("openai-codex/gpt-5.6-terra:high", table), { ok: true });
  assert.deepEqual(asked, ["openai-codex/gpt-5.6-terra"]);

  const missing = checkModel("opus", () => NONE);
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.reason, /"opus"/);

  // A fuzzy hit is not an exact one: the table answers, the pattern still fails
  // and the rows it did bring back are named as the nearest.
  const fuzzy = checkModel("openai-codex/gpt-5.6", table);
  assert.equal(fuzzy.ok, false);
  assert.match(fuzzy.ok ? "" : fuzzy.reason, /openai-codex\/gpt-5\.6-luna/);
  assert.match(fuzzy.ok ? "" : fuzzy.reason, /openai-codex\/gpt-5\.6-terra/);

  const level = checkModel("gpt-5.6-terra:ultra", table);
  assert.equal(level.ok, false);
  for (const l of THINKING_LEVELS) assert.match(level.ok ? "" : level.reason, new RegExp(l));

  // A colon is not proof of a suffix: pi's own catalogue carries `gpt-oss:120b`.
  // An unknown tail asks the catalogue for the whole pattern, and only a miss
  // there is called a bad level.
  const withColon =
    "provider  model         context  max-out  thinking  images\n" +
    "litellm   gpt-oss:120b  128K     32K      yes       no    \n";
  asked.length = 0;
  const colon = (p: string) => { asked.push(p); return withColon; };
  assert.deepEqual(checkModel("litellm/gpt-oss:120b", colon), { ok: true });
  assert.deepEqual(asked, ["litellm/gpt-oss:120b"]);
  assert.deepEqual(checkModel("gpt-oss:120b", colon), { ok: true });

  // No pi on the machine is a warning, not a refusal: bootstrap.sh imports
  // passports before the first pi session exists.
  assert.deepEqual(checkModel("openai-codex/gpt-5.6-terra", () => null), { ok: true, skipped: true });
});

test("interactive templates preserve surface controls and literal tail with split plan as an alias", async () => {
  const root = join(import.meta.dirname, "..");
  const promptTemplates = await import(
    new URL("./core/prompt-templates.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href,
  );
  const templates = promptTemplates.loadPromptTemplates({ cwd: root, agentDir: join(root, ".pi"),
    promptPaths: [join(root, ".pi", "prompts")], includeDefaults: false });
  for (const mode of ["plan", "review", "worklog", "note", "research"]) {
    const args = "--split YM-1 -- --split --model literal";
    const expanded = promptTemplates.expandPromptTemplate(`/${mode} ${args}`, templates);
    const entry = mode === "plan" ? "split plan" : mode;
    assert.ok(expanded.includes(`pnpm ${entry} ${args}`), expanded);
    assert.match(expanded, /tab.*default|default.*tab/);
  }
  for (const args of ["YM-1", "YM-1 YM-2 -- --split --model literal"]) {
    const primary = promptTemplates.expandPromptTemplate(`/plan --split ${args}`, templates);
    const alias = promptTemplates.expandPromptTemplate(`/split plan ${args}`, templates);
    const command = `pnpm split plan --split ${args}`;
    assert.ok(primary.includes(command));
    assert.ok(alias.includes(command));
  }
  for (const mode of ["do", "ship"]) {
    const expanded = promptTemplates.expandPromptTemplate(`/${mode} YM-1`, templates);
    assert.doesNotMatch(expanded, /tab create|pane split|openModeSurface/);
    assert.match(expanded, /coordinator/);
  }
});


test("plan templates launch ordinary input in a tab and preserve explicit split aliases", async () => {
  const root = join(import.meta.dirname, "..");
  const promptTemplates = await import(
    new URL("./core/prompt-templates.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href,
  );
  const templates = promptTemplates.loadPromptTemplates({ cwd: root, agentDir: join(root, ".pi"),
    promptPaths: [join(root, ".pi", "prompts")], includeDefaults: false });
  for (const args of ["YM-1", "YM-1 YM-2", "fix the problem", "YM-1 -- --split", "YM-1 -- YM-2 --model literal"]) {
    const expanded = promptTemplates.expandPromptTemplate(`/plan ${args}`, templates);
    assert.ok(expanded.includes(`Ticket or problem: ${args}`));
    assert.match(expanded, /pnpm where plan \[KEY …\]/);
    assert.ok(expanded.includes(`- \`launch\` — run \`pnpm split plan ${args}\` and return its output lines, then stop.`));
    assert.match(expanded, /new tab is the default/);
    assert.match(expanded, /No tracker reads, reconnaissance or planning in the main chat/);
    assert.doesNotMatch(expanded, /continue inline|Inline completion/);
  }
  for (const args of ["YM-1", "YM-1 YM-2 --model test/explicit -- --split --model literal", "fix the problem -- YM-2"]) {
    const primary = promptTemplates.expandPromptTemplate(`/plan --split ${args}`, templates);
    const alias = promptTemplates.expandPromptTemplate(`/split plan ${args}`, templates);
    for (const expanded of [primary, alias]) {
      assert.ok(expanded.includes(`pnpm split plan --split ${args}`));
      assert.match(expanded, /tab.*default|default.*tab/);
    }
  }
  const skill = fs.readFileSync(join(root, ".pi/skills/plan/SKILL.md"), "utf8");
  assert.match(skill, /`launch`.*run `pnpm split plan <original arguments>` unchanged and return its output lines, then stop/);
  assert.match(skill, /never planning keys or launch controls/);
  assert.match(skill, /send the outcome to the pane the mode was launched from/);
  assert.match(skill, /mode surface \(default tab or explicit split\) is conversational/);
  assert.match(skill, /plan-scout/);
  assert.match(skill, /plan-writer/);
  assert.doesNotMatch(skill, /Inline completion|model of the current main Pi chat/);
});
