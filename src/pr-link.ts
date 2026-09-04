// Drop the PR link into the ticket as a comment. Run by the main chat after a
// report arrives. The write names its target in the output.
//
// Usage: pnpm pr-link ACME-347 https://github.com/org/repo/pull/34 [more-urls...]

import { join, resolve } from "node:path";
import { openDb } from "./db.ts";
import { postComment, ticketNumber } from "./github.ts";
import { trackers } from "./trackers.ts";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const argv = process.argv.slice(2).filter((a) => a !== "--");
const ticket = argv[0] ?? fail("usage: pr-link <TICKET> <pr-url> [pr-url...]");
const urls = argv.slice(1);
if (urls.length === 0) fail("at least one PR url is required");

// The tracker is found through the project passport by the ticket's key prefix.
const key = ticket.split("-")[0];
const db = openDb(join(ROOT, "yokemate.db"));
const proj = db
  .prepare("SELECT tracker, org, repo, path, tracker_key FROM project WHERE tracker_key = ? LIMIT 1")
  .get(key) as
  | { tracker: string; org: string; repo: string; path: string; tracker_key: string }
  | undefined;
if (!proj) fail(`no project with tracker key "${key}" — run add-project first`);

const text = urls.length === 1 ? `PR: ${urls[0]}` : `PRs:\n${urls.map((u) => `- ${u}`).join("\n")}`;

if (proj.tracker === "github") {
  postComment(
    { org: proj.org, repo: proj.repo, path: proj.path, prefix: proj.tracker_key },
    ticketNumber(ticket),
    text,
  );
  console.log(`${ticket}: PR link posted to github-${proj.org}/${proj.repo}`);
  process.exit(0);
}

const t = trackers().find((x) => x.name === proj.tracker);
if (!t) fail(`tracker "${proj.tracker}" is not configured in .env.local`);

const res = await fetch(`${t.baseUrl}/api/issues/${encodeURIComponent(ticket)}/comments?fields=id`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${t.token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  body: JSON.stringify({ text }),
});
if (!res.ok) fail(`${t.name}: HTTP ${res.status} commenting on ${ticket}`);

console.log(`${ticket}: PR link posted to youtrack-${t.name}`);
