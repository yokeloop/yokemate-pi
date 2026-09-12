// Every mode gets its own agent (R4.21), on the surface its ending needs.
// `spawn` does this for /do because it also sets the stage and writes the tab's
// settings; review, ship and worklog need nothing but a pane with the right
// cwd and the mode's prompt.
//
// Ship ends by reporting and is closed from the main chat, so it takes a
// tab. Review and worklog end in a conversation with the engineer, so they
// split the main chat's own pane and stand under it — the engineer answers
// without leaving the chat that asked.
//
// This is the orchestrator's tool, not the engineer's: the engineer types
// `/review ACME-342` in the main chat and the skill runs this.
//
// /plan runs inline in the main chat by default; `pnpm split plan …` raises
// the same conversational split explicitly, for parallel plannings on a big
// screen (YM-96). The pane is prompted with the /plan skill itself — one
// skill, no worker — and its `run` verdict does the same inline work.
//
// Every mode takes a free-text note after the ticket and passes it verbatim
// into the mode's prompt. The model comes from the project's passport, by the
// mode of the panel being raised; an explicit `--model <m>` — the engineer's
// words, translated by the main chat — overrides it. A launch with no ticket
// has no passport to ask and takes its model from home/pool.json (YM-159). No
// launch inherits the machine's default (YM-84).
//
// Usage:
//   pnpm review ACME-342 [--model <m>] [note]
//   pnpm ship ACME-342 [ACME-343 …] [--model <m>] [note]
//   pnpm worklog acme [--model <m>] [note]
//   pnpm split plan [ACME-342|проблема] [--model <m>] [note]

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
import { readGuardPolicy } from "./guard-policy.ts";
import { parseShipArgs } from "./ship-args.ts";

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
const TICKET_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

