// Close a finished mode tab from the main chat — a tab never closes itself.
// The tab already recorded its own stage; its message to the main chat is the
// cue, and this command is the reaction: do closes on its report, ship
// writes no stage so its close is the same command — its ticket is the
// `+`-joined key string the worker's report names. Review and worklog live
// in splits and end in a conversation — they are the engineer's to close,
// never this command's.
//
// Usage: pnpm close-mode <ship|do> ACME-347

import { closeTab } from "./herdr.ts";

const CLOSABLE = ["ship", "do"] as const;
type Closable = (typeof CLOSABLE)[number];

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const argv = process.argv.slice(2).filter((a) => a !== "--");
const mode = argv[0] as Closable;
const ticket = argv[1];
let runId: string | undefined;
for (let i = 2; i < argv.length; i++) {
  if (argv[i] !== "--run") fail(`unknown argument ${argv[i]} — known: --run <run-id>`);
  runId = argv[++i] ?? fail("--run needs a run id");
}
if (!CLOSABLE.includes(mode) || !ticket)
  fail(`usage: close-mode <${CLOSABLE.join("|")}> <TICKET> — review and worklog are the engineer's to close`);
if (process.env.HERDR_ENV !== "1")
  fail("not inside a herdr session — open the main chat in herdr first");

// The task tab of /do is labelled by the bare ticket; mode tabs by `<TICKET> <mode>`.
let closed: string | undefined;
try {
  closed = closeTab(mode === "do" ? ticket : `${ticket} ${mode}`, runId);
} catch (e) {
  fail((e as Error).message);
}
console.log(closed ? `${ticket} ${mode} → tab ${closed} closed` : `${ticket} ${mode}: no open tab`);
