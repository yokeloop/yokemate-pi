import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { findPlan } from "./adopt.ts";
import { dataRoot } from "./data-root.ts";
import { openDb } from "./db.ts";
import { findRunningAgent, formatHerdrError, herdr, herdrRaw, startAgent } from "./herdr.ts";
import { poolModel } from "./pool.ts";
import { modelForOrg, modelForTicket } from "./project-model.ts";
import { processStarttime, requestCoordinator, resolveCoordinatorParent } from "./coordinator-control.ts";
import { researchAgentArgs, resolveResearchLaunch } from "./research-launch.ts";
import { checkModel, piList } from "./pi-model.ts";
import { readRuntimeSettings } from "./guard-policy.ts";
import { parseKeyList, parseShipArgs } from "./ship-args.ts";

function incompleteTerminalCapture(error: unknown): boolean {
  const cause = (error as Error & { cause?: NodeJS.ErrnoException }).cause;
  return cause?.code === "ENOBUFS" || /(?:maxBuffer|ENOBUFS)/i.test((error as Error).message);
}

export const MODES = ["plan", "review", "ship", "worklog", "note", "research"] as const;
export type Mode = (typeof MODES)[number];

/** The modes that may run before a ticket exists — everything else is keyed by
 *  one. A plan launch takes a key or a problem statement; only the key looks
 *  like one. A note launch takes a topic — never a key. */
export const TICKETLESS: readonly string[] = ["plan", "note", "research"];


import { openModeSurface, parseSurfaceArgs, type Surface, type SurfaceArgs } from "./mode-surface.ts";

export function resolvePlanTargets(parsed: SurfaceArgs): { ticket: string; workerWords: string[] }[] {
  const { keys, tail } = parseKeyList(parsed.words, true);
  if (keys.length && !tail.length)
    return keys.map((ticket) => ({ ticket, workerWords: [ticket, ...parsed.literal] }));
  return [{
    ticket: keys[0] ?? "",
    workerWords: [...parsed.words.flatMap((word) => parseKeyList([word], true).keys.length ? word.split("+") : [word]), ...parsed.literal],
  }];
}

export interface Launch {
  cwd: string;
  label: string;
  agentName: string;
  prompt: string;
  env: string[];
  surface: Surface;
  model?: string;
}

/** What the machine holds for a review ticket: the task folder, and the plan
 *  in knowledge when the folder is absent. Computed by the caller so the
 *  launch stays a pure decision. */
export interface StandFacts {
  folder: boolean;
  plan: boolean;
}

/**
 * Everything the launch is decided by, with no herdr in sight so it can be
 * tested. Review works the stand in the task folder's worktrees, but its pane
 * sits at the root: the pane inherits the repository's own settings rather
 * than the task tab's. Ship takes one or several keys joined by `+` and walks
 * their task folders itself, so its tab runs at the root as well — no single
 * `work/<TICKET>` could hold it.
 *
 * A review ticket with no task folder is not a refusal: the stand is
 * rebuilt by `pnpm adopt` on a machine where /do never ran, so the pane
 * rises anyway and its prompt opens with the adopt instruction. Only a key
 * with neither folder nor plan in knowledge dies here — a mistyped key must
 * not raise a pane. Throws the refusal.
 *
 * `env` is what tells the skill inside the pane that it is inside the pane —
 * cwd cannot, because review and worklog share the root with the main chat
 * (see mode-guard.ts).
 */
