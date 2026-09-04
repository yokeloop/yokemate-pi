// "What's on me" — the one hardwired query across all YouTrack instances (R2.*).
// The query is exactly `Assignee: me`, nothing is ever appended to it (R2.2).
// Narrowing by org / project / status is LOCAL, over the already-fetched list (R2.5).
//
// Usage:
//   pnpm on-me                     all orgs
//   pnpm on-me acme           one org
//   pnpm on-me acme ACME       one project (tracker project key or its shortName)
//   pnpm on-me -- --repo acme-crm   one repository (through its subsystem)
//   pnpm on-me -- --all            drop `#Unresolved`: closed tickets too
//   pnpm on-me -- --stage "Ревью,Тест"  narrow by stage, localized or raw name
//   pnpm on-me -- --stages         what stages each project offers, with counts
//   pnpm on-me -- --verbose        show which status field was picked per project

import { join, resolve } from "node:path";
import { openDb } from "./db.ts";
import { githubProjects, listIssues, mine, viewerLogin } from "./github.ts";
import { trackers } from "./trackers.ts";
import { fetchAll, pickStatus, stageField, valueNames, QUERY, QUERY_ALL } from "./youtrack.ts";

interface Issue {
  org: string;
  project: string;
  repo: string | null;
  key: string;
  title: string;
  /** What the tracker prints — localized when the project has a translation. */
  status: string;
  /** What the tracker stores. Both are accepted by --stage, neither is mapped. */
  statusName: string;
  statusField: string;
}

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  let stage: string[] | undefined;
  let stages = false;
  let repo: string | undefined;
  let all = false;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") continue; // pnpm passes the separator through
    else if (argv[i] === "--stage") stage = argv[++i].split(",").map((s) => s.trim());
    else if (argv[i] === "--stages") stages = true;
    else if (argv[i] === "--repo") repo = argv[++i];
    else if (argv[i] === "--all") all = true;
    else if (argv[i] === "--verbose") verbose = true;
    else if (!argv[i].startsWith("--")) pos.push(argv[i]);
    else
      throw new Error(
        `unknown flag ${argv[i]} — known: --stage <values>, --stages, --repo <name>, ` +
          `--all, --verbose`,
      );
  }
  return { org: pos[0]?.toLowerCase(), project: pos[1]?.toUpperCase(), repo, all, stage, stages, verbose };
}

const args = parseArgs(process.argv.slice(2));

const configured = trackers();

// Which repository a ticket belongs to is a passport question, not a tracker
// one: several repositories can share one tracker project, and the only thing
// separating them there is a field value (acme: Subsystem). Repositories
// connected without such a value stay unattributed — better an honest dash than
// a guess.
const db = openDb(join(resolve(new URL("..", import.meta.url).pathname), "yokemate.db"));
const passports = db
  .prepare("SELECT org, repo, tracker, tracker_key, subsystem FROM project")
  .all() as unknown as {
    org: string; repo: string; tracker: string; tracker_key: string; subsystem: string | null;
  }[];

// GitHub Issues repositories answer for themselves, one `gh issue list` each —
// their org is the passport's, not a tracker in .env.local.
const ghProjects = githubProjects(db);

// The organization and its tracker carry one name (R0.12): `acme-eu` is the org
// of the clone's remote and the tracker in `.env.local` alike, so one argument
// needs no resolving.
const targets = args.org ? configured.filter((t) => t.name === args.org) : configured;
const ghTargets = args.org ? ghProjects.filter((p) => p.org === args.org) : ghProjects;
const sources = [...configured.map((t) => t.name), ...new Set(ghProjects.map((p) => p.org))];
if (args.org && targets.length === 0 && ghTargets.length === 0) {
  console.error(`no tracker named "${args.org}" — configured: ${sources.join(", ")}`);
  process.exit(1);
}
if (!args.org && sources.length === 0) {
  console.error("no tracker configured — no YT_<NAME>_URL in .env.local, no github passport");
  process.exit(1);
}

const issues: Issue[] = [];
const perTracker: Record<string, number> = {};

