// Queue and project passports. Stage moves go through src/transitions.ts —
// the mode where the result was born records it itself, under that file's
// checks; the unstamped main chat is the repair entry.
import { DatabaseSync } from "node:sqlite";

export const STAGES = ["new", "scouted", "planned", "running", "review", "accepted"] as const;
export type Stage = (typeof STAGES)[number];

// Owner is derived from the stage; work.owner only overrides.
const STAGE_OWNER: Record<Stage, "me" | "agent" | null> = {
  new: "me",
  scouted: "me",
  planned: "agent",
  running: "agent",
  review: "me",
  accepted: null,
};

export function ownerFor(stage: Stage, override?: string | null): string | null {
  return override ?? STAGE_OWNER[stage];
}

/** One queue row as every view prints it — queue and the warmup digest alike. */
export function queueLine(r: {
  ticket: string;
  title: string | null;
  stage: Stage;
  owner: string | null;
  next: string | null;
}): string {
  const owner = ownerFor(r.stage, r.owner) ?? "—";
  return `${r.ticket.padEnd(10)} ${r.stage.padEnd(8)} ${owner.padEnd(6)} ${(r.title ?? "").slice(0, 48).padEnd(48)} ${r.next ?? ""}`;
}

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS project (
      id           INTEGER PRIMARY KEY,
      org          TEXT NOT NULL,             -- normalized (R0.12)
      repo         TEXT NOT NULL,
      path         TEXT NOT NULL,             -- the engineer's clone; worktrees fork from here
      tracker      TEXT NOT NULL,             -- acme-eu | acme | yokeloop | github
      tracker_key  TEXT NOT NULL,             -- ACME, AEU, YM …
      model        TEXT NOT NULL,             -- openai-codex/gpt-5.6-terra | … — the pi model
                                              -- pattern every launch for this project's
                                              -- tickets runs on
      mode_models  TEXT,                      -- {"review":"openai-codex/gpt-5.6-luna", …} —
                                              -- модель на мод панели поверх model; NULL, когда
                                              -- переопределений нет. Мод, а не work.stage (YM-159)
      figma_mcp    TEXT,                      -- figma-acme-eu | figma-acme | NULL
      figma_url    TEXT,                      -- the repo's own design file; NULL when there is none
      subsystem    TEXT,                      -- tracker enum value that scopes this repo; NULL when
                                              -- the tracker has no such field or the repo is not scoped
      UNIQUE (org, repo)
    );

    CREATE TABLE IF NOT EXISTS work (
      id         INTEGER PRIMARY KEY,
      ticket     TEXT NOT NULL UNIQUE,        -- R3.1: no row without a ticket
      url        TEXT NOT NULL,
      title      TEXT,                        -- cache from tracker, updated by sync
      stage      TEXT NOT NULL DEFAULT 'new'
                 CHECK (stage IN ('new','scouted','planned','running','review','accepted')),
      owner      TEXT,                        -- explicit override only; else derived
      folder     TEXT,                        -- yokemate/work/<TICKET>
      plan       TEXT,
      next       TEXT,                        -- ONE line, overwritten (R3.8)
      artifact   TEXT,
      pr         TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS part (
      id       INTEGER PRIMARY KEY,
      work_id  INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
      repo     TEXT NOT NULL,                 -- acme/acme-ui-kit
      role     TEXT,                          -- library | app | backend
      branch   TEXT,
      pr       TEXT
    );

    CREATE TABLE IF NOT EXISTS plan_publication (
      id                 INTEGER PRIMARY KEY,
      target             TEXT NOT NULL,
      target_hash        TEXT NOT NULL,
      canonical_url      TEXT,
      ticket             TEXT NOT NULL,
      kind               TEXT NOT NULL CHECK (kind IN ('scout','plan')),
      content_hash       TEXT NOT NULL,
      artifact_path      TEXT NOT NULL,
      bytes              INTEGER NOT NULL,
      run_id             TEXT NOT NULL,
      owner_run_id       TEXT,
      owner_session_id   TEXT,
      batch_id           TEXT,
      task_hash          TEXT,
      plan_path          TEXT,
      scope_hash         TEXT,
      scout_publication  INTEGER REFERENCES plan_publication(id),
      successful_record  INTEGER NOT NULL DEFAULT 0 CHECK (successful_record IN (0,1)),
      complete           INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0,1)),
      error_code         TEXT,
      side_effects_started INTEGER NOT NULL DEFAULT 0 CHECK (side_effects_started IN (0,1)),
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (target, ticket, kind, content_hash)
    );

    CREATE TABLE IF NOT EXISTS plan_publication_block (
      id         INTEGER PRIMARY KEY,
      ticket     TEXT NOT NULL,
      run_id     TEXT NOT NULL,
      reason     TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (ticket, run_id, reason)
    );
  `);
  // Columns added after the first passports existed. SQLite has no
  // ADD COLUMN IF NOT EXISTS, so ask the table what it already has.
  const have = new Set(
    (db.prepare("PRAGMA table_info(project)").all() as unknown as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  for (const col of ["figma_url", "subsystem", "mode_models"]) {
    if (!have.has(col)) db.exec(`ALTER TABLE project ADD COLUMN ${col} TEXT`);
  }
  if (!have.has("model")) {
    db.exec("ALTER TABLE project ADD COLUMN model TEXT");
    // One-time backfill of the passports that predate the column: they all
    // take one pi pattern. New passports state their model at add-project
    // time, checked against pi's catalogue.
    db.exec("UPDATE project SET model = 'openai-codex/gpt-5.6-terra' WHERE model IS NULL");
  }
  // `work.project` named one repository per ticket. A ticket touches one or
  // several, the plan says which, and the parts are kept per repository in
  // `part` — so the column held nothing anyone read, and its NOT NULL forced
  // every command creating a row to guess a repository first. Dropped.
  const workCols = new Set(
    (db.prepare("PRAGMA table_info(work)").all() as unknown as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  if (workCols.has("project")) db.exec("ALTER TABLE work DROP COLUMN project");
  return db;
}
