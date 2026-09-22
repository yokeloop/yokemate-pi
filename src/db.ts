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

function columns(db: DatabaseSync, table: string): Map<string, { notnull: number }> {
  return new Map((db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string; notnull: number }[]).map((column) => [column.name, column]));
}

function migratePlanArtifacts(db: DatabaseSync): void {
  const acceptance = columns(db, "plan_publication_acceptance");
  const records = columns(db, "plan_record");
  const oldAcceptance = !acceptance.has("artifact_path") || acceptance.get("publication_id")?.notnull === 1;
  const oldRecords = !records.has("artifact_path") || !records.has("scout_acceptance") || records.get("publication_id")?.notnull === 1;
  if (!oldAcceptance && !oldRecords) {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS plan_record_local_identity
      ON plan_record(ticket,plan_path,content_hash,scope_hash,scout_acceptance)
      WHERE scout_acceptance IS NOT NULL`);
    return;
  }
  db.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
  try {
    if (oldAcceptance) {
      db.exec(`
        CREATE TABLE plan_publication_acceptance_next (
          id INTEGER PRIMARY KEY,
          publication_id INTEGER REFERENCES plan_publication(id),
          ticket TEXT NOT NULL,
          run_id TEXT NOT NULL,
          owner_run_id TEXT NOT NULL,
          owner_session_id TEXT NOT NULL,
          batch_id TEXT NOT NULL,
          task_hash TEXT NOT NULL,
          artifact_path TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          bytes INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (owner_run_id, owner_session_id, batch_id, run_id, task_hash)
        );
        INSERT INTO plan_publication_acceptance_next
          (id,publication_id,ticket,run_id,owner_run_id,owner_session_id,batch_id,task_hash,artifact_path,content_hash,bytes,created_at)
        SELECT a.id,a.publication_id,a.ticket,a.run_id,a.owner_run_id,a.owner_session_id,a.batch_id,a.task_hash,
               p.artifact_path,p.content_hash,p.bytes,a.created_at
        FROM plan_publication_acceptance a JOIN plan_publication p ON p.id=a.publication_id;
        DROP TABLE plan_publication_acceptance;
        ALTER TABLE plan_publication_acceptance_next RENAME TO plan_publication_acceptance;
      `);
    }
    if (oldRecords) {
      db.exec(`
        CREATE TABLE plan_record_next (
          id INTEGER PRIMARY KEY,
          ticket TEXT NOT NULL,
          publication_id INTEGER REFERENCES plan_publication(id),
          plan_path TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          scope_hash TEXT NOT NULL,
          artifact_path TEXT NOT NULL,
          bytes INTEGER NOT NULL,
          scout_publication INTEGER REFERENCES plan_publication(id),
          scout_acceptance INTEGER REFERENCES plan_publication_acceptance(id),
          successful_record INTEGER NOT NULL DEFAULT 0 CHECK (successful_record IN (0,1)),
          side_effects_started INTEGER NOT NULL DEFAULT 0 CHECK (side_effects_started IN (0,1)),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (ticket, publication_id, plan_path, content_hash, scope_hash, scout_publication)
        );
        INSERT INTO plan_record_next
          (id,ticket,publication_id,plan_path,content_hash,scope_hash,artifact_path,bytes,scout_publication,scout_acceptance,successful_record,side_effects_started,created_at,updated_at)
        SELECT r.id,r.ticket,r.publication_id,r.plan_path,r.content_hash,r.scope_hash,
               p.artifact_path,p.bytes,r.scout_publication,NULL,r.successful_record,r.side_effects_started,r.created_at,r.updated_at
        FROM plan_record r JOIN plan_publication p ON p.id=r.publication_id;
        DROP TABLE plan_record;
        ALTER TABLE plan_record_next RENAME TO plan_record;
      `);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS plan_record_local_identity
      ON plan_record(ticket,plan_path,content_hash,scope_hash,scout_acceptance)
      WHERE scout_acceptance IS NOT NULL`);
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length) throw new Error("plan artifact migration failed foreign key check");
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function addColumn(db: DatabaseSync, table: string, definition: string): void {
  const name = definition.trim().split(/\s+/, 1)[0]!;
  if (!columns(db, table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function migratePublicationProvenance(db: DatabaseSync): void {
  if (columns(db, "plan_publication").has("provenance_key")) return;
  db.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE plan_publication_next (
        id INTEGER PRIMARY KEY, target TEXT NOT NULL, target_hash TEXT NOT NULL, canonical_url TEXT,
        ticket TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('scout','plan')), content_hash TEXT NOT NULL,
        provenance_key TEXT NOT NULL, artifact_path TEXT NOT NULL, bytes INTEGER NOT NULL, run_id TEXT NOT NULL,
        owner_run_id TEXT, owner_session_id TEXT, batch_id TEXT, task_hash TEXT, plan_path TEXT, scope_hash TEXT,
        scout_publication INTEGER REFERENCES plan_publication_next(id), successful_record INTEGER NOT NULL DEFAULT 0 CHECK (successful_record IN (0,1)),
        complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0,1)), error_code TEXT,
        side_effects_started INTEGER NOT NULL DEFAULT 0 CHECK (side_effects_started IN (0,1)),
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (target,ticket,kind,content_hash,provenance_key)
      );
      INSERT INTO plan_publication_next
        (id,target,target_hash,canonical_url,ticket,kind,content_hash,provenance_key,artifact_path,bytes,run_id,owner_run_id,owner_session_id,batch_id,task_hash,plan_path,scope_hash,scout_publication,successful_record,complete,error_code,side_effects_started,created_at,updated_at)
      SELECT id,target,target_hash,canonical_url,ticket,kind,content_hash,'normal',artifact_path,bytes,run_id,owner_run_id,owner_session_id,batch_id,task_hash,plan_path,scope_hash,scout_publication,successful_record,complete,error_code,side_effects_started,created_at,updated_at
      FROM plan_publication;
      DROP TABLE plan_publication;
      ALTER TABLE plan_publication_next RENAME TO plan_publication;
    `);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally { db.exec("PRAGMA foreign_keys = ON"); }
}

function migrateIncidentColumns(db: DatabaseSync): void {
  addColumn(db, "plan_publication", "source_kind TEXT NOT NULL DEFAULT 'normal-transport'");
  addColumn(db, "plan_publication", "incident_id TEXT REFERENCES workflow_incident(id)");
  addColumn(db, "plan_publication", "candidate_id TEXT REFERENCES plan_scout_candidate(id)");
  addColumn(db, "plan_publication", "source_run_id TEXT");
  addColumn(db, "plan_publication", "failure_hash TEXT");
  addColumn(db, "plan_publication", "payload_hash TEXT");
  addColumn(db, "plan_publication", "skipped_json TEXT");
  addColumn(db, "plan_publication", "preserved_json TEXT");
  addColumn(db, "plan_publication", "incident_reason TEXT");
  addColumn(db, "plan_publication_acceptance", "source_kind TEXT NOT NULL DEFAULT 'normal-transport'");
  addColumn(db, "plan_publication_acceptance", "incident_id TEXT REFERENCES workflow_incident(id)");
  addColumn(db, "plan_publication_acceptance", "candidate_id TEXT REFERENCES plan_scout_candidate(id)");
  addColumn(db, "plan_publication_acceptance", "source_run_id TEXT");
  addColumn(db, "plan_publication_acceptance", "failure_hash TEXT");
  addColumn(db, "plan_publication_acceptance", "payload_hash TEXT");
  addColumn(db, "plan_publication_acceptance", "skipped_json TEXT");
  addColumn(db, "plan_publication_acceptance", "preserved_json TEXT");
  addColumn(db, "plan_publication_acceptance", "incident_reason TEXT");
  addColumn(db, "plan_publication_acceptance", "continuation_id TEXT");
  addColumn(db, "plan_publication_acceptance", "continuation_generation INTEGER");
  addColumn(db, "plan_record", "source_kind TEXT NOT NULL DEFAULT 'normal-transport'");
  addColumn(db, "plan_record", "incident_id TEXT REFERENCES workflow_incident(id)");
  addColumn(db, "plan_record", "candidate_id TEXT REFERENCES plan_scout_candidate(id)");
  addColumn(db, "plan_record", "writer_run_id TEXT");
  addColumn(db, "plan_record", "writer_task_hash TEXT");
  addColumn(db, "plan_record", "writer_actual_task_hash TEXT");
  addColumn(db, "workflow_incident", "plan_state TEXT NOT NULL DEFAULT 'absent'");
  addColumn(db, "workflow_incident", "plan_hash TEXT NOT NULL DEFAULT ''");
  addColumn(db, "workflow_incident", "plan_scope_hash TEXT NOT NULL DEFAULT ''");
  addColumn(db, "workflow_incident", "plan_path_hash TEXT NOT NULL DEFAULT ''");
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
      provenance_key     TEXT NOT NULL DEFAULT 'normal',
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
      UNIQUE (target, ticket, kind, content_hash, provenance_key)
    );

    CREATE TABLE IF NOT EXISTS plan_publication_acceptance (
      id               INTEGER PRIMARY KEY,
      publication_id   INTEGER REFERENCES plan_publication(id),
      ticket           TEXT NOT NULL,
      run_id           TEXT NOT NULL,
      owner_run_id     TEXT NOT NULL,
      owner_session_id TEXT NOT NULL,
      batch_id         TEXT NOT NULL,
      task_hash        TEXT NOT NULL,
      artifact_path    TEXT NOT NULL,
      content_hash     TEXT NOT NULL,
      bytes            INTEGER NOT NULL,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (owner_run_id, owner_session_id, batch_id, run_id, task_hash)
    );

    CREATE TABLE IF NOT EXISTS plan_record (
      id                   INTEGER PRIMARY KEY,
      ticket               TEXT NOT NULL,
      publication_id       INTEGER REFERENCES plan_publication(id),
      plan_path            TEXT NOT NULL,
      content_hash         TEXT NOT NULL,
      scope_hash           TEXT NOT NULL,
      artifact_path        TEXT NOT NULL,
      bytes                INTEGER NOT NULL,
      scout_publication    INTEGER REFERENCES plan_publication(id),
      scout_acceptance     INTEGER REFERENCES plan_publication_acceptance(id),
      successful_record    INTEGER NOT NULL DEFAULT 0 CHECK (successful_record IN (0,1)),
      side_effects_started INTEGER NOT NULL DEFAULT 0 CHECK (side_effects_started IN (0,1)),
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (ticket, publication_id, plan_path, content_hash, scope_hash, scout_publication)
    );

    CREATE TABLE IF NOT EXISTS plan_publication_block (
      id         INTEGER PRIMARY KEY,
      ticket     TEXT NOT NULL,
      run_id     TEXT NOT NULL,
      reason     TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (ticket, run_id, reason)
    );

    CREATE TABLE IF NOT EXISTS plan_scout_candidate (
      id TEXT PRIMARY KEY,
      ticket TEXT NOT NULL,
      planning_identity TEXT NOT NULL,
      generation INTEGER NOT NULL,
      parent_runtime_id TEXT NOT NULL,
      parent_session_id TEXT NOT NULL,
      owner_run_id TEXT NOT NULL,
      owner_session_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      task_hash TEXT NOT NULL,
      actual_task_hash TEXT NOT NULL,
      cwd TEXT NOT NULL,
      child_session_id TEXT NOT NULL,
      artifact_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      failed_envelope_hash TEXT NOT NULL,
      terminal_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (owner_run_id,owner_session_id,batch_id,run_id,task_hash,failed_envelope_hash)
    );

    CREATE TABLE IF NOT EXISTS workflow_recovery_decision (
      id TEXT PRIMARY KEY,
      candidate_id TEXT,
      ticket TEXT NOT NULL,
      action TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      source_uid INTEGER NOT NULL,
      source_session_id TEXT NOT NULL,
      source_runtime_id TEXT NOT NULL,
      code TEXT NOT NULL,
      blockers_json TEXT,
      reason TEXT NOT NULL,
      outcome TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workflow_recovery_attempt (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL REFERENCES plan_scout_candidate(id),
      ticket TEXT NOT NULL,
      action TEXT NOT NULL,
      input_generation INTEGER NOT NULL,
      input_hash TEXT NOT NULL,
      scope_hash TEXT NOT NULL,
      target_hash TEXT NOT NULL,
      source_uid INTEGER NOT NULL,
      source_session_id TEXT NOT NULL,
      source_runtime_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      failure_hash TEXT NOT NULL,
      reason TEXT NOT NULL,
      outcome TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workflow_incident (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL REFERENCES plan_scout_candidate(id),
      ticket TEXT NOT NULL,
      action TEXT NOT NULL,
      planning_identity TEXT NOT NULL,
      input_generation INTEGER NOT NULL,
      input_hash TEXT NOT NULL,
      scope_hash TEXT NOT NULL,
      target_hash TEXT NOT NULL,
      plan_state TEXT NOT NULL,
      plan_hash TEXT NOT NULL,
      plan_scope_hash TEXT NOT NULL,
      plan_path_hash TEXT NOT NULL,
      reason TEXT NOT NULL,
      source_uid INTEGER NOT NULL,
      source_session_id TEXT NOT NULL,
      source_runtime_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (candidate_id,action)
    );

    CREATE TABLE IF NOT EXISTS workflow_incident_event (
      id INTEGER PRIMARY KEY,
      incident_id TEXT NOT NULL REFERENCES workflow_incident(id),
      kind TEXT NOT NULL CHECK (kind IN ('grant','refusal','revoke','expiry','consume','dispatch','effect-start','outcome')),
      code TEXT NOT NULL,
      actor_uid INTEGER NOT NULL,
      source_session_id TEXT NOT NULL,
      source_runtime_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      input_generation INTEGER NOT NULL,
      input_hash TEXT NOT NULL,
      ticket TEXT NOT NULL,
      action TEXT NOT NULL,
      scope_hash TEXT NOT NULL,
      target_hash TEXT NOT NULL,
      continuation_id TEXT,
      writer_id TEXT,
      payload_hash TEXT,
      failure_hash TEXT,
      plan_hash TEXT,
      reason TEXT,
      bypassed_json TEXT,
      preserved_json TEXT,
      blockers_json TEXT,
      effect TEXT,
      outcome TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workflow_incident_claim (
      candidate_id TEXT NOT NULL REFERENCES plan_scout_candidate(id),
      action TEXT NOT NULL,
      incident_id TEXT NOT NULL REFERENCES workflow_incident(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (candidate_id,action)
    );

    CREATE TABLE IF NOT EXISTS workflow_writer_dispatch (
      id TEXT PRIMARY KEY,
      accepted_input_id TEXT NOT NULL,
      planning_identity TEXT NOT NULL,
      dispatch_kind TEXT NOT NULL CHECK (dispatch_kind IN ('initial','revision')),
      revision_of TEXT NOT NULL DEFAULT '',
      writer_run_id TEXT NOT NULL,
      task_hash TEXT NOT NULL,
      actual_task_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (accepted_input_id,planning_identity,dispatch_kind,revision_of)
    );

    CREATE TABLE IF NOT EXISTS workflow_writer_draft (
      content_hash TEXT PRIMARY KEY,
      accepted_input_id INTEGER NOT NULL REFERENCES plan_publication_acceptance(id),
      planning_identity TEXT NOT NULL,
      writer_run_id TEXT NOT NULL,
      writer_task_hash TEXT NOT NULL,
      writer_actual_task_hash TEXT NOT NULL,
      plan_path TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      result_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (accepted_input_id,planning_identity,writer_run_id)
    );

    CREATE TRIGGER IF NOT EXISTS workflow_recovery_decision_no_update BEFORE UPDATE ON workflow_recovery_decision BEGIN SELECT RAISE(ABORT,'workflow recovery decisions are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_recovery_decision_no_delete BEFORE DELETE ON workflow_recovery_decision BEGIN SELECT RAISE(ABORT,'workflow recovery decisions are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS plan_scout_candidate_no_update BEFORE UPDATE ON plan_scout_candidate BEGIN SELECT RAISE(ABORT,'plan scout candidates are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS plan_scout_candidate_no_delete BEFORE DELETE ON plan_scout_candidate BEGIN SELECT RAISE(ABORT,'plan scout candidates are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_incident_no_update BEFORE UPDATE ON workflow_incident BEGIN SELECT RAISE(ABORT,'workflow incidents are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_incident_no_delete BEFORE DELETE ON workflow_incident BEGIN SELECT RAISE(ABORT,'workflow incidents are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_incident_claim_no_update BEFORE UPDATE ON workflow_incident_claim BEGIN SELECT RAISE(ABORT,'workflow incident claims are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_incident_claim_no_delete BEFORE DELETE ON workflow_incident_claim BEGIN SELECT RAISE(ABORT,'workflow incident claims are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_writer_dispatch_no_update BEFORE UPDATE ON workflow_writer_dispatch BEGIN SELECT RAISE(ABORT,'workflow writer dispatches are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_writer_dispatch_no_delete BEFORE DELETE ON workflow_writer_dispatch BEGIN SELECT RAISE(ABORT,'workflow writer dispatches are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_recovery_attempt_no_update BEFORE UPDATE ON workflow_recovery_attempt BEGIN SELECT RAISE(ABORT,'workflow recovery attempts are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_recovery_attempt_no_delete BEFORE DELETE ON workflow_recovery_attempt BEGIN SELECT RAISE(ABORT,'workflow recovery attempts are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_incident_event_no_update BEFORE UPDATE ON workflow_incident_event BEGIN SELECT RAISE(ABORT,'workflow incident events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_incident_event_no_delete BEFORE DELETE ON workflow_incident_event BEGIN SELECT RAISE(ABORT,'workflow incident events are append-only'); END;

    CREATE TABLE IF NOT EXISTS task_group (
      id TEXT PRIMARY KEY,
      root_identity TEXT NOT NULL UNIQUE,
      root_ticket TEXT NOT NULL,
      owner_project TEXT NOT NULL,
      active_revision TEXT,
      phase TEXT NOT NULL CHECK (phase IN ('planning','planned','running','review','accepted','shipping','done','blocked')),
      resume_phase TEXT CHECK (resume_phase IS NULL OR resume_phase IN ('planning','planned','running','review','accepted','shipping')),
      blocker TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS group_revision (
      group_id TEXT NOT NULL REFERENCES task_group(id),
      revision_hash TEXT NOT NULL,
      tree_hash TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      bindings_json TEXT NOT NULL,
      compatibility_json TEXT NOT NULL,
      approach_receipt_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (group_id, revision_hash)
    );

    CREATE TABLE IF NOT EXISTS group_member (
      group_id TEXT NOT NULL REFERENCES task_group(id),
      revision_hash TEXT NOT NULL,
      member_identity TEXT NOT NULL,
      ticket TEXT NOT NULL,
      parent_identity TEXT,
      plan_record_id INTEGER REFERENCES plan_record(id),
      prior_state_json TEXT NOT NULL DEFAULT '{}',
      stage TEXT NOT NULL CHECK (stage IN ('new','scouted','planned','running','review','accepted','integrated')),
      execution TEXT NOT NULL CHECK (execution IN ('not_started','queued','running','ready','integrated','blocked')),
      blocker TEXT,
      result_json TEXT,
      tracker_state TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (group_id, revision_hash, member_identity),
      FOREIGN KEY (group_id, revision_hash) REFERENCES group_revision(group_id, revision_hash)
    );

    CREATE TABLE IF NOT EXISTS group_part (
      group_id TEXT NOT NULL,
      revision_hash TEXT NOT NULL,
      member_identity TEXT NOT NULL,
      repo TEXT NOT NULL,
      remote TEXT NOT NULL,
      role TEXT NOT NULL,
      source_ref TEXT,
      target_ref TEXT,
      pr_identity TEXT,
      head_sha TEXT,
      base_sha TEXT,
      readiness_json TEXT,
      reviewer_json TEXT,
      merge_commit TEXT,
      outcome TEXT,
      PRIMARY KEY (group_id, revision_hash, member_identity, repo),
      FOREIGN KEY (group_id, revision_hash, member_identity) REFERENCES group_member(group_id, revision_hash, member_identity)
    );

    CREATE TABLE IF NOT EXISTS group_repository (
      group_id TEXT NOT NULL,
      revision_hash TEXT NOT NULL,
      repo TEXT NOT NULL,
      remote TEXT NOT NULL,
      role TEXT NOT NULL,
      integration_branch TEXT NOT NULL,
      external_base TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      final_pr TEXT,
      head_sha TEXT,
      merge_commit TEXT,
      ship_state TEXT NOT NULL DEFAULT 'pending' CHECK (ship_state IN ('pending','ready','merged','remaining','unknown','failed')),
      PRIMARY KEY (group_id, revision_hash, repo),
      FOREIGN KEY (group_id, revision_hash) REFERENCES group_revision(group_id, revision_hash)
    );

    CREATE TABLE IF NOT EXISTS group_acceptance (
      group_id TEXT NOT NULL,
      revision_hash TEXT NOT NULL,
      candidate_hash TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      review_source_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('current','superseded')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (group_id, revision_hash, candidate_hash),
      FOREIGN KEY (group_id, revision_hash) REFERENCES group_revision(group_id, revision_hash)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS group_acceptance_current
      ON group_acceptance(group_id, revision_hash) WHERE state = 'current';

    CREATE TABLE IF NOT EXISTS group_rework (
      group_id TEXT NOT NULL,
      revision_hash TEXT NOT NULL,
      candidate_hash TEXT NOT NULL,
      plan_binding_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','running','ready','superseded')),
      review_source_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (group_id, revision_hash, candidate_hash),
      FOREIGN KEY (group_id, revision_hash) REFERENCES group_revision(group_id, revision_hash)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS group_rework_current
      ON group_rework(group_id, revision_hash) WHERE state IN ('pending','running');

    CREATE TABLE IF NOT EXISTS group_effect (
      effect_key TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES task_group(id),
      revision_hash TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('integrate','ship','to_verify','done','cleanup')),
      input_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('intent','unknown','confirmed','failed')),
      outcome_json TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (group_id, revision_hash) REFERENCES group_revision(group_id, revision_hash)
    );

    CREATE TABLE IF NOT EXISTS group_move (
      idempotency_key TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES task_group(id),
      revision_hash TEXT,
      from_phase TEXT NOT NULL,
      to_phase TEXT NOT NULL,
      outcome_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS member_claim (
      member_identity TEXT PRIMARY KEY,
      ticket TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('single','group')),
      group_id TEXT REFERENCES task_group(id),
      revision_hash TEXT,
      tree_hash TEXT,
      owners_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved','active','suspended')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TRIGGER IF NOT EXISTS group_revision_no_update BEFORE UPDATE ON group_revision BEGIN SELECT RAISE(ABORT,'group revisions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS group_revision_no_delete BEFORE DELETE ON group_revision BEGIN SELECT RAISE(ABORT,'group revisions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS group_move_no_update BEFORE UPDATE ON group_move BEGIN SELECT RAISE(ABORT,'group moves are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS group_move_no_delete BEFORE DELETE ON group_move BEGIN SELECT RAISE(ABORT,'group moves are append-only'); END;
  `);
  migratePlanArtifacts(db);
  migratePublicationProvenance(db);
  migrateIncidentColumns(db);
  addColumn(db, "member_claim", "ticket TEXT");
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
