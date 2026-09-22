// Explicit removal of a ticket from the queue: the engineer's action from the
// main chat, like the repair entry `stage` — sync never deletes, this command
// and accept are the only two exits. It deletes the work row, and only the
// row: worktrees, branches, PRs and the task folder are not touched.
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { dataRoot } from "./data-root.ts";
import { openDb } from "./db.ts";
import { logMove } from "./move-log.ts";

/** true — the row existed and is gone; false — nothing to drop. */
export function drop(db: DatabaseSync, ticket: string): boolean {
  const group = db.prepare(`SELECT c.group_id,c.revision_hash,c.state FROM member_claim c JOIN group_member m
    ON m.group_id=c.group_id AND m.revision_hash=c.revision_hash AND m.member_identity=c.member_identity
    WHERE c.kind='group' AND m.ticket=? AND c.state IN ('reserved','active','suspended') LIMIT 1`).get(ticket) as { group_id: string; revision_hash: string; state: string } | undefined;
  if (group) throw new Error(`${ticket} belongs to group ${group.group_id}/${group.revision_hash} (${group.state}); drop cannot remove group membership or claims`);
  const row = db.prepare("SELECT 1 FROM work WHERE ticket = ?").get(ticket);
  if (!row) return false;
  db.prepare("DELETE FROM work WHERE ticket = ?").run(ticket);
  return true;
}

// CLI: pnpm drop ACME-347
if (import.meta.url === `file://${process.argv[1]}`) {
  const ROOT = resolve(new URL("..", import.meta.url).pathname);
  const DATA = dataRoot(ROOT);
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const ticket = argv[0];
  if (!ticket || argv.length > 1) {
    console.error("usage: drop <TICKET>");
    process.exit(1);
  }
  const db = openDb(join(ROOT, "yokemate.db"));
  if (!drop(db, ticket)) {
    console.log(`${ticket} не в очереди`);
    process.exit(0);
  }
  logMove(DATA, ticket, "снято с очереди");
  console.log(`${ticket} снят с очереди`);
}