export function resolveLaunch(
  root: string,
  mode: Mode,
  ticket: string,
  rest: string,
  model?: string,
  parentPane?: string,
  stand?: StandFacts,
  surface: Surface = "tab",
  workerWords = [...(ticket ? ticket.split("+") : []), ...(rest ? [rest] : [])],
): Launch {
  if (mode === "ship") throw new Error("ship runs in the background coordinator, not a tab");
  if (mode === "review" && stand && !stand.folder) {
    if (!stand.plan)
      throw new Error(
        `no task folder work/${ticket} and no plan in knowledge — mistyped key, or the ticket was never planned`,
      );
    rest = `стенда на этой машине нет — начни с \`pnpm adopt ${ticket}\`${rest ? `; ${rest}` : ""}`;
    workerWords = [ticket, rest];
  }
  const named = ticket ? `${ticket} ${mode}` : mode;
  const sanitize = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  let agentName = sanitize(named);
  if (agentName.length > 32) {
    const keys = ticket.split("+");
    agentName = sanitize(`${keys[0]}-plus${keys.length - 1}-${mode}`).slice(0, 32);
  }
  return {
    cwd: root,
    label: named,
    agentName,
    prompt: `/skill:${mode === "plan" ? "plan" : `${mode}-worker`}${workerWords.length ? ` ${workerWords.join(" ")}` : ""}`,
    env: [
      `YOKEMATE_MODE=${mode}`,
      ...(ticket ? [`YOKEMATE_TICKET=${ticket}`] : []),
      ...(parentPane ? [`YOKEMATE_PARENT_PANE=${parentPane}`] : []),
    ],
    surface,
    model,
  };
}

/**
 * The first free name in a counted series: `plan`, `plan-2`, `plan-3`. Only a
 * ticketless mode needs it — a ticketed mode's name is already unique per
 * ticket, and a second launch there is a forgotten pane, not a wish for two.
 */
export function freeAgentName(base: string, taken: Iterable<string>): string {
  const busy = new Set(taken);
  if (!busy.has(base)) return base;
  for (let n = 2; ; n++) if (!busy.has(`${base}-${n}`)) return `${base}-${n}`;
}

