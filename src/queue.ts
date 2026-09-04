// The queue view: sync on every read (R3.5), then print the rows. This is the
// projection of the tracker plus our stages — nothing else stores state.
//
// Usage:
//   pnpm queue              all rows, synced first
//   pnpm queue planned      «что можно запустить в работу?»
//   pnpm queue me           «чья очередь ходить — моя?»

import { join, resolve } from "node:path";
import { openDb, ownerFor, queueLine, type Stage } from "./db.ts";
import { issueStates, type GithubProject } from "./github.ts";
import { syncWork, type Divergence, type TicketState } from "./sync.ts";
import { trackers, type Tracker } from "./trackers.ts";
import { ticketStates } from "./youtrack.ts";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const db = openDb(join(ROOT, "yokemate.db"));

// The tracker for a ticket is found through its key prefix in the passports.
const projectRows = db
  .prepare("SELECT tracker, tracker_key, org, repo, path FROM project")
  .all() as unknown as {
  tracker: string;
  tracker_key: string;
  org: string;
  repo: string;
  path: string;
}[];
const configured = trackers();

// One `issue id: …` query per tracker answers for the whole queue; a ticket
// whose tracker is unknown is not judged — its row keeps its title and gets no
// marker.
const { diverged } = await syncWork(db, async (tickets) => {
  const states = new Map<string, TicketState>();
  const byTracker = new Map<Tracker, string[]>();
  const byGithub = new Map<GithubProject, string[]>();
  const githubOf = new Map<string, GithubProject>();
  for (const ticket of tickets) {
    const key = ticket.split("-")[0];
    const proj = projectRows.find((p) => p.tracker_key === key);
    if (proj?.tracker === "github") {
      const p =
        githubOf.get(key) ??
        githubOf
          .set(key, { org: proj.org, repo: proj.repo, path: proj.path, prefix: proj.tracker_key })
          .get(key)!;
      byGithub.set(p, [...(byGithub.get(p) ?? []), ticket]);
      continue;
    }
    const t = proj && configured.find((x) => x.name === proj.tracker);
    if (!t) {
      const row = db.prepare("SELECT title FROM work WHERE ticket = ?").get(ticket) as
        | { title: string | null }
        | undefined;
      states.set(ticket, { resolved: false, assignedToMe: true, title: row?.title ?? "" });
      continue;
    }
    byTracker.set(t, [...(byTracker.get(t) ?? []), ticket]);
  }
  await Promise.all(
    [...byTracker].map(async ([t, keys]) => {
      for (const [key, state] of await ticketStates(t, keys)) {
        states.set(key, state.title === "" ? { ...state, title: key } : state);
      }
    }),
  );
  for (const [p, keys] of byGithub) {
    for (const [key, state] of issueStates(p, keys)) {
      states.set(key, state.title === "" ? { ...state, title: key } : state);
    }
  }
  return states;
});

interface Row {
  ticket: string;
  title: string | null;
  stage: Stage;
  owner: string | null;
  next: string | null;
  pr: string | null;
}
let rows = db
  .prepare("SELECT ticket, title, stage, owner, next, pr FROM work ORDER BY updated_at DESC")
  .all() as unknown as Row[];

const filter = process.argv[2];
if (filter === "planned") rows = rows.filter((r) => r.stage === "planned");
else if (filter === "me") rows = rows.filter((r) => ownerFor(r.stage, r.owner) === "me");
else if (filter && filter !== "--") {
  console.error(`unknown filter "${filter}" — known: planned, me`);
  process.exit(1);
}

const MARKERS: Record<Divergence["reason"], string> = {
  closed: "⚠ закрыт в трекере",
  reassigned: "⚠ не на мне",
  missing: "⚠ не найден",
};
const markerFor = new Map(diverged.map((d) => [d.ticket, MARKERS[d.reason]]));

if (rows.length === 0) {
  console.log("queue is empty");
} else {
  for (const r of rows) {
    const marker = markerFor.get(r.ticket);
    console.log(`${queueLine(r)}${marker ? ` ${marker}` : ""}`);
  }
  const note = diverged.length ? ` · ${diverged.length} расходится с трекером` : "";
  console.log(`\n${rows.length} row(s)${note}`);
}
