// The two queries that cover the day.
import type { DatabaseSync } from "node:sqlite";
import { ownerFor, type Stage } from "./db.ts";

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

/** «что можно запустить в работу?» */
export function planned(db: DatabaseSync) {
  return withOwner(
    db.prepare("SELECT * FROM work WHERE stage = 'planned'").all() as unknown as WorkRow[],
  );
}

/** «чья очередь ходить — моя?» */
export function onMe(db: DatabaseSync) {
  const rows = db.prepare("SELECT * FROM work").all() as unknown as WorkRow[];
  return withOwner(rows).filter((r) => r.effectiveOwner === "me");
}
