// PreToolUse guard for every yokemate session (REFACTORING-PLAN A1). One
// script serves three matchers — Bash, Write|Edit, and the engineer's browser
// MCP — and decides by YOKEMATE_MODE, the same stamp mode-guard reads.
//
// Everything lives in the repository: the root .claude/settings.json wires it
// for the main chat and the mode panes, spawn.ts writes the same hooks
// into the task tab's settings. Nothing goes to ~/.claude.
//
// Every deny says what to do instead. On an internal error the guard allows:
// a broken guard must not paralyze the work it protects.

import { join, resolve } from "node:path";
import { dataRoot as dataRootOf } from "./data-root.ts";

export interface GuardEvent {
  tool_name?: string;
  tool_input?: { command?: string; file_path?: string; notebook_path?: string };
}

export interface Verdict {
  decision: "deny" | "ask";
  reason: string;
}

// Waiting: forbidden in every session. Completion comes to the session on its
// own; the forms below were measured at ~75 minutes of foreground sleep over
// three days, including the wrappers used to dodge the CLI's own sleep block.
const WAIT = [
  /(^|[;&|(]\s*|\bdo\s+)(command\s+|builtin\s+)?sleep\s+\d/,
  /\bfor\s+\S+\s+in\s+\$\(\s*seq\b/,
  /\buntil\s+[^;\n]{0,200};\s*do\b/,
  /\bwhile\s+(true|:)\s*;\s*do\b/,
  /\binotifywait\b/,
  /\btail\b[^\n|]*\s-[a-zA-Z]*f\b/,
  /(^|[;&|]\s*)watch\s/,
];

// Long-running launches: forbidden while coding (/do, /ship). The live
// application is /review's job.
const LAUNCH = [
  /\b(pnpm|npm|yarn|bun)(\s+run)?\s+(dev|start|serve|preview)\b/,
  /\bjust\s+(dev|start|serve|run)\b/,
  /\belectron\b/,
  /\bvite\b(?!\s+build)/,
  /--remote-debugging/,
  /\bhttp\.server\b/,
  /\bplaywright\b/,
  /\b(chromium(-browser)?|google-chrome(-stable)?|firefox)\b/,
];

const KILL = [/\b(pkill|killall)\b/, /\bkill\s+(-9\b|-KILL\b|-s\s+(9|KILL)\b)/];

// The /note pane is read-only by mechanism: writing verbs, in-place sed,
// mutating git and gh, and the state-changing pnpm commands die here. The
// blessed exits pass by construction, not by exception — `pnpm note-save`
// and `gh gist create` (secret) match none of these. Redirects are handled
// separately: scrub fd-dups and /dev/ targets, then any `>` left is a write.
const NOTE_WRITE = [
  /(^|[;&|(]\s*|\bsudo\s+|\bxargs\s+)(rm|mv|cp|mkdir|touch|tee)\b/,
  /\bsed\b[^|;&\n]*\s-(-in-place|[a-zA-Z]*i)/,
  /\bgit\b[^|;&\n]*\s(add|commit|push|checkout|restore|reset|stash|clean|merge|rebase)\b/,
  /\bgh\s+(pr|issue|release|repo)\s+(create|edit|close|reopen|merge|delete|comment|review|lock|unlock|ready|update-branch|transfer|rename|archive|sync|set-default)\b/,
  /(^|[;&|(]\s*)pnpm\s+(run\s+)?(spawn|plan|stage|accept|drop|record-report|ship|adopt|close-mode|add-project|set-model|import-projects|pr-link)\b/,
  /\bgh\s+gist\s+create\b[^|;&\n]*--public\b/,
];

const HOME_PATH = /(~\/|\$HOME\/|\/home\/[a-z_][a-z0-9_-]*\/)/;
const DOWNLOADS = /(~|\$HOME|\/home\/[a-z_][a-z0-9_-]*)\/Downloads\//;

// Only a ship launch asks — the one irreversible run: it merges PRs. The other
// modes end in a plan, a PR or a conversation and pass without a dialog. Only
// an actual launch matches: pnpm at a command position (split ship included —
// the split script carries no baked mode), or node executing mode-tab.ts with
// ship. Reading, grepping or editing these files is ordinary work and passes.
const SHIP_LAUNCH =
  /(^|[;&|(]\s*)([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+)*pnpm\s+(run\s+)?(ship\b|split\s+(--\s+)*ship\b)|\bnode\s[^|;&]*\bsrc\/mode-tab\.ts\s+(--\s+)*ship\b/;

function inYokemateTree(cmd: string, own?: { root: string; home?: string }): boolean {
  if (!own) return false;
  const variants = [own.root + "/"];
  if (own.home && own.root.startsWith(own.home + "/")) {
    const rest = own.root.slice(own.home.length);
    variants.push("~" + rest + "/", "$HOME" + rest + "/");
  }
  return variants.some((v) => cmd.includes(v));
}

export function judge(
  mode: string | undefined,
  toolName: string,
  input: { command?: string; file_path?: string; notebook_path?: string },
  own?: { root: string; dataRoot: string; ticket?: string; home?: string },
): Verdict | null {
  const coding = mode === "do" || mode === "ship";
  const paneled = mode !== undefined && mode !== "";
  const onStand = coding || mode === "review";

  if (toolName.startsWith("mcp__claude-in-chrome__")) {
    if (onStand)
      return {
        decision: "deny",
        reason:
          "The engineer's browser is theirs. Prepare the artifact and the instructions; ask the engineer for a screenshot instead of driving Chrome.",
      };
    return null;
  }

  if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
    const path = input.file_path ?? input.notebook_path;
    if (paneled && own) {
      const fenced = [
        join(own.root, ".claude", "settings.json"),
        join(own.root, ".claude", "settings.local.json"),
        join(own.root, ".pi", "settings.json"),
        join(own.root, ".pi", "settings.local.json"),
        ...(own.ticket
          ? [
              join(own.root, "work", own.ticket, ".claude", "settings.json"),
              join(own.root, "work", own.ticket, ".claude", "settings.local.json"),
              join(own.root, "work", own.ticket, ".pi", "settings.json"),
              join(own.root, "work", own.ticket, ".pi", "settings.local.json"),
            ]
          : []),
      ];
      if (fenced.includes(path ?? ""))
        return {
          decision: "deny",
          reason:
            "Session configuration is not edited from a task pane. If the hook or the settings are wrong, report it to the orchestrator.",
        };
    }
    if (mode === "note" && own) {
      const notesDir = join(own.dataRoot, "notes") + "/";
      if (!(path ?? "").startsWith(notesDir))
        return {
          decision: "deny",
          reason:
            "Панель /note ничего не правит: писать можно только заметку в home/notes/. Сохранение — Write в home/notes/<дата>-<тема>.md и pnpm note-save.",
        };
    }
    return null;
  }

  if (toolName !== "Bash") return null;
  const cmd = input.command ?? "";

  if (WAIT.some((r) => r.test(cmd)))
    return {
      decision: "deny",
      reason:
        "Waiting is forbidden: a finished subagent returns its result as the tool result, and completion comes to the session on its own. Check the condition once, without sleep, and keep working.",
    };

  if (mode === "note") {
    const scrubbed = cmd.replace(/\d*>>?\s*(&\d+|\/dev\/\S+)/g, "").replace(/[=<-]>/g, "");
    if (NOTE_WRITE.some((r) => r.test(cmd)) || />/.test(scrubbed))
      return {
        decision: "deny",
        reason:
          "Панель /note read-only: сохранение — Write в home/notes/ + pnpm note-save, выгрузка — gh gist create (secret). Остальное — в главный чат.",
      };
  }

  if (coding && LAUNCH.some((r) => r.test(cmd)))
    return {
      decision: "deny",
      reason:
        "Nothing long-running starts while coding: no dev servers, no app launches, no browsers. Only commands that finish on their own — build, lint, typecheck, unit tests. The live application is /review's job.",
    };

  if (onStand && KILL.some((r) => r.test(cmd)))
    return {
      decision: "deny",
      reason:
        "Kill only processes you started, by their saved PID: kill $PID. Blanket kills reach the engineer's own processes.",
    };

  if (
    onStand &&
    /\brm\b/.test(cmd) &&
    HOME_PATH.test(cmd) &&
    !DOWNLOADS.test(cmd) &&
    !inYokemateTree(cmd, own)
  )
    return {
      decision: "deny",
      reason:
        "Your writable world is the task worktrees and knowledge/…/ai/. The engineer's home directory is not ours to change (~/Downloads on the engineer's word is the one exception).",
    };

  if (!paneled && SHIP_LAUNCH.test(cmd))
    return {
      decision: "ask",
      reason: "Ship merges — the one launch there is no way back from. Confirm this run is on the engineer's word.",
    };

  return null;
}

if (import.meta.filename === process.argv[1]) {
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    try {
      const event = JSON.parse(raw) as GuardEvent;
      const input = event.tool_input ?? {};
      if (input.file_path) input.file_path = resolve(input.file_path);
      if (input.notebook_path) input.notebook_path = resolve(input.notebook_path);
      const root = resolve(new URL("..", import.meta.url).pathname);
      const v = judge(process.env.YOKEMATE_MODE, event.tool_name ?? "", input, {
        root,
        dataRoot: dataRootOf(root),
        ticket: process.env.YOKEMATE_TICKET,
        home: process.env.HOME,
      });
      if (v)
        console.log(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: v.decision,
              permissionDecisionReason: v.reason,
            },
          }),
        );
    } catch {
      // Broken guard → allow; see the header.
    }
    process.exit(0);
  });
}
