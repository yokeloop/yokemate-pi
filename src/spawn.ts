// Launch a task tab: herdr tab in work/<TICKET>/ running an interactive
// claude session named after the ticket. The tab does the work and records its
// own result (`pnpm record-report`) when the PRs are open; this script makes
// the one move that belongs to the launcher — stage → running.
//
// This is the orchestrator's tool, not the engineer's: the engineer types
// `/do ACME-347` in the main chat and the skill runs this.
//
// Usage:
//   pnpm spawn ACME-347                          # plan taken from the ticket's row
//   pnpm spawn ACME-347 --plan <path>            # or named outright
//   pnpm spawn ACME-347 --model <m>              # overrides the passport's model

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDb } from "./db.ts";
import { modelForTicket } from "./project-model.ts";
import { ticketUrl } from "./ticket-url.ts";
import { linkTeammates } from "./teammates.ts";
import { findRunningAgent, herdr, startAgent } from "./herdr.ts";
import { applyMove, checkMove, type From, type MoveEnv } from "./transitions.ts";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

if (process.env.HERDR_ENV !== "1") fail("not inside a herdr session — open the main chat in herdr first");
if (process.env.YOKEMATE_MODE)
  fail(`spawn runs in the main chat only — this pane is stamped ${process.env.YOKEMATE_MODE}`);

// The pane this command runs in — the chat that asked for the tab. The tab
// lands in its workspace, and the task's inbox report goes back to it by pane
// id (see src/inbox.ts).
const parentPane = process.env.HERDR_PANE_ID;
if (!parentPane) fail("no HERDR_PANE_ID — spawn runs from the main chat's own pane");
const parentWorkspace = process.env.HERDR_WORKSPACE_ID ?? parentPane.split(":")[0];

const argv = process.argv.slice(2).filter((a) => a !== "--");
const ticket = argv[0] ?? fail("usage: spawn <TICKET> [--plan <path-to-plan.md>] [--model <m>]");
let planArg: string | undefined;
let model: string | undefined;
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === "--plan") planArg = argv[++i];
  else if (argv[i] === "--model") model = argv[++i] ?? fail("--model needs a value");
  else fail(`unknown argument ${argv[i]} — known: --plan <path>, --model <m>`);
}

const db = openDb(join(ROOT, "yokemate.db"));

// The launch never inherits the machine's default: the engineer's --model
// wins, else the ticket's passports answer (YM-84).
if (!model) {
  try {
    model = modelForTicket(db, ticket);
  } catch (e) {
    model = fail((e as Error).message);
  }
}

// /do always receives a ready plan (R4.2), but the engineer says `/do ACME-347`
// and nothing else: the path was already recorded when the plan was written,
// so ask the row before asking the engineer.
const recorded = (
  db.prepare("SELECT plan FROM work WHERE ticket = ?").get(ticket) as { plan: string | null } | undefined
)?.plan;
const plan = planArg ?? recorded ?? fail(
  `${ticket} has no plan on record — write one with /plan, or pass --plan <path>`,
);
const planAbs = resolve(plan);
if (!existsSync(planAbs)) fail(`plan not found: ${planAbs}`);

// The move is checked before any tab exists: a refused launch must fail here,
// in one line, not leave an empty tab behind. The write itself happens after
// the agent is up — where the decision completes.
const env = process.env as MoveEnv;
{
  const cur =
    ((db.prepare("SELECT stage FROM work WHERE ticket = ?").get(ticket) as
      | { stage: string }
      | undefined)?.stage as From | undefined) ?? "absent";
  const v = checkMove("spawn", env, ticket, cur, { allowFresh: Boolean(planArg) });
  if (!v.ok) fail(v.refuse);
}

// Task folder. Worktrees inside it are created by the /do skill, not here.
const folder = join(ROOT, "work", ticket);
mkdirSync(folder, { recursive: true });

// Session settings for the tab: inbound messages accepted without a dialog
// (nobody watches the tab's dialogs), the stop guard that blocks a silent
// finish until the report is sent, and the same PreToolUse guard the root
// settings wire — the tab lives in its own project root and never sees the
// repository's .claude/settings.json, so the rules are written here too.
mkdirSync(join(folder, ".claude"), { recursive: true });
const guard = `node --experimental-strip-types --no-warnings ${ROOT}/src/bash-guard.ts`;
writeFileSync(
  join(folder, ".claude", "settings.json"),
  JSON.stringify(
    {
      // Cross-session messaging itself is switched on globally, in the user's
      // ~/.claude/settings.json (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS). Not
      // duplicated here: the tab inherits the flag like any session.
      crossSessionInbound: "accept",
      enabledPlugins: {
        "yoke@yoke": false,
        "mattpocock-skills@claude-plugins-official": false,
      },
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: guard }] },
          { matcher: "Write|Edit", hooks: [{ type: "command", command: guard }] },
          { matcher: "mcp__claude-in-chrome__.*", hooks: [{ type: "command", command: guard }] },
        ],
        Stop: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: `node --experimental-strip-types --no-warnings ${ROOT}/src/report-guard.ts`,
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  ),
);