if (import.meta.filename === process.argv[1]) {
  const { resolve } = await import("node:path");
  const ROOT = resolve(new URL("..", import.meta.url).pathname);

  const fail = (msg: string): never => {
    console.error(msg);
    process.exit(1);
  };

  const policy = (() => { try { return readRuntimeSettings(ROOT).policy; } catch (e) { return fail((e as Error).message); } })();
  const argv = process.argv.slice(2);
  const mode = argv[0] as Mode;
  if (!MODES.includes(mode)) fail(`usage: <${MODES.join("|")}> <TICKET> [--model <m>] [rest…]`);

  if (mode === "research") {
    if (process.env.HERDR_ENV !== "1")
      fail("not inside a herdr session — open the main chat in herdr first");
    const parentPane = process.env.HERDR_PANE_ID ||
      fail("no HERDR_PANE_ID — a mode is launched from the chat's own pane");
    const parentWorkspace = process.env.HERDR_WORKSPACE_ID ?? parentPane.split(":")[0];
    let launch: ReturnType<typeof resolveResearchLaunch> | undefined;
    try {
      launch = resolveResearchLaunch(ROOT, argv.slice(1));
      const checked = checkModel(launch.model, piList);
      if (!checked.ok) fail(checked.reason);
    } catch (e) {
      fail((e as Error).message);
    }
    const research = launch ?? fail("research launch was not resolved");
    const agents = (herdr(["agent", "list"]) as { result: { agents: { name?: string }[] } }).result.agents;
    if (findRunningAgent(agents as { name?: string; pane_id: string }[], research.agentName))
      fail(`${research.label} already runs`);
    const opened = openModeSurface(research.surface, parentPane, parentWorkspace, ROOT, research.label,
      [...research.env, `YOKEMATE_PARENT_PANE=${parentPane}`]);
    let phase: "start" | "prompt" = "start";
    try {
      startAgent(research.agentName, opened.paneId, research.label, researchAgentArgs(ROOT, research.model));
      phase = "prompt";
      herdr(["agent", "prompt", research.agentName, research.prompt]);
    } catch (e) {
      const diagnostics = [`${research.label}: ${phase} failed; ${opened.tabId ? `tab ${opened.tabId}, ` : ""}pane ${opened.paneId}, agent ${research.agentName}`, formatHerdrError(e)];
      try {
        const terminal = herdrRaw(["pane", "read", opened.paneId, "--source", "recent-unwrapped", "--lines", "200", "--format", "text", "--raw"], { timeout: 2000, maxBuffer: 64 * 1024 });
        diagnostics.push(terminal ? `Pi terminal output:\n${terminal}` : "Pi terminal diagnostics were unavailable: pane read returned no output");
      } catch (capture) {
        diagnostics.push(`${incompleteTerminalCapture(capture) ? "Pi terminal diagnostics were incomplete; the available tail follows" : "Pi terminal diagnostics were unavailable"}:\n${formatHerdrError(capture)}`);
      } finally {
        try {
          opened.cleanup();
        } catch (cleanup) {
          diagnostics.push(`rollback could not close ${opened.tabId ? `tab ${opened.tabId} for ` : ""}pane ${opened.paneId}:\n${formatHerdrError(cleanup)}`);
        }
      }
      fail(diagnostics.join("\n"));
    }
    console.log(`/research → ${opened.tabId ? `tab ${opened.tabId}, ` : ""}pane ${opened.paneId}, agent "${research.agentName}", model ${research.model}, ${research.project ? `${research.project.org}/${research.project.repo}` : research.topic}`);
    process.exit(0);
  }

  let parsed: SurfaceArgs = { surface: "tab", words: [], literal: [] };
  let ticket: string;
  let tail: string[];
  let workerWords: string[] = [];
  if (mode === "ship") {
    ({ ticket, tail } = parseShipArgs(argv.filter((a) => a !== "--").slice(1)));
    if (!ticket) fail(`usage: ship <KEY> [<KEY> …] [--model <m>] [note]`);
  } else {
    try { parsed = parseSurfaceArgs(argv.slice(1)); } catch (e) { fail((e as Error).message); }
    workerWords = [...parsed.words, ...parsed.literal];
    if (mode === "plan") {
      ({ ticket, workerWords } = resolvePlanTargets(parsed)[0]!);
      tail = workerWords;
    } else if (mode === "note") {
      ticket = "";
      tail = workerWords;
    } else {
      ticket = parsed.words[0] ?? fail(`usage: ${mode} <TICKET> [--split] [--model <m>] [rest…]`);
      tail = [...parsed.words.slice(1), ...parsed.literal];
    }
  }

  if (mode === "ship") {
    let shipModel: string | undefined;
    const modelIndex = tail.indexOf("--model");
    if (modelIndex >= 0) {
      shipModel = tail[modelIndex + 1] ?? fail("--model needs a value");
      tail.splice(modelIndex, 2);
    }
    const sessionId = process.env.PI_SESSION_ID ?? fail("PI_SESSION_ID is required to route ship to its live coordinator parent");
    try {
      const parent = resolveCoordinatorParent(ROOT);
      const reply = await requestCoordinator(ROOT, { mode: "ship", tickets: ticket.split("+"), model: shipModel, note: tail.join(" ") || undefined }, { sessionId, pid: process.pid, starttime: processStarttime(process.pid) ?? fail("cannot read CLI process starttime"), cwd: ROOT, pane: process.env.HERDR_PANE_ID, parentPane: process.env.YOKEMATE_PARENT_PANE, mode: process.env.YOKEMATE_MODE, ticket: process.env.YOKEMATE_TICKET, role: process.env.YOKEMATE_ROLE }, parent);
      if (reply.state !== "accepted" || !reply.runId) fail(reply.reason ?? "ship coordinator launch was not accepted");
      console.log(`${ticket} → background run ${reply.runId}`);
      process.exit(0);
    } catch (error) { fail((error as Error).message); }
  }
  if (process.env.HERDR_ENV !== "1")
    fail("not inside a herdr session — open the main chat in herdr first");

  // The pane this command runs in — the chat that asked for the mode. The split
  // grows out of it, the tab lands in its workspace, and the mode's inbox
  // report goes back to it by pane id (see src/inbox.ts).
  const parentPane =
    process.env.HERDR_PANE_ID ||
    fail("no HERDR_PANE_ID — a mode is launched from the chat's own pane");
  const parentWorkspace = process.env.HERDR_WORKSPACE_ID ?? parentPane.split(":")[0];

  const targets = mode === "plan" ? resolvePlanTargets(parsed) : [{ ticket, workerWords }];
  for (const { ticket, workerWords } of targets) {
    try {
      let model = parsed.model;
      if (!model) {
        try {
          if (!ticket) {
            model = poolModel(dataRoot(ROOT), mode);
          } else {
            const db = openDb(join(ROOT, "yokemate.db"));
            try {
              model = mode === "worklog" ? modelForOrg(db, ticket, mode) : modelForTicket(db, ticket, mode);
            } finally { db.close(); }
          }
        } catch (e) {
          throw new Error(`${ticket || `/${mode}`}: ${(e as Error).message}`);
        }
      }

      let stand: StandFacts | undefined;
      if (mode === "review") {
        const folder = existsSync(join(ROOT, "work", ticket));
        stand = { folder, plan: folder || Boolean(findPlan(dataRoot(ROOT), ticket)) };
      } else if (mode === "ship") {
        for (const key of ticket.split("+")) {
          const taskFolder = join(ROOT, "work", key);
          if (!existsSync(taskFolder)) throw new Error(`no task folder ${taskFolder} — /ship runs after /do`);
        }
      }

      const launch = resolveLaunch(ROOT, mode, ticket, tail.join(" "), model, parentPane, stand, parsed.surface, workerWords);
      const { cwd, surface } = launch;
      const duplicateGuard = policy.guards.duplicateMode;
      const runId = ticket && !duplicateGuard ? randomUUID().replace(/-/g, "").slice(0, 8) : undefined;
      const prompt = launch.prompt + (runId ? ` Run ID: ${runId}. Include it in your final report.` : "");
      const env = [
        ...launch.env, "YOKEMATE_ROLE=coordinator",
        ...(mode === "plan" && parsed.literal.length ? [`YOKEMATE_PLAN_LITERAL=${JSON.stringify(parsed.literal)}`] : []),
        ...(runId ? [`YOKEMATE_RUN_ID=${runId}`] : []),
      ];
      let agentName = runId ? `${launch.agentName.slice(0, 23)}-${runId}` : launch.agentName;
      let label = runId ? `${launch.label} [${runId}]` : launch.label;

      const agents = (
        herdr(["agent", "list"]) as { result: { agents: { name?: string; pane_id: string }[] } }
      ).result.agents;

      if (!ticket) {
        agentName = freeAgentName(agentName, agents.map((a) => a.name ?? ""));
        label = agentName;
      } else {
        const running = findRunningAgent(agents, launch.agentName, { mode, ticket, cwd });
        if (duplicateGuard && running)
          throw new Error(`${label} already runs in pane ${running} — go to it, or close it and launch again`);
      }

      const opened = openModeSurface(surface, parentPane, parentWorkspace, cwd, label, env);
      const { paneId } = opened;
      try {
        startAgent(agentName, paneId, label, ["--model", model, "--skill", join(ROOT, ".pi", "skills")]);
        herdr(["agent", "prompt", agentName, prompt]);
      } catch (e) {
        try { opened.cleanup(); } catch {}
        throw new Error(`${label}: ${(e as Error).message.split("\n").slice(0, 2).join(" ")}`);
      }

      console.log(
        `${ticket || `/${mode}`} → ${opened.tabId ? `tab ${opened.tabId}, ` : ""}pane ${paneId}, agent "${agentName}", model ${model}, /${mode} in ${cwd}${runId ? `, run ${runId}` : ""}`,
      );
    } catch (e) {
      const message = (e as Error).message;
      console.error(mode === "plan" && ticket && !message.startsWith(ticket) ? `${ticket}: ${message}` : message);
      process.exitCode = 1;
    }
  }
}
