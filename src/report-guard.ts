// Stop hook for the task tab: the tab may not finish while its ticket's stage
// is still `running` — finishing means the PRs are recorded, and the tab
// records them itself with `pnpm record-report`, the move that sets `review`.
// The verdict is read straight from the database: mechanism, not a marker
// file. A failure to read allows the stop — a broken guard must not paralyze
// the work it protects (same policy as bash-guard).
//
// It guards /do and nothing else: mode panes carry other YOKEMATE_MODE stamps
// and pass through, and the review pane sits at the yokemate root besides.
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readGuardPolicy, type GuardPolicy } from "./guard-policy.ts";

export interface GuardEnv {
  YOKEMATE_MODE?: string;
  YOKEMATE_TICKET?: string;
}

/** null — let the stop through; a string — block with that reason. */
export function stopVerdict(
  env: GuardEnv,
  readStage: (ticket: string) => string | undefined,
  policy: GuardPolicy = readGuardPolicy(),
): string | null {
  if (!policy.guards.doCompletion || env.YOKEMATE_MODE !== "do" || !env.YOKEMATE_TICKET) return null;
  const stage = readStage(env.YOKEMATE_TICKET);
  if (stage === "review" || stage === "accepted") return null;
  return (
    `The ticket's stage is still ${stage ?? "unrecorded"}. When every PR is open and green, record the result ` +
    `yourself from the task folder root: pnpm record-report ${env.YOKEMATE_TICKET} ` +
    `--part <org/repo>:<role>:<branch>:<pr-url> — one --part per repository — then send the report with ` +
    `send_message and finish. A ticket that cannot be completed records nothing: report what is missing with ` +
    `send_message and wait — the orchestrator closes this tab.`
  );
}

if (import.meta.filename === process.argv[1]) {
  const ROOT = resolve(new URL("..", import.meta.url).pathname);
  let reason: string | null = null;
  try {
    // Raw read-only handle, not openDb: a hook runs no DDL.
    const db = new DatabaseSync(join(ROOT, "yokemate.db"), { readOnly: true });
    reason = stopVerdict(process.env, (ticket) =>
      (
        db.prepare("SELECT stage FROM work WHERE ticket = ?").get(ticket) as
          | { stage: string }
          | undefined
      )?.stage,
    );
  } catch {
    reason = null; // cannot read the DB → allow; see the header
  }
  if (reason) console.log(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}
