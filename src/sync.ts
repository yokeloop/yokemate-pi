// Sync on every read (R3.5): the tracker answers «what is on the user», the
// queue keeps «what is in work». Sync never deletes a row — a ticket closed,
// reassigned or gone comes back as a divergence for the view to show; a row
// leaves only on the engineer's action (accept or drop). Worktrees, branches
// and PRs are never touched (R3.6).
import type { DatabaseSync } from "node:sqlite";

/** What the tracker says about one ticket. */
export interface TicketState {
  resolved: boolean;
  assignedToMe: boolean;
  title: string;
}

/** One call for the whole queue; a ticket absent from the map does not exist. */
export type FetchStates = (tickets: string[]) => Promise<Map<string, TicketState>>;

export interface Divergence {
  ticket: string;
  reason: "closed" | "reassigned" | "missing";
}

export interface SyncResult {
  updated: string[];
  diverged: Divergence[];
}

export async function syncWork(db: DatabaseSync, fetchStates: FetchStates): Promise<SyncResult> {
  const rows = db
    .prepare("SELECT id, ticket, title, stage FROM work")
    .all() as { id: number; ticket: string; title: string | null; stage: string }[];

  const updated: string[] = [];
  const diverged: Divergence[] = [];
  // Title only — local fields (next, artifact, …) are never overwritten (R3.9).
  const upd = db.prepare(
    "UPDATE work SET title = ?, updated_at = datetime('now') WHERE id = ?",
  );

  const states = await fetchStates(rows.map((r) => r.ticket));
  for (const row of rows) {
    const state = states.get(row.ticket);
    if (state === undefined) {
      diverged.push({ ticket: row.ticket, reason: "missing" });
      continue;
    }
    if (state.resolved) {
      diverged.push({ ticket: row.ticket, reason: "closed" });
      continue;
    }
    if (!state.assignedToMe) {
      diverged.push({ ticket: row.ticket, reason: "reassigned" });
      continue;
    }
    if (state.title !== row.title) {
      upd.run(state.title, row.id);
      updated.push(row.ticket);
    }
  }
  return { updated, diverged };
}
