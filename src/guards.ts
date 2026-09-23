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
import { isAbsolute, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { judge } from "./bash-guard.ts";
import { dataRoot as dataRootOf } from "./data-root.ts";
import { RuntimeSettingsError, formatGuardPolicy, readRuntimeSettings, resolveRuntimeSettings } from "./guard-policy.ts";
import { stopVerdict } from "./report-guard.ts";
import { buildDigest } from "./warmup.ts";
import { classifyResearchCall, researchIdentity } from "./research-guard.ts";
import { assertMandatoryBoundary, WorkflowBoundaryError } from "./workflow-boundaries.ts";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

/** A pi tool call in the shape judge() reads; null — not a tool we guard. */
export function guardCall(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): { name: string; input: { command?: string; file_path?: string } } | null {
  if (toolName === "bash")
    return { name: "Bash", input: { command: input.command as string | undefined } };
  if (toolName === "write" || toolName === "edit" || toolName === "notebook_edit") {
    const p = input.path ?? input.notebook_path;
    return {
      name: toolName === "write" ? "Write" : toolName === "edit" ? "Edit" : "NotebookEdit",
      input: { file_path: typeof p === "string" ? resolve(cwd, p) : undefined },
    };
  }
  if (toolName === "mcp")
    return { name: `mcp__${input.server ?? ""}__${input.tool ?? ""}`, input: {} };
  return null;
}

/**
 * Что забор делает с вердиктом, зная вердикт предыдущего отстоя: `null` —
 * ничего; иначе доставить, и с триггером только когда вердикт сменился.
 * Повтор без триггера и делает цикл конечным: нет триггера — нет рана, нет
 * рана — нет следующего agent_settled. Сообщение при этом всё равно попадает
 * в транскрипт и в контекст модели, так что обязанность «таб не заканчивается,
 * не записав отчёт» остаётся видимой на каждом отстое.
 */
export function stopDelivery(
  last: string | null,
  reason: string | null,
): { content: string; triggerTurn: boolean } | null {
  if (!reason) return null;
  return { content: reason, triggerTurn: reason !== last };
}

export function groupScopeVerdict(toolName: string, input: Record<string, unknown>, cwd: string, env: NodeJS.ProcessEnv): string | null {
  const groupRole = env.YOKEMATE_GROUP_ROLE;
  if (!groupRole) return null;
  const paths = JSON.parse(env.YOKEMATE_GROUP_SCOPE_PATHS ?? "[]") as string[];
  const branches = JSON.parse(env.YOKEMATE_GROUP_SCOPE_BRANCHES ?? "[]") as string[];
  if (!Array.isArray(paths) || !Array.isArray(branches) || paths.some((value) => typeof value !== "string" || !isAbsolute(value)) || branches.some((value) => typeof value !== "string" || !value)) return "group work scope is malformed";
  const inside = (parent: string, value: string) => value === parent || value.startsWith(parent + sep);
  if (["write", "edit", "notebook_edit"].includes(toolName)) {
    const value = input.path ?? input.notebook_path;
    const target = typeof value === "string" ? resolve(cwd, value) : "";
    if (!target || !paths.some((scope) => inside(resolve(scope), target))) return "group write is outside the registered WorkScope";
  }
  if (toolName === "mcp") return "group execution cannot use an unscoped MCP effect; use the registered group control tools";
  if (toolName !== "bash") return null;
  const command = String(input.command ?? "");
  if (/\bgh\s+(?:pr\s+merge|api)\b|\b(?:curl|wget)\b|\b(?:pnpm\s+(?:run\s+)?ship-merge|node\b[^\n]*ship-merge)\b/.test(command)) return "group execution cannot bypass the trusted merge/effect handlers";
  if (/(^|[;&|]\s*)(?:sudo\s+)?(?:rm|mv|cp|mkdir|touch|tee)\b|\bsed\b[^\n;&|]*\s-(?:-in-place|[A-Za-z]*i)\b|(^|[^0-9])>>?/.test(command)) return "group shell writes are unscoped; use Write/Edit inside the registered WorkScope";
  if (/\bgit\b[^\n;&|]*\s(?:merge|rebase|cherry-pick)\b/.test(command)) return "group branches integrate only through the registered group handlers";
  const mutatingGit = /\bgit\b[^\n;&|]*\s(?:add|am|apply|commit|restore|reset|checkout|switch|push)\b/.test(command);
  if (mutatingGit && !paths.some((scope) => inside(resolve(scope), resolve(cwd)) || command.includes(scope))) return "group git mutation is outside the registered WorkScope";
  if (/\bgit\b[^\n;&|]*\spush\b/.test(command)) {
    if (groupRole === "parent" || /\s--(?:delete|mirror|all|force)(?:\s|$)/.test(command) || !branches.some((branch) => new RegExp(`(?:^|\\s)${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`).test(command)) || /\S+:\S+/.test(command)) return "group push must name only the registered source branch; integration and external refs are parent-owned effects";
  }
  return null;
}

export default function guards(pi: ExtensionAPI) {
  // Raw read-only handle, not openDb: a guard runs no DDL. Closed on the way
  // out — report-guard.ts leaves that to the process exit, an extension lives on.
  const readStage = (ticket: string): string | undefined => {
    const db = new DatabaseSync(join(ROOT, "yokemate.db"), { readOnly: true });
    try {
      return (
        db.prepare("SELECT stage FROM work WHERE ticket = ?").get(ticket) as
          | { stage: string }
          | undefined
      )?.stage;
    } finally {
      db.close();
    }
  };

  // No matcher in pi: the filter is the early exit inside the one handler,
  // exactly as bus.ts does it. The whole body is fenced by try/catch because a
  // throw from a tool_call handler kills the tool — the opposite of the policy
  // in the header.
  pi.on("tool_call", async (event, ctx) => {
    if (process.env.YOKEMATE_RESEARCH_ID) {
      try {
        const v = classifyResearchCall(researchIdentity(process.env, String((ctx as unknown as { sessionId?: string }).sessionId ?? "runtime")), event.toolName);
        if (!v.ok) return { block: true, reason: v.reason };
      } catch (e) {
        return { block: true, reason: `research guard failure: ${(e as Error).message}` };
      }
    }
    try {
      const settings = readRuntimeSettings(ROOT);
      const groupRefusal = groupScopeVerdict(event.toolName, event.input as Record<string, unknown>, ctx.cwd, process.env);
      if (groupRefusal) return { block: true, reason: groupRefusal };
      if (process.env.YOKEMATE_MODE === "do" && event.toolName === "bash")
        assertMandatoryBoundary("workflow.assigned-scope", typeof ctx.cwd === "string" && isAbsolute(ctx.cwd), "package operation needs an absolute host cwd; use cd '<assigned worktree>' && npm test");
      const call = guardCall(event.toolName, event.input as Record<string, unknown>, ctx.cwd);
      if (!call) return undefined;
      const callCwd = resolve(ctx.cwd);
      assertMandatoryBoundary("workflow.assigned-scope", callCwd === ROOT || callCwd.startsWith(ROOT + sep), "tool call cwd is outside the yokemate scope");
      const v = judge(process.env.YOKEMATE_MODE, call.name, call.input, {
        root: ROOT,
        dataRoot: dataRootOf(ROOT),
        ticket: process.env.YOKEMATE_TICKET,
        home: process.env.HOME,
        cwd: ctx.cwd,
        project: process.env.YOKEMATE_PROJECT,
      }, settings);
      if (!v) return undefined;
      if (v.decision === "deny") return { block: true, reason: v.reason };
      // The one ask judge() returns is a ship launch in the main chat. Without
      // a dialog to ask in, it does not go.
      const ok = ctx.hasUI ? await ctx.ui.confirm("Ship merges", v.reason) : false;
      return ok ? undefined : { block: true, reason: v.reason };
    } catch (e) {
      if (e instanceof RuntimeSettingsError || e instanceof WorkflowBoundaryError) return { block: true, reason: e.message };
      if (process.env.YOKEMATE_GROUP_ROLE) return { block: true, reason: `group scope guard failure: ${(e as Error).message}` };
      if (process.env.YOKEMATE_MODE === "ship" && event.toolName === "bash") return { block: true, reason: `ship merge guard failure: ${(e as Error).message}` };
      return undefined;
    }
  });

  // agent_settled, not agent_end: agent_end ends a low-level run pi may still
  // follow with a retry, a compaction or a queued continuation, while
  // agent_settled arrives when nothing more will run and the session idles —
  // so triggerTurn raises a new turn, which is what a blocking Stop was.
  //
  // Вердикт предыдущего отстоя. Переменная замыкания: она живёт ровно столько,
  // сколько сессия процесса (фабрика расширения зовётся один раз на загрузку),
  // и это ровно нужный срок — перезапущенный таб обязан получить толчок
  // заново. Тот же приём этажом ниже держит digestPending. Ни файла, ни
  // строки в БД: забор остаётся read-only.
  let lastVerdict: string | null = null;

  pi.on("agent_settled", () => {
    let malformed = false;
    let reason: string | null = null;
    try {
      const settings = readRuntimeSettings(ROOT);
      if (process.env.YOKEMATE_ROLE === "executor") return;
      reason = stopVerdict(process.env, readStage, settings);
    } catch (e) {
      if (e instanceof RuntimeSettingsError) {
        malformed = true;
        reason = stopVerdict(process.env, readStage, resolveRuntimeSettings(undefined));
        pi.sendMessage({ customType: "yokemate-guard-policy", content: e.message, display: true }, { deliverAs: "followUp", triggerTurn: false });
      } else return;
    }
    if (!reason) lastVerdict = null;
    const delivery = stopDelivery(lastVerdict, reason);
    lastVerdict = reason;
    if (!delivery) return;
    pi.sendMessage(
      { customType: "yokemate-stop-guard", content: delivery.content, display: true },
      { deliverAs: "followUp", triggerTurn: !malformed && delivery.triggerTurn },
    );
  });

  // The digest is handed to the first turn of the session and never again,
  // and it waits for the pull so it reads what the pull brought.
  let digestPending = false;
  let pulled: Promise<void> | undefined;

  // The same gate the CLI blocks of git-sync.ts and warmup.ts carry: a pane
  // neither pulls git nor prints the digest. It stands in the extension too,
  // because buildDigest is a direct import and raises no subprocess of its own.
  //
  // The handler starts the pull and returns: pi attaches the session's event
  // stream only once every session_start handler has resolved, and a report
  // arriving from a pane in the meantime would reach the model but never the
  // transcript. The first turn waits for the pull instead, below.
  pi.on("session_start", (event, ctx) => {
    if (process.env.YOKEMATE_ROLE === "executor" || process.env.YOKEMATE_MODE) return;
    if (event.reason !== "startup") return;
    digestPending = true;
    // ctx.ui is a getter that throws once the session is replaced or reloaded,
    // and this body outlives the handler: a reload inside the pull window would
    // make even the catch throw, and the detached promise reject with nobody
    // attached. Warning the engineer is never worth an unhandled rejection.
    const warn = (message: string): void => {
      try {
        ctx.ui.notify(message, "warning");
      } catch {}
    };
    pulled = (async () => {
      try {
        // A subprocess, not an import: syncPull is synchronous throughout and
        // would freeze pi's event loop. git-sync never fails by contract —
        // every trouble is a line on stderr and exit 0, and that line has to
        // reach the engineer.
        const r = await pi.exec(
          "node",
          ["--experimental-strip-types", "--no-warnings", join(ROOT, "src", "git-sync.ts"), "pull"],
          { cwd: ROOT, timeout: 60_000 },
        );
        if (r.stderr.trim()) warn(r.stderr.trim());
        if (r.code !== 0 || r.killed) warn("git-sync не отработал");
      } catch (e) {
        warn(`git-sync не отработал: ${(e as Error).message}`);
      }
    })();
  });

  // The result's message lands in the turn's messages — pi's counterpart of
  // Claude's additionalContext on SessionStart.
  pi.on("before_agent_start", async (event) => {
    let policyContext: string;
    try {
      policyContext = formatGuardPolicy(readRuntimeSettings(ROOT));
    } catch (e) {
      policyContext = `Guard policy error: ${(e as Error).message}. Optional settings were not read; immutable boundaries remain mandatory.`;
    }
    const systemPrompt = `${event.systemPrompt}\n\n${policyContext}`;
    if (!digestPending) return { systemPrompt };
    digestPending = false;
    await pulled;
    return {
      systemPrompt,
      message: {
        customType: "yokemate-warmup",
        content: `Warmup — состояние пула на старте сессии\n\n${buildDigest(ROOT, dataRootOf(ROOT))}`,
        display: true,
      },
    };
  });
}