/** Where the mode's agent goes: a tab of its own, or a split of the caller's pane. */
export type Surface = "tab" | "split";

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
): Launch {
  if (mode === "ship") throw new Error("ship runs in the background coordinator, not a tab");
  if (mode === "review" && stand && !stand.folder) {
    if (!stand.plan)
      throw new Error(
        `no task folder work/${ticket} and no plan in knowledge — mistyped key, or the ticket was never planned`,
      );
    rest = `стенда на этой машине нет — начни с \`pnpm adopt ${ticket}\`${rest ? `; ${rest}` : ""}`;
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
    prompt: `/skill:${mode === "plan" ? "plan" : `${mode}-worker`}${ticket ? ` ${ticket}` : ""}${rest ? ` ${rest}` : ""}`,
    env: [
      `YOKEMATE_MODE=${mode}`,
      ...(ticket ? [`YOKEMATE_TICKET=${ticket}`] : []),
      ...(parentPane ? [`YOKEMATE_PARENT_PANE=${parentPane}`] : []),
    ],
    surface: "split",
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
    const { tab, root_pane } = (herdr([
      "tab", "create", "--workspace", parentWorkspace, "--cwd", ROOT, "--label", research.label,
      ...[...research.env, `YOKEMATE_PARENT_PANE=${parentPane}`].flatMap((e) => ["--env", e]),
    ]) as { result: { tab: { tab_id: string }; root_pane: { pane_id: string } } }).result;
    let phase: "start" | "prompt" = "start";
    try {
      startAgent(research.agentName, root_pane.pane_id, research.label, researchAgentArgs(ROOT, research.model));
      phase = "prompt";
      herdr(["agent", "prompt", research.agentName, research.prompt]);
    } catch (e) {
      const diagnostics = [`${research.label}: ${phase} failed; tab ${tab.tab_id}, pane ${root_pane.pane_id}, agent ${research.agentName}`, formatHerdrError(e)];
      try {
        const terminal = herdrRaw(["pane", "read", root_pane.pane_id, "--source", "recent-unwrapped", "--lines", "200", "--format", "text", "--raw"], { timeout: 2000, maxBuffer: 64 * 1024 });
        diagnostics.push(terminal ? `Pi terminal output:\n${terminal}` : "Pi terminal diagnostics were unavailable: pane read returned no output");
      } catch (capture) {
        diagnostics.push(`${incompleteTerminalCapture(capture) ? "Pi terminal diagnostics were incomplete; the available tail follows" : "Pi terminal diagnostics were unavailable"}:\n${formatHerdrError(capture)}`);
      } finally {
        try {
          herdr(["tab", "close", tab.tab_id]);
        } catch (cleanup) {
          diagnostics.push(`rollback could not close tab ${tab.tab_id} for pane ${root_pane.pane_id}:\n${formatHerdrError(cleanup)}`);
        }
      }
      fail(diagnostics.join("\n"));
    }
    console.log(`/research → tab ${tab.tab_id}, pane ${root_pane.pane_id}, agent "${research.agentName}", model ${research.model}, ${research.project ? `${research.project.org}/${research.project.repo}` : research.topic}`);
    process.exit(0);
  }

  const normalizedArgv = argv.filter((a) => a !== "--");
  // A ticketless mode eats its first word as a key only when it looks like
  // one — anything else is already the note (a problem statement for plan).
  const ticketless = TICKETLESS.includes(mode);
  let ticket: string;
  let tail: string[];
  if (mode === "ship") {
    ({ ticket, tail } = parseShipArgs(normalizedArgv.slice(1)));
    if (!ticket) fail(`usage: ship <KEY> [<KEY> …] [--model <m>] [note]`);
  } else if (ticketless) {
    ticket = TICKET_KEY.test(normalizedArgv[1] ?? "") ? normalizedArgv[1] : "";
    tail = normalizedArgv.slice(ticket ? 2 : 1);
  } else {
    ticket = normalizedArgv[1] ?? fail(`usage: ${mode} <TICKET> [--model <m>] [rest…]`);
    tail = normalizedArgv.slice(2);
  }

  const policy = (() => { try { return readGuardPolicy(ROOT); } catch (e) { return fail((e as Error).message); } })();
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

  // The model is pulled out of the tail; everything else stays the note.
  let model: string | undefined;
  for (let i = 0; i < tail.length; i++) {
    if (tail[i] === "--model") {
      model = tail[i + 1] ?? fail("--model needs a value");
      tail.splice(i, 2);
      break;
    }
  }
  // The launch never inherits the machine's default: the engineer's --model
  // wins, else the passports answer by mode — by org for worklog, by key
  // prefix for every keyed mode. A launch with no key at all (a problem-input
  // plan, a note) has no passport to ask: home/pool.json answers, and a gap
  // there is a refusal, not a literal (YM-159).
  if (!model) {
    try {
      if (!ticket) {
        model = poolModel(dataRoot(ROOT), mode);
      } else {
        const db = openDb(join(ROOT, "yokemate.db"));
        model =
          mode === "worklog"
            ? modelForOrg(db, ticket, mode)
            : modelForTicket(db, ticket.split("+")[0], mode);
      }
    } catch (e) {
      model = fail((e as Error).message);
    }
  }

  // The folder is checked by its path, not by cwd: the panes sit at the root
  // while the stand lives in work/<TICKET>. Ship checks every key of its list
  // and still refuses without a folder; review hands the facts to the launch —
  // a missing folder with a plan in knowledge becomes an adopt run, not a
  // refusal (the plan glob is adopt's own helper).
  let stand: StandFacts | undefined;
  if (mode === "review") {
    const folder = existsSync(join(ROOT, "work", ticket));
    stand = { folder, plan: folder || Boolean(findPlan(dataRoot(ROOT), ticket)) };
  } else if (mode === "ship") {
    for (const key of ticket.split("+")) {
      const taskFolder = join(ROOT, "work", key);
      if (!existsSync(taskFolder)) fail(`no task folder ${taskFolder} — /ship runs after /do`);
    }
  }

  let launch: Launch;
  try {
    launch = resolveLaunch(ROOT, mode, ticket, tail.join(" "), model, parentPane, stand);
  } catch (e) {
    launch = fail((e as Error).message);
  }
  const { cwd, surface } = launch;
  const duplicateGuard = policy.guards.duplicateMode;
  const runId = ticket && !duplicateGuard ? randomUUID().replace(/-/g, "").slice(0, 8) : undefined;
  const prompt = launch.prompt + (runId ? ` Run ID: ${runId}. Include it in your final report.` : "");
  const env = [...launch.env, "YOKEMATE_ROLE=coordinator", ...(runId ? [`YOKEMATE_RUN_ID=${runId}`] : [])];
  let agentName = runId ? `${launch.agentName.slice(0, 23)}-${runId}` : launch.agentName;
  let label = runId ? `${launch.label} [${runId}]` : launch.label;

  const agents = (
    herdr(["agent", "list"]) as { result: { agents: { name?: string; pane_id: string }[] } }
  ).result.agents;

  // A ticketless launch's name is the bare mode, so the «one agent per mode per
  // ticket» guard would forbid a second launch outright. It takes the first free
  // name in the series instead; the guard stays for every keyed launch — a
  // keyed plan included.
  if (!ticket) {
    agentName = freeAgentName(agentName, agents.map((a) => a.name ?? ""));
    label = agentName;
  } else {
    const running = findRunningAgent(agents, launch.agentName, { mode, ticket, cwd });
    if (duplicateGuard && running)
      fail(`${label} already runs in pane ${running} — go to it, or close it and launch again`);
  }

  // `tab` carries the tab id (`w4:t6`); the pane inside it is where the agent goes.
  // A split answers with the new pane alone, and that pane is what gets taken back
  // down if anything below throws — the tab it lives in is the main chat's.
  let paneId: string;
  let undo: () => void;
  if (surface === "split") {
    const { pane } = (herdr([
      "pane", "split", parentPane, "--direction", "down", "--cwd", cwd,
      ...env.flatMap((e) => ["--env", e]),
    ]) as { result: { pane: { pane_id: string } } }).result;
    paneId = pane.pane_id;
    undo = () => void herdr(["pane", "close", paneId]);
  } else {
    const { tab, root_pane } = (herdr([
      "tab", "create", "--workspace", parentWorkspace, "--cwd", cwd, "--label", label,
      ...env.flatMap((e) => ["--env", e]),
    ]) as { result: { tab: { tab_id: string }; root_pane: { pane_id: string } } }).result;
    paneId = root_pane.pane_id;
    undo = () => void herdr(["tab", "close", tab.tab_id]);
  }

  // From here on the pane exists: anything that throws has to take it back down
  // by the id herdr just gave us, or the workspace fills up with empty panes.
  try {
    // Same posture as the task tab: nobody sits at this agent's permission
    // dialogs while it gathers facts. The engineer joins it to answer questions.
    startAgent(agentName, paneId, label, ["--model", model, "--skill", join(ROOT, ".pi", "skills")]);
    herdr(["agent", "prompt", agentName, prompt]);
  } catch (e) {
    // The failure to report is the launch's, not the cleanup's.
    try { undo(); } catch {}
    fail(`${label}: ${(e as Error).message.split("\n").slice(0, 2).join(" ")}`);
  }

  console.log(
    `${ticket || `/${mode}`} → pane ${paneId}, agent "${agentName}", model ${model}, /${mode} in ${cwd}${runId ? `, run ${runId}` : ""}`,
  );
}