for (const t of targets) {
  const raw = await fetchAll(t, fetch, args.all ? QUERY_ALL : QUERY);
  perTracker[t.name] = raw.length;
  for (const r of raw) {
    const { status, name: statusName, field } = pickStatus(r);
    const project = r.project?.shortName ?? "?";
    const values = valueNames(r);
    const hit = passports.find(
      (p) =>
        p.subsystem !== null &&
        p.tracker === t.name &&
        p.tracker_key === project &&
        values.includes(p.subsystem),
    );
    issues.push({
      org: t.name,
      project,
      repo: hit?.repo ?? null,
      key: r.idReadable,
      title: r.summary,
      status,
      statusName,
      statusField: field,
    });
  }
}

// GitHub has no stage enum: the status is the issue's own state, open or
// closed, printed as it comes and never mapped to anything.
for (const p of ghTargets) {
  const raw = listIssues(p, args.all).filter((i) => mine(i, viewerLogin()));
  perTracker[p.org] = (perTracker[p.org] ?? 0) + raw.length;
  for (const i of raw) {
    const state = i.state.toLowerCase();
    issues.push({
      org: p.org,
      project: p.prefix,
      repo: p.repo,
      key: `${p.prefix}-${i.number}`,
      title: i.title,
      status: state,
      statusName: state,
      statusField: "state",
    });
  }
}

// Local narrowing only (R2.5) — the tracker query stays untouched.
let shown = issues;
if (args.project) shown = shown.filter((i) => i.project.toUpperCase() === args.project);
if (args.repo) shown = shown.filter((i) => i.repo === args.repo);
// Stage values are a per-project enum and are never mapped between projects
// (R2.4). Matching accepts what the tracker prints and what it stores, ignoring
// case: "Ревью", "Review" and "review" all reach the same tickets. A value no
// project offers is a typo, and an empty list is a worse answer than an error.
if (args.stage) {
  const want = new Set(args.stage.map((s) => s.toLowerCase()));
  const hit = shown.filter(
    (i) => want.has(i.status.toLowerCase()) || want.has(i.statusName.toLowerCase()),
  );
  if (hit.length === 0) {
    console.error(`no ticket sits in ${args.stage.map((s) => `"${s}"`).join(", ")}`);
    for (const line of await stageMenu(shown)) console.error(line);
    process.exit(1);
  }
  shown = hit;
}

/** What each project in the given set offers, with how many tickets sit where. */
async function stageMenu(set: Issue[]): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const i of set) {
    const id = `${i.org}/${i.project}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const t = configured.find((x) => x.name === i.org);
    if (!t) continue;
    const sf = await stageField(t, i.key);
    if (!sf) continue;
    const here = set.filter((x) => x.org === i.org && x.project === i.project);
    const cells = sf.values.map((v) => {
      const n = here.filter(
        (x) => x.status === v.label || x.statusName === v.name,
      ).length;
      return n ? `${v.label} ${n}` : v.label;
    });
    out.push(`${id}  ${sf.field}: ${cells.join(" · ")}`);
  }
  return out;
}

if (args.stages) {
  for (const line of await stageMenu(shown)) console.log(line);
  console.log(`\n${shown.length} issue(s) across ${new Set(shown.map((i) => `${i.org}/${i.project}`)).size} project(s)`);
  process.exit(0);
}

const byGroup = new Map<string, Issue[]>();
for (const i of shown) {
  const g = `${i.org} / ${i.project} / ${i.repo ?? "—"}`;
  (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(i);
}

const keyW = Math.max(0, ...shown.map((i) => i.key.length));
const titleW = Math.min(56, Math.max(0, ...shown.map((i) => i.title.length)));

for (const [group, list] of [...byGroup.entries()].sort()) {
  const field = args.verbose ? `   [status field: ${list[0].statusField}]` : "";
  console.log(`\n${group}${field}`);
  for (const i of list) {
    const title = i.title.length > titleW ? i.title.slice(0, titleW - 1) + "…" : i.title;
    console.log(`  ${i.key.padEnd(keyW)}  ${title.padEnd(titleW)}  ${i.status}`);
  }
}

// Counter line (R2.3): totals per tracker as fetched, before local narrowing.
const totals = Object.entries(perTracker)
  .map(([n, c]) => `${n} ${c}`)
  .join(" · ");
const narrowed = shown.length !== issues.length ? ` · shown ${shown.length}` : "";
const scope = args.all ? " · closed included" : "";
console.log(`\n${issues.length} issues (${totals})${narrowed}${scope}`);