// The tab's teammates (R4.4) — linked into the task folder, never into the
// engineer's home directory.
linkTeammates(join(ROOT, ".claude", "skills", "do", "agents"), join(folder, ".claude", "agents"));

// Tab in herdr, agent named after the ticket (lowercase per herdr's rules).
// The env stamp is how /do inside the tab knows it is inside the tab and not
// in the main chat, where the same skill only raises this tab (R4.21).
const agentName = ticket.toLowerCase().replace(/[^a-z0-9_-]/g, "-");

// A second launch of a ticket already running is a forgotten tab, not a wish
// for two: the agent's name is the one string that holds across surfaces.
const agents = (
  herdr(["agent", "list"]) as { result: { agents: { name?: string; pane_id: string }[] } }
).result.agents;
const running = findRunningAgent(agents, agentName);
if (running)
  fail(`${ticket} already runs in pane ${running} — go to it, or close it and launch again`);

// Passports for the repositories the plan mentions: clone path (worktrees fork
// from it) and the org's Figma MCP when the ticket touches design.
const planText = readFileSync(planAbs, "utf8");
const passports = (
  db.prepare("SELECT org, repo, path, figma_mcp, figma_url FROM project").all() as unknown as {
    org: string;
    repo: string;
    path: string;
    figma_mcp: string | null;
    figma_url: string | null;
  }[]
).filter((p) => planText.includes(p.repo));
const passportLines = passports
  .map(
    (p) =>
      `- ${p.org}/${p.repo}: clone at ${p.path}` +
      (p.figma_mcp ? `, Figma MCP ${p.figma_mcp}` : "") +
      (p.figma_url ? `, design file ${p.figma_url}` : ""),
  )
  .join("\n");

const prompt =
  `/do-worker ${ticket}. The plan is at ${planAbs} — read it fully; it lists the affected ` +
  `repositories and the contract between parts. Work only inside ${folder}. ` +
  (passportLines ? `Project passports (worktrees fork from these clones):\n${passportLines}\n` : "") +
  `When the PRs are open and green, run \`pnpm record-report ${ticket} --part ` +
  `<org/repo>:<role>:<branch>:<pr-url>\` from the task folder root yourself, then message ` +
  `the orchestrator — the message is a courtesy, the stage is already recorded.`;

const created = herdr([
  "tab", "create", "--workspace", parentWorkspace, "--cwd", folder, "--label", ticket,
  "--env", `YOKEMATE_MODE=do`, "--env", `YOKEMATE_TICKET=${ticket}`,
  "--env", `YOKEMATE_PARENT_PANE=${parentPane}`,
]) as {
  result: { tab: { tab_id: string }; root_pane: { pane_id: string } };
};
const pane = created.result.root_pane.pane_id;

// From here on the tab exists: anything that throws has to take it back down
// by the id herdr just gave us, or the workspace fills up with empty tabs.
try {
  // The tab works unattended: nobody sits at its permission dialogs. Yolo mode;
  // the blast radius is the task worktrees — the engineer's clones are never
  // switched — and the PreToolUse guard above fences the rest.
  startAgent(agentName, pane, ticket, ["--model", model]);
  herdr(["agent", "prompt", agentName, prompt]);
} catch (e) {
  // The failure to report is the launch's, not the cleanup's.
  try { herdr(["tab", "close", created.result.tab.tab_id]); } catch {}
  fail(`${ticket}: ${(e as Error).message.split("\n").slice(0, 2).join(" ")}`);
}

// The launch's own move: stage → running, checked and written atomically. A
// ticket launched before it ever hit the queue gets its row now — the row
// cannot not exist while a tab is running.
const moved = applyMove(
  db,
  "spawn",
  env,
  ticket,
  () => {
    db.prepare(
      `INSERT INTO work (ticket, url, stage) VALUES (?, ?, 'running')
       ON CONFLICT (ticket) DO UPDATE SET stage = 'running'`,
    ).run(ticket, ticketUrl(db, ticket));
    db.prepare(
      `UPDATE work SET folder = ?, plan = ?, updated_at = datetime('now') WHERE ticket = ?`,
    ).run(folder, planAbs, ticket);
  },
  { allowFresh: Boolean(planArg) },
);
if (!moved.ok) fail(`${ticket}: the tab is up, but the stage write was refused — ${moved.refuse}`);

console.log(`${ticket} → tab ${pane}, agent "${agentName}", stage running`);
