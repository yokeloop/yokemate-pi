// The rules of the tool_call guard, for every yokemate session
// (REFACTORING-PLAN A1). Two kinds of tool reach them — Bash, and Write|Edit
// — and they decide by YOKEMATE_MODE, the same stamp mode-guard reads.
//
// Everything lives in the repository: src/guards.ts hands pi's tool calls to
// judge(), wired by the root .pi/settings.json for the main chat and the mode
// panes and by work/<TICKET>/.pi/settings.json, which spawn.ts writes for the
// task tab. Nothing goes to ~/.pi.
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
  /\btail\b[^\n|;&]*\s-[a-zA-Z]*f\b/,
  /(^|[;&|]\s*)watch\s/,
];

// A wait is judged by what the command runs, not by what it looks for:
// `grep -n "tail -f" test/bash-guard.test.ts` searches for the text and was
// denied on it (YM-134). What a quoted span is depends on the pipeline it
// stands in. Under an ordinary command it is data: emptied before the WAIT
// rules, the quotes kept so the word boundaries around them hold. Under a
// command that runs its argument — a nested shell, ssh, a container, RUNNER
// below — it is a command: its quotes become `;` so the rules meet it at
// command position, and quotes nested inside it are judged the same way.
// A `$(…)` inside double quotes runs wherever it stands. Pipelines are cut at
// `;`, `&`, `||` and newlines outside quotes, and the whole pipeline decides,
// so `echo '<wait>' | sh` counts. A backslash keeps its next character, an
// unclosed quote runs to the end. Every rule that reads the command text
// reads it this way (YM-160); the one exception is the shape of a commit
// message, which is the quoted span itself.
const RUNNER = /(^|[\s|(])(ssh|sh|bash|zsh|dash|ksh|fish|eval|su|docker|podman|kubectl|nsenter|chroot)(\s|$)/;

// Commands whose quoted arguments are what a rule judges — rm's paths
// (home-rm), cat's file (env-dump): in a pipeline they lead, the quotes stay
// as typed for the rule's own reading, `rm -rf "$DIR"` naming $DIR and
// `cat "$ROOT/.env.local"` the file; in every other pipeline the same words
// inside a grep pattern or a commit message are data (YM-160).
const TARGETS = /(^|[\s|(])(rm|cat)(\s|$)/;

// The index of the quote closing the one at `i`, or the text's length when
// none does; inside double quotes a backslash escapes the next character.
function closingQuote(text: string, i: number): number {
  const q = text[i];
  let j = i + 1;
  while (j < text.length && text[j] !== q) j += q === '"' && text[j] === "\\" ? 2 : 1;
  return j;
}

// One pipeline: its quoted spans emptied (`data`), opened as commands
// (`command`) or left as typed (`keep`); `open` rides into the nested
// commands.
function quotedSpans(text: string, mode: "data" | "command" | "keep", open?: RegExp): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      out += text.slice(i, i + 2);
      i += 2;
    } else if (c === '"' || c === "'") {
      const j = closingQuote(text, i);
      const inner = text.slice(i + 1, j);
      const closed = j < text.length;
      if (mode === "keep") out += text.slice(i, j + 1);
      else if (mode === "command" || (c === '"' && inner.includes("$(")))
        out += ";" + outsideQuotes(inner, open) + (closed ? ";" : "");
      else out += closed ? c + c : c;
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

// The command with its quoted spans judged per pipeline: opened under a
// RUNNER, kept as typed under a command `open` names (TARGETS for the rules
// that read arguments), emptied everywhere else.
function outsideQuotes(cmd: string, open?: RegExp): string {
  let out = "";
  let pipeline = "";
  const flush = () => {
    const data = quotedSpans(pipeline, "data", open);
    out += RUNNER.test(data)
      ? quotedSpans(pipeline, "command", open)
      : open?.test(data)
        ? quotedSpans(pipeline, "keep", open)
        : data;
    pipeline = "";
  };
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === "\\") {
      pipeline += cmd.slice(i, i + 2);
      i += 2;
    } else if (c === '"' || c === "'") {
      const j = closingQuote(cmd, i);
      pipeline += cmd.slice(i, j + 1);
      i = j + 1;
    } else if (c === ";" || c === "\n" || c === "&" || (c === "|" && cmd[i + 1] === "|")) {
      flush();
      const sep = c === "|" ? "||" : c;
      out += sep;
      i += sep.length;
    } else {
      pipeline += c;
      i += 1;
    }
  }
  flush();
  return out;
}

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

  if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
    const path = input.file_path ?? input.notebook_path;
    if (paneled && own) {
      const fenced = [
        join(own.root, ".pi", "settings.json"),
        join(own.root, ".pi", "settings.local.json"),
        ...(own.ticket
          ? [
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

  const unquoted = outsideQuotes(cmd);
  if (WAIT.some((r) => r.test(unquoted)))
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
