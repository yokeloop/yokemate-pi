// The warmup digest: what a fresh main-chat session knows before the first
// prompt — the local queue projection, the live work/ folders, the journal
// tail. Deterministic and offline: no tracker sync (that stays with
// `pnpm queue`/`on-me` at the moment of action), so the SessionStart hook is
// fast and never blocks on the network.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataRoot as dataRootOf } from "./data-root.ts";
import { openDb, queueLine, type Stage } from "./db.ts";

const DIGEST_MAX_LINES = 120;
const JOURNAL_WINDOW_DAYS = 3; // covers a weekend between the tail and today

interface QueueRow {
  ticket: string;
  title: string | null;
  stage: Stage;
  owner: string | null;
  next: string | null;
  pr: string | null;
}

function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function monthsToRead(now: Date): string[] {
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return [isoDay(now).slice(0, 7), isoDay(prev).slice(0, 7)];
}

function queueSection(root: string): { lines: string[]; tickets: Set<string> } {
  const dbPath = join(root, "yokemate.db");
  const tickets = new Set<string>();
  if (!existsSync(dbPath)) return { lines: ["нет данных"], tickets };
  const db = openDb(dbPath);
  const rows = db
    .prepare("SELECT ticket, title, stage, owner, next, pr FROM work ORDER BY updated_at DESC")
    .all() as unknown as QueueRow[];
  const groups = db.prepare("SELECT id,root_ticket,active_revision,phase,blocker FROM task_group WHERE phase!='done' ORDER BY updated_at DESC").all() as unknown as { id: string; root_ticket: string; active_revision: string | null; phase: string; blocker: string | null }[];
  const groupedTickets = new Set<string>();
  const groupLines: string[] = [];
  for (const group of groups) {
    tickets.add(group.root_ticket);
    groupLines.push(`${group.root_ticket} group/${group.phase} revision ${group.active_revision?.slice(0, 12) ?? "planning"}${group.blocker ? ` — ${group.blocker}` : ""}`);
    if (!group.active_revision) continue;
    const members = db.prepare("SELECT ticket,stage,execution,blocker FROM group_member WHERE group_id=? AND revision_hash=? ORDER BY rowid").all(group.id, group.active_revision) as unknown as { ticket: string; stage: string; execution: string; blocker: string | null }[];
    for (const member of members) {
      groupedTickets.add(member.ticket);
      tickets.add(member.ticket);
      groupLines.push(`  ${member.ticket} ${member.stage}/${member.execution}${member.blocker ? ` — ${member.blocker}` : ""}`);
    }
  }
  db.close();
  const lines = [...groupLines, ...rows.filter((row) => !groupedTickets.has(row.ticket)).map((r) => {
    tickets.add(r.ticket);
    return queueLine(r).trimEnd();
  })];
  if (lines.length === 0) return { lines: ["очередь пуста"], tickets };
  return { lines, tickets };
}

function workSection(root: string, queued: Set<string>): string[] {
  const dir = join(root, "work");
  if (!existsSync(dir)) return ["нет данных"];
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  if (names.length === 0) return ["пусто"];
  return names.map((n) => (queued.has(n) ? n : `${n} — есть в work/, нет в очереди`));
}

const OUTCOME_RE = /^- (\d{4}-\d{2}-\d{2}) \d{2}:\d{2} \S+/;
const NARRATIVE_RE = /^## (\d{4}-\d{2}-\d{2}) — /;

interface Dated {
  date: string;
  lines: string[];
}

function parseJournal(text: string): { sections: Dated[]; outcomes: Dated[] } {
  const sections: Dated[] = [];
  const outcomes: Dated[] = [];
  let current: Dated | null = null;
  for (const line of text.split("\n")) {
    const outcome = OUTCOME_RE.exec(line);
    if (outcome) {
      current = null;
      outcomes.push({ date: outcome[1], lines: [line] });
      continue;
    }
    const heading = NARRATIVE_RE.exec(line);
    if (heading) {
      current = { date: heading[1], lines: [line] };
      sections.push(current);
      continue;
    }
    if (line.startsWith("## ")) {
      current = null;
      continue;
    }
    if (current) current.lines.push(line);
  }
  return { sections, outcomes };
}

function journalSection(dataRoot: string, now: Date): string[] {
  const files = monthsToRead(now)
    .map((m) => join(dataRoot, "journal", `${m}.md`))
    .filter((p) => existsSync(p));
  if (files.length === 0) return ["нет данных"];

  const sections: Dated[] = [];
  const outcomes: Dated[] = [];
  for (const file of files) {
    const parsed = parseJournal(readFileSync(file, "utf8"));
    sections.push(...parsed.sections);
    outcomes.push(...parsed.outcomes);
  }
  const dates = [...sections, ...outcomes].map((d) => d.date);
  if (dates.length === 0) return ["нет данных"];
  const newest = dates.reduce((a, b) => (a > b ? a : b));
  const [y, m, d] = newest.split("-").map(Number);
  const cutoff = isoDay(new Date(y, m - 1, d - JOURNAL_WINDOW_DAYS));

  const lines: string[] = [];
  for (const s of sections) {
    if (s.date >= cutoff) lines.push(...s.lines);
  }
  for (const o of outcomes) {
    if (o.date >= cutoff) lines.push(...o.lines);
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.length ? lines : ["нет данных"];
}

export function buildDigest(root: string, dataRoot: string): string {
  const now = new Date();
  const queue = queueSection(root);
  const lines = [
    "Очередь (yokemate.db, без синка с трекерами):",
    ...queue.lines,
    "",
    "Живые задачи (work/):",
    ...workSection(root, queue.tickets),
    "",
    "Хвост журнала (home/journal/):",
    ...journalSection(dataRoot, now),
  ];
  if (lines.length > DIGEST_MAX_LINES) {
    const month = isoDay(now).slice(0, 7);
    lines.length = DIGEST_MAX_LINES - 1;
    lines.push(`… обрезано, полный журнал в home/journal/${month}.md`);
  }
  return lines.join("\n");
}

if (import.meta.filename === process.argv[1]) {
  if (process.env.YOKEMATE_MODE) process.exit(0);
  const root = join(import.meta.dirname, "..");
  console.log("Warmup — состояние пула на старте сессии\n");
  console.log(buildDigest(root, dataRootOf(root)));
}
