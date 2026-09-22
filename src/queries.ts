// The two queries that cover the day.
import type { DatabaseSync } from "node:sqlite";
import { ownerFor, type Stage } from "./db.ts";

export interface GroupQueueRow {
  groupId: string;
  rootTicket: string;
  revisionHash: string | null;
  phase: string;
  blocker: string | null;
  members: { ticket: string; stage: string; execution: string; blocker: string | null }[];
}

export interface WorkRow {
  id: number;
  ticket: string;
  title: string | null;
  stage: Stage;
  owner: string | null;
  next: string | null;
  pr: string | null;
}

function withOwner(rows: WorkRow[]): (WorkRow & { effectiveOwner: string | null })[] {
  return rows.map((r) => ({ ...r, effectiveOwner: ownerFor(r.stage, r.owner) }));
}

export function groupQueueRows(db: DatabaseSync, phases?: string[]): GroupQueueRow[] {
  const rows = db.prepare(`SELECT id,root_ticket,active_revision,phase,blocker FROM task_group ${phases?.length ? `WHERE phase IN (${phases.map(() => "?").join(",")})` : "WHERE phase!='done'"} ORDER BY updated_at DESC`).all(...(phases ?? [])) as unknown as { id: string; root_ticket: string; active_revision: string | null; phase: string; blocker: string | null }[];
  return rows.map((row) => ({ groupId: row.id, rootTicket: row.root_ticket, revisionHash: row.active_revision, phase: row.phase, blocker: row.blocker, members: row.active_revision ? db.prepare("SELECT ticket,stage,execution,blocker FROM group_member WHERE group_id=? AND revision_hash=? ORDER BY rowid").all(row.id, row.active_revision) as unknown as GroupQueueRow["members"] : [] }));
}

/** «что можно запустить в работу?» */
export function planned(db: DatabaseSync) {
  const groups = groupQueueRows(db, ["planned"]);
  const grouped = new Set(groups.flatMap((group) => group.members.map((member) => member.ticket)));
  return { work: withOwner(db.prepare("SELECT * FROM work WHERE stage = 'planned'").all() as unknown as WorkRow[]).filter((row) => !grouped.has(row.ticket)), groups };
}

/** «чья очередь ходить — моя?» */
export function onMe(db: DatabaseSync) {
  const rows = db.prepare("SELECT * FROM work").all() as unknown as WorkRow[];
  return withOwner(rows).filter((r) => r.effectiveOwner === "me");
}
