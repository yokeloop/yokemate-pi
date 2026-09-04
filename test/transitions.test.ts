// Contract tests of the stage machine: the checks that replaced the «one
// writer» rule. Pure decisions through checkMove, the atomic write through
// applyMove on an in-memory database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { applyMove, checkMove, type From, type Via } from "../src/transitions.ts";

function memDb() {
  return openDb(":memory:");
}

function insertWork(db: ReturnType<typeof memDb>, ticket: string, stage: string) {
  db.prepare("INSERT INTO work (ticket, url, title, stage) VALUES (?, ?, 't', ?)").run(
    ticket,
    `https://t/${ticket}`,
    stage,
  );
}

const ALL: From[] = ["absent", "new", "scouted", "planned", "running", "review", "accepted"];

// 1. The full matrix: every legal source passes, every other source refuses —
// for the stamped mode and for the unstamped main chat alike.
test("the transition table admits exactly its sources", () => {
  const cases: { via: Via; mode?: string; from: From[] }[] = [
    { via: "plan", mode: "plan", from: ["absent", "new", "scouted", "planned"] },
    { via: "record-report", mode: "do", from: ["running", "review"] },
    { via: "accept", mode: "review", from: ["review", "accepted"] },
    { via: "accept-rework", mode: "review", from: ["review", "planned"] },
    { via: "adopt", mode: "review", from: ["absent", "review"] },
    { via: "stage", from: ["absent", "new", "scouted", "planned"] },
    { via: "plan", from: ["absent", "new", "scouted", "planned"] },
    { via: "spawn", from: ["planned", "running"] },
    { via: "record-report", from: ["running", "review"] },
    { via: "adopt", from: ["absent", "review"] },
    { via: "accept", from: ["review", "accepted"] },
    { via: "accept-rework", from: ["review", "planned"] },
  ];
  for (const c of cases) {
    const env = c.mode ? { YOKEMATE_MODE: c.mode, YOKEMATE_TICKET: "ACME-1" } : {};
    for (const from of ALL) {
      const v = checkMove(c.via, env, "ACME-1", from);
      assert.equal(
        v.ok,
        c.from.includes(from),
        `${c.via} as ${c.mode ?? "main chat"} from ${from}: expected ${c.from.includes(from)}`,
      );
    }
  }
});

// 2. Identity: a stamped pane moves only its own ticket with its own command.
test("a stamped pane cannot move a foreign ticket or make a foreign move", () => {
  // record-report is not plan's move, whatever the stage.
  const foreignMove = checkMove(
    "record-report",
    { YOKEMATE_MODE: "plan", YOKEMATE_TICKET: "ACME-1" },
    "ACME-1",
    "running",
  );
  assert.equal(foreignMove.ok, false);

  // do's own move, but a neighbor's ticket.
  const foreignTicket = checkMove(
    "record-report",
    { YOKEMATE_MODE: "do", YOKEMATE_TICKET: "ACME-1" },
    "ACME-2",
    "running",
  );
  assert.equal(foreignTicket.ok, false);

  // stage has no seats: recording `scouted` belongs to the main chat alone.
  assert.equal(
    checkMove("stage", { YOKEMATE_MODE: "plan", YOKEMATE_TICKET: "ACME-1" }, "ACME-1", "new").ok,
    false,
  );

  // spawn belongs to the main chat alone.
  assert.equal(
    checkMove("spawn", { YOKEMATE_MODE: "do", YOKEMATE_TICKET: "ACME-1" }, "ACME-1", "planned").ok,
    false,
  );
});

// 3. Compare-and-set: a stale pane overwrites nothing, and a refused move
// writes nothing.
test("a stale move is refused and leaves the row untouched", () => {
  const db = memDb();
  insertWork(db, "ACME-1", "planned");
  // The ticket moved on to running while a plan pane lingered.
  db.prepare("UPDATE work SET stage = 'running' WHERE ticket = 'ACME-1'").run();

  let wrote = false;
  const out = applyMove(
    db,
    "plan",
    { YOKEMATE_MODE: "plan", YOKEMATE_TICKET: "ACME-1" },
    "ACME-1",
    () => {
      wrote = true;
    },
  );
  assert.equal(out.ok, false);
  assert.equal(wrote, false, "the write callback must not run on a refused move");
  const row = db.prepare("SELECT stage FROM work WHERE ticket = 'ACME-1'").get() as { stage: string };
  assert.equal(row.stage, "running");
});

