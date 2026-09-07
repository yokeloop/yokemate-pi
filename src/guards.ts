// The yokemate guards on pi's extension events: tool_call carries the
// PreToolUse guard, agent_settled the stop guard, session_start the git pull
// and the warmup digest. Wiring only — not one rule lives here. The rules stay
// in bash-guard.ts, report-guard.ts, git-sync.ts and warmup.ts, which know
// nothing about pi and are imported as they are.
//
// Wired by the root .pi/settings.json for the main chat and the panes, and by
// work/<TICKET>/.pi/settings.json, which spawn.ts writes for the task tab.
//
// Every handler swallows its own failure and lets the call through: a broken
// guard must not paralyze the work it protects (same policy as bash-guard).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { judge } from "./bash-guard.ts";
import { dataRoot as dataRootOf } from "./data-root.ts";
import { stopVerdict } from "./report-guard.ts";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

/** A pi tool call in the shape judge() reads; null — not a tool we guard. */
export function guardCall(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): { name: string; input: { command?: string; file_path?: string } } | null {
  if (toolName === "bash")
    return { name: "Bash", input: { command: input.command as string | undefined } };
  if (toolName === "write" || toolName === "edit") {
    const p = input.path;
    return {
      name: toolName === "write" ? "Write" : "Edit",
      input: { file_path: typeof p === "string" ? resolve(cwd, p) : undefined },
    };
  }
  if (toolName === "mcp")
    return { name: `mcp__${input.server ?? ""}__${input.tool ?? ""}`, input: {} };
  return null;
}

export default function guards(pi: ExtensionAPI) {
  // Raw read-only handle, not openDb: a guard runs no DDL.
  const readStage = (ticket: string): string | undefined => {
    const db = new DatabaseSync(join(ROOT, "yokemate.db"), { readOnly: true });
    return (
      db.prepare("SELECT stage FROM work WHERE ticket = ?").get(ticket) as
        | { stage: string }
        | undefined
    )?.stage;
  };

  // No matcher in pi: the filter is the early exit inside the one handler,
  // exactly as bus.ts does it. The whole body is fenced by try/catch because a
  // throw from a tool_call handler kills the tool — the opposite of the policy
  // in the header.
  pi.on("tool_call", async (event, ctx) => {
    try {
      const call = guardCall(event.toolName, event.input as Record<string, unknown>, ctx.cwd);
      if (!call) return undefined;
      const v = judge(process.env.YOKEMATE_MODE, call.name, call.input, {
        root: ROOT,
        dataRoot: dataRootOf(ROOT),
        ticket: process.env.YOKEMATE_TICKET,
        home: process.env.HOME,
      });
      if (!v) return undefined;
      if (v.decision === "deny") return { block: true, reason: v.reason };
      // The one ask judge() returns is a ship launch in the main chat. Without
      // a dialog to ask in, it does not go.
      const ok = ctx.hasUI ? await ctx.ui.confirm("Ship merges", v.reason) : false;
      return ok ? undefined : { block: true, reason: v.reason };
    } catch {
      return undefined;
    }
  });

  // agent_settled, not agent_end: agent_end ends a low-level run pi may still
  // follow with a retry, a compaction or a queued continuation, while
  // agent_settled arrives when nothing more will run and the session idles —
  // so triggerTurn raises a new turn, which is what a blocking Stop was.
  pi.on("agent_settled", () => {
    let reason: string | null = null;
    try {
      reason = stopVerdict(process.env, readStage);
    } catch {
      return;
    }
    if (!reason) return;
    pi.sendMessage(
      { customType: "yokemate-stop-guard", content: reason, display: true },
      { deliverAs: "followUp", triggerTurn: true },
    );
  });
}
