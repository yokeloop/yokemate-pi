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

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { dataRoot as dataRootOf } from "./data-root.ts";
import { RuntimeSettingsError, readRuntimeSettings, type RuntimeSettings } from "./guard-policy.ts";
import { assertMandatoryBoundary, WorkflowBoundaryError } from "./workflow-boundaries.ts";

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
const SHIP_MERGE_BYPASS = [
  /\bgh\s+pr\s+merge(?:\s|$)/,
  /\bgh\s+api\b[^|;&\n]*(?:repos\/[^/\s]+\/[^/\s]+\/pulls\/[^/\s]+\/merge|\/pulls\/[^/\s]+\/merge|mergePullRequest)\b/,
  /\b(?:curl|wget)\b[^|;&\n]*(?:(?:api\.github\.com|uploads\.github\.com)[^|;&\n]*\/pulls\/[^/\s]+\/merge|mergePullRequest)\b/,
  /\bpnpm\s+(?:run\s+)?ship-merge\b/,
  /\bnode\b[^|;&\n]*\bship-merge(?:\.ts|\.js)?\b/,
];

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
  /(^|[;&|(]\s*)pnpm\s+(run\s+)?(spawn|plan|stage|accept|drop|record-report|ship|adopt|ready|close-mode|add-project|set-model|import-projects|pr-link)\b/,
  /\bgh\s+gist\s+create\b[^|;&\n]*--public\b/,
];

const HOME_PATH = /(~\/|\$HOME\/|\/home\/[a-z_][a-z0-9_-]*\/)/;
const DOWNLOADS = /(~|\$HOME|\/home\/[a-z_][a-z0-9_-]*)\/Downloads\//;

function inYokemateTree(cmd: string, own?: { root: string; home?: string }): boolean {
  if (!own) return false;
  const variants = [own.root + "/"];
  if (own.home && own.root.startsWith(own.home + "/")) {
    const rest = own.root.slice(own.home.length);
    variants.push("~" + rest + "/", "$HOME" + rest + "/");
  }
  return variants.some((v) => cmd.includes(v));
}

interface PackageScope { root: string; cwd?: string; ticket?: string; project?: string }
interface PackageSegment { words: string[]; dynamic: boolean; substitution: boolean; next: string }

const ENGINE_OPERATIONS = new Set(["where", "ready", "gate", "record-report", "pr-link", "ship", "review", "spawn", "close-mode"]);
const PACKAGE_MANAGER = /^(?:.*\/)?(?:npm|pnpm)$/;
const PACKAGE_TEXT = /\b(?:npm|pnpm)\b/;
const PACKAGE_DATA = new Set(["echo", "printf", "grep", "rg", "git"]);

