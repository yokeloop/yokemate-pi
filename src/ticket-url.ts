// The ticket's own URL in its tracker, found by the key prefix: ACME-347 → the
// tracker that ACME sits on. That is all a work row needs to know about the
// outside world.
//
// It deliberately does not resolve a repository. A ticket can touch one or
// several, and which ones is a fact of the plan, not of the tracker field — the
// parts are recorded per repository in the `part` table.
import type { DatabaseSync } from "node:sqlite";
import { issueUrl, ticketNumber, type RemoteOf } from "./github.ts";
import { trackers } from "./trackers.ts";

export function ticketUrl(db: DatabaseSync, ticket: string, remoteOf?: RemoteOf): string {
  const key = ticket.split("-")[0];
  const row = db
    .prepare("SELECT tracker, path FROM project WHERE tracker_key = ? LIMIT 1")
    .get(key) as { tracker: string; path: string } | undefined;
  if (row?.tracker === "github") {
    try {
      return issueUrl(row.path, ticketNumber(ticket), remoteOf);
    } catch {
      return `ticket:${ticket}`;
    }
  }
  const t = row && trackers().find((x) => x.name === row.tracker);
  return t ? `${t.baseUrl}/issue/${ticket}` : `ticket:${ticket}`;
}