// 4. Idempotency: repeats succeed, marked as repeats, without doubling data.
test("repeats are no-ops that do not double parts", () => {
  const db = memDb();
  insertWork(db, "ACME-1", "running");

  const record = () =>
    applyMove(db, "record-report", { YOKEMATE_MODE: "do", YOKEMATE_TICKET: "ACME-1" }, "ACME-1", () => {
      const work = db.prepare("SELECT id FROM work WHERE ticket = 'ACME-1'").get() as { id: number };
      db.prepare("DELETE FROM part WHERE work_id = ?").run(work.id);
      db.prepare("INSERT INTO part (work_id, repo, role, branch, pr) VALUES (?, 'o/r', 'app', 'ACME-1', 'pr')").run(
        work.id,
      );
      db.prepare("UPDATE work SET stage = 'review' WHERE id = ?").run(work.id);
    });

  const first = record();
  assert.ok(first.ok && !first.repeat);
  const second = record();
  assert.ok(second.ok && second.repeat, "a second record-report is a repeat, not an error");
  const parts = db.prepare("SELECT COUNT(*) c FROM part").get() as { c: number };
  assert.equal(parts.c, 1);

  // accept on accepted, rework on planned: same shape of repeat.
  db.prepare("UPDATE work SET stage = 'accepted' WHERE ticket = 'ACME-1'").run();
  const again = checkMove("accept", { YOKEMATE_MODE: "review", YOKEMATE_TICKET: "ACME-1" }, "ACME-1", "accepted");
  assert.ok(again.ok && again.repeat);
  const reworkAgain = checkMove(
    "accept-rework",
    { YOKEMATE_MODE: "review", YOKEMATE_TICKET: "ACME-1" },
    "ACME-1",
    "planned",
  );
  assert.ok(reworkAgain.ok && reworkAgain.repeat);
});

// 5. /plan can run before a ticket exists: its stamp may carry no ticket, and
// its move lands on any row not yet taken to work.
test("plan records fresh and re-planned tickets, never running ones", () => {
  const plan = { YOKEMATE_MODE: "plan" };
  assert.equal(checkMove("plan", plan, "ACME-9", "absent").ok, true);
  assert.equal(checkMove("plan", plan, "ACME-9", "new").ok, true);
  assert.equal(checkMove("plan", plan, "ACME-9", "scouted").ok, true);
  assert.equal(checkMove("plan", plan, "ACME-9", "planned").ok, true);
  assert.equal(checkMove("plan", plan, "ACME-9", "running").ok, false);
  assert.equal(checkMove("plan", plan, "ACME-9", "review").ok, false);
});

// 6. adopt rebuilds a review row on a machine where /do never ran: a fresh
// ticket lands straight in `review`, a second call is a repeat, and a ticket
// someone is coding right here is refused — the stand is already present.
test("adopt creates the review row from absent and repeats from review", () => {
  const review = { YOKEMATE_MODE: "review", YOKEMATE_TICKET: "ACME-1" };
  const fresh = checkMove("adopt", review, "ACME-1", "absent");
  assert.ok(fresh.ok && !fresh.repeat);
  const again = checkMove("adopt", review, "ACME-1", "review");
  assert.ok(again.ok && again.repeat, "a second adopt is a repeat, not an error");
  assert.equal(checkMove("adopt", review, "ACME-1", "running").ok, false);
  // The unstamped main chat is the repair entry, same sources.
  const mainFresh = checkMove("adopt", {}, "ACME-1", "absent");
  assert.ok(mainFresh.ok && !mainFresh.repeat);
  assert.equal(checkMove("adopt", {}, "ACME-1", "running").ok, false);
});

// 7. spawn admits a fresh row only when the caller named the plan outright.
test("spawn takes a fresh ticket only with an explicit plan", () => {
  assert.equal(checkMove("spawn", {}, "ACME-1", "absent").ok, false);
  assert.equal(checkMove("spawn", {}, "ACME-1", "absent", { allowFresh: true }).ok, true);
  assert.equal(checkMove("spawn", {}, "ACME-1", "new", { allowFresh: true }).ok, true);
  assert.equal(checkMove("spawn", {}, "ACME-1", "review", { allowFresh: true }).ok, false);
});