function packageSegments(command: string): { segments: PackageSegment[]; unsupported: boolean } {
  const segments: PackageSegment[] = [];
  let words: string[] = [], word = "", started = false, dynamic = false, substitution = false, unsupported = false;
  let quote = "";
  const endWord = () => { if (started) words.push(word); word = ""; started = false; };
  const end = (next: string) => { endWord(); segments.push({ words, dynamic, substitution, next }); words = []; dynamic = false; substitution = false; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote !== "'" && (c === "`" || (c === "$" && command[i + 1] === "("))) substitution = true;
    if (c === "\\" && quote !== "'") {
      started = true;
      const next = command[++i];
      if (next === undefined) unsupported = true;
      else if (next !== "\n") {
        if (quote === '"' && !['$', '`', '"', "\\"].includes(next)) word += "\\";
        word += next;
      }
    } else if (quote) {
      if (c === quote) quote = "";
      else { word += c; if (quote === '"' && /[$`]/.test(c)) dynamic = true; }
    } else if (c === "'" || c === '"') { quote = c; started = true; }
    else if (c === "#" && !started) { while (i + 1 < command.length && command[i + 1] !== "\n") i++; }
    else if (c === ";" || c === "\n" || c === "&" || c === "|") {
      const op = (c === "&" || c === "|") && command[i + 1] === c ? c + command[++i] : c;
      if (op === "&" || op === "|") unsupported = true;
      end(op);
    } else if (/\s/.test(c)) endWord();
    else {
      if (/[()<>{}]/.test(c)) unsupported = true;
      if (/[$`*?\[~]/.test(c)) dynamic = true;
      word += c; started = true;
    }
  }
  if (quote) unsupported = true;
  end("");
  return { segments, unsupported };
}

function packageTargetVerdict(command: string, own?: PackageScope): Verdict | null {
  let allowed = "the assigned root/work/<TICKET>/<repo>";
  const deny = (detail: string): Verdict => ({ decision: "deny", reason: `workflow.assigned-scope: package target refused: ${detail}. Use cd '${allowed}' && npm test, npm --prefix '${allowed}' test, or pnpm --dir '${allowed}' test; for pnpm install without an owned workspace add --ignore-workspace. Use literal paths and separate unsupported shell forms.` });
  try {
    const { segments, unsupported } = packageSegments(command);
    const detected = (s: PackageSegment) => PACKAGE_MANAGER.test(s.words[0] ?? "") ||
      (s.substitution && PACKAGE_TEXT.test(s.words.join(" "))) ||
      (!PACKAGE_DATA.has(s.words[0] ?? "") && s.words.some((w) => PACKAGE_MANAGER.test(w.replace(/^[({]+|[)}]+$/g, "")))) ||
      (!PACKAGE_DATA.has(s.words[0] ?? "") && s.words.some((w) => RUNNER.test(w)) && s.words.some((w) => PACKAGE_TEXT.test(w))) ||
      (unsupported && segments.some((p) => /^(?:sh|bash|zsh|eval)$/.test(p.words[0] ?? "")) && s.words.some((w) => PACKAGE_TEXT.test(w)));
    if (!segments.some(detected)) return null;
    if (!own || typeof own.cwd !== "string" || !isAbsolute(own.cwd) || !/^[A-Z][A-Z0-9]*-\d+$/.test(own.ticket ?? "")) return deny("missing or malformed host cwd/ticket");
    const projects: unknown = JSON.parse(own.project ?? "null");
    if (!Array.isArray(projects) || !projects.length || !projects.every((p) => typeof p === "string" && /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(p))) return deny("missing or malformed assigned projects");
    const root = realpathSync(own.root);
    const parts = projects.map((p: string) => join(root, "work", own.ticket!, p.split("/")[1]!));
    if (new Set(parts).size !== parts.length) return deny("ambiguous assigned repository names");
    allowed = parts[0]!;
    const inside = (parent: string, path: string) => path === parent || path.startsWith(parent + sep);
    let cwd: string | undefined = realpathSync(own.cwd);
    if (!inside(root, cwd) || !statSync(cwd).isDirectory()) return deny("host cwd outside engine scope");
    if (unsupported || (segments.some((s) => s.words[0] === "cd") && segments.some((s) => s.next === "||"))) return deny("unsupported package shell syntax");
    const nearest = (start: string, file: string): string | undefined => {
      for (let dir = start; ; dir = dirname(dir)) {
        if (existsSync(join(dir, file))) return dir;
        if (dirname(dir) === dir) return undefined;
      }
    };
    let changedCwd = false, changedEnvironment = false;
    for (const segment of segments) {
      const words = [...segment.words];
      if (!words.length) continue;
      if (words[0] === "cd") {
        changedCwd = true;
        cwd = !segment.dynamic && words.length === 2 && cwd && segment.next === "&&" && !words[1]!.startsWith("-")
          ? realpathSync(resolve(cwd, words[1]!)) : undefined;
        if (cwd && !statSync(cwd).isDirectory()) cwd = undefined;
      } else if (detected(segment)) {
        if (!/^(npm|pnpm)$/.test(words[0]!) || segment.dynamic || changedEnvironment) return deny("unsupported or dynamic package invocation");
        const manager = words.shift()!;
        let target = cwd, explicit = false, operation = "", script = "", ignoreWorkspace = false;
        let i = 0;
        for (; i < words.length; i++) {
          const w = words[i]!;
          const pathFlag = manager === "npm" ? /^--prefix(?:=(.*))?$/ : /^(?:--dir|-C)(?:=(.*))?$/;
          const match = w.match(pathFlag);
          if (match) {
            const path = match[1] ?? words[++i];
            if (!path || path.startsWith("-") || explicit || (!cwd && !isAbsolute(path))) return deny("ambiguous package directory option");
            target = resolve(cwd ?? root, path); explicit = true; continue;
          }
          if (w === "--" && operation) { i++; break; }
          if (w.startsWith("-")) {
            if (!["--silent", "-s", "--if-present", "--ignore-scripts", "--frozen-lockfile", "--prod=false", "--offline", "--no-audit", "--no-fund", "--no", "--ignore-workspace"].includes(w)) return deny(`unsupported package option ${w}`);
            if (w === "--ignore-workspace") ignoreWorkspace = true;
            continue;
          }
          if (!operation) {
            operation = w;
            if (!["run", "run-script", "install", "ci", "exec"].includes(w)) script = w;
          } else if ((operation === "run" || operation === "run-script") && !script) script = w;
          else if (operation === "exec") break;
          else if (!script) return deny("unsupported install arguments");
          if (manager === "pnpm" && script) { i++; break; }
        }
        if (!target || !operation || ((operation === "run" || operation === "run-script") && !script)) return deny("unknown package cwd or operation");
        target = realpathSync(target);
        if (!statSync(target).isDirectory()) return deny("package cwd is not a directory");
        const pkg = nearest(target, "package.json");
        if (!pkg) return deny("no package manifest");
        const manifest = realpathSync(join(pkg, "package.json"));
        JSON.parse(readFileSync(manifest, "utf8"));
        if (!["run", "run-script", "install", "ci", "exec", "test", "build", "typecheck", "lint", "dev", "start", "serve", "preview"].includes(operation) && !ENGINE_OPERATIONS.has(operation)) return deny("unsupported package operation; use run <script> for other script names");
        const part = parts.find((p) => inside(p, target) && inside(p, pkg));
        if (!part) {
          if (pkg !== root || manifest !== join(root, "package.json") || !ENGINE_OPERATIONS.has(script)) return deny(`resolved package ${pkg} is not assigned`);
        } else {
          if (realpathSync(part) !== part || !inside(part, manifest)) return deny("symlink escapes assigned part");
          if (operation === "install" || operation === "ci") {
            if (manager === "pnpm" && !ignoreWorkspace) {
              const workspace = nearest(target, "pnpm-workspace.yaml");
              if (!workspace || !inside(part, realpathSync(join(workspace, "pnpm-workspace.yaml")))) return deny("pnpm install needs --ignore-workspace or a part-owned workspace");
            }
            if (manager === "npm" && !explicit) {
              for (let dir = dirname(pkg); ; dir = dirname(dir)) {
                const file = join(dir, "package.json");
                if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).workspaces && !inside(part, realpathSync(file))) return deny("ancestor npm workspace; select the part with --prefix");
                if (dir === dirname(dir)) break;
              }
            }
          }
          if (operation === "exec") {
            const bin = words[i];
            if (!bin || !/^[A-Za-z0-9_.-]+$/.test(bin) || PACKAGE_MANAGER.test(bin) || RUNNER.test(bin) || ["env", "command", "sudo", "xargs"].includes(bin)) return deny("exec needs a direct local tool, not a package manager or shell wrapper");
            if (!inside(part, realpathSync(join(pkg, "node_modules", ".bin", bin)))) return deny("exec requires a worktree-local binary");
          }
        }
      } else if (["export", "source", ".", "eval", "pushd", "popd"].includes(words[0]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) changedEnvironment = true;
      if (changedCwd && segment.next !== "&&" && segment.next !== "") cwd = undefined;
    }
    return null;
  } catch (e) {
    return deny(`target determination failed (${e instanceof Error ? e.message : String(e)})`);
  }
}

export function judge(
  mode: string | undefined,
  toolName: string,
  input: { command?: string; file_path?: string; notebook_path?: string },
  own?: { root: string; dataRoot: string; ticket?: string; home?: string; cwd?: string; project?: string },
  settings: RuntimeSettings = readRuntimeSettings(),
): Verdict | null {
  const paneled = mode !== undefined && mode !== "";
  assertMandatoryBoundary("workflow.assigned-scope", !!toolName && (!paneled || !!own?.root && !!own.dataRoot), "guard call has no owned scope");
  const { policy } = settings;
  const coding = mode === "do" || mode === "ship";
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
      if (policy.guards.settingsWrite && fenced.includes(path ?? ""))
        return {
          decision: "deny",
          reason:
            "Session configuration is not edited from a task pane. If the hook or the settings are wrong, report it to the orchestrator.",
        };
    }
    if (policy.guards.noteFileWrite && mode === "note" && own) {
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

  if (mode === "do") {
    const target = packageTargetVerdict(cmd, own);
    if (target) return target;
  }

  const unquoted = outsideQuotes(cmd);
  if (mode === "ship" && SHIP_MERGE_BYPASS.some((pattern) => pattern.test(unquoted) || pattern.test(cmd)))
    return {
      decision: "deny",
      reason: "ship merge authority belongs to the live parent coordinator; direct CLI or API merge paths are forbidden. Use coordinator_merge.",
    };
  if (policy.guards.wait && WAIT.some((r) => r.test(unquoted)))
    return {
      decision: "deny",
      reason:
        "Waiting is forbidden: a finished subagent returns its result as the tool result, and completion comes to the session on its own. Check the condition once, without sleep, and keep working.",
    };

  if (policy.guards.noteShellWrite && mode === "note") {
    const scrubbed = unquoted.replace(/\d*>>?\s*(&\d+|\/dev\/\S+)/g, "").replace(/[=<-]>/g, "");
    if (NOTE_WRITE.some((r) => r.test(unquoted)) || />/.test(scrubbed))
      return {
        decision: "deny",
        reason:
          "Панель /note read-only: сохранение — Write в home/notes/ + pnpm note-save, выгрузка — gh gist create (secret). Остальное — в главный чат.",
      };
  }

  if (policy.guards.codingLaunch && coding && LAUNCH.some((r) => r.test(unquoted)))
    return {
      decision: "deny",
      reason:
        "Nothing long-running starts while coding: no dev servers, no app launches, no browsers. Only commands that finish on their own — build, lint, typecheck, unit tests. The live application is /review's job.",
    };

  if (policy.guards.massKill && onStand && KILL.some((r) => r.test(unquoted)))
    return {
      decision: "deny",
      reason:
        "Kill only processes you started, by their saved PID: kill $PID. Blanket kills reach the engineer's own processes.",
    };

  const targets = outsideQuotes(cmd, TARGETS);
  if (
    policy.guards.homeDelete &&
    onStand &&
    /\brm\b/.test(targets) &&
    HOME_PATH.test(targets) &&
    !DOWNLOADS.test(targets) &&
    !inYokemateTree(targets, own)
  )
    return {
      decision: "deny",
      reason:
        "Your writable world is the task worktrees and knowledge/…/ai/. The engineer's home directory is not ours to change (~/Downloads on the engineer's word is the one exception).",
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
        cwd: process.cwd(),
        project: process.env.YOKEMATE_PROJECT,
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
    } catch (e) {
      if (e instanceof RuntimeSettingsError || (process.env.YOKEMATE_MODE === "do" && e instanceof WorkflowBoundaryError))
        console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: e.message } }));
    }
    process.exit(0);
  });
}
