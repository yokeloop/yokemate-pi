import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { dataRoot } from "./data-root.ts";
import { commitExact, gitMutationLockPath, pushWithRetryAsync, type ExactSyncResult } from "./git-sync.ts";
import { logMoveDetailed } from "./move-log.ts";

export interface ShipFinalizeResult { journal: { line: string; path: string; repeated: boolean }; localSync: ExactSyncResult; push: ExactSyncResult; cleanup: "removed" | "already_absent" }

function existingOutcome(home: string, ticket: string): { line: string; path: string } | undefined {
  const directory = join(home, "journal");
  if (!existsSync(directory)) return;
  const pattern = new RegExp(`^- \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} ${ticket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} отгружено$`, "m");
  for (const name of readdirSync(directory).filter((item) => /^\d{4}-\d{2}\.md$/.test(item)).sort().reverse()) {
    const path = join(directory, name);
    const match = readFileSync(path, "utf8").match(pattern);
    if (match) return { line: match[0], path };
  }
}

function finalizeJournal(home: string, ticket: string): Omit<ShipFinalizeResult, "push" | "cleanup"> {
  const prior = existingOutcome(home, ticket);
  const written = prior ?? logMoveDetailed(home, ticket, "отгружено");
  if (!written) throw new Error("ship outcome journal append failed");
  const path = relative(home, written.path);
  return { journal: { ...written, repeated: Boolean(prior) }, localSync: commitExact(home, `Log ${ticket} shipped`, [path]) };
}

function lockedFinalize(home: string, ticket: string): Promise<Omit<ShipFinalizeResult, "push" | "cleanup">> {
  return new Promise((resolvePromise, reject) => {
    const lock = gitMutationLockPath(home);
    mkdirSync(dirname(lock), { recursive: true });
    const payload = Buffer.from(JSON.stringify({ home, ticket })).toString("base64");
    execFile("flock", ["--exclusive", lock, process.execPath, "--experimental-strip-types", "--no-warnings", import.meta.filename, "--locked", payload], { cwd: home, encoding: "utf8" }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolvePromise(JSON.parse(stdout)));
  });
}

export async function finalizeShip(root: string, ticket: string): Promise<ShipFinalizeResult> {
  const home = dataRoot(root);
  const journal = await lockedFinalize(home, ticket);
  const push = journal.localSync.state === "committed" || journal.localSync.state === "unchanged" ? await pushWithRetryAsync(home) : journal.localSync;
  const task = join(root, "work", ticket);
  const cleanup = existsSync(task) ? (rmSync(task, { recursive: true, force: true }), "removed" as const) : "already_absent" as const;
  return { ...journal, push, cleanup };
}

if (import.meta.filename === process.argv[1] && process.argv[2] === "--locked") {
  try {
    const payload = JSON.parse(Buffer.from(process.argv[3] ?? "", "base64").toString("utf8")) as { home: string; ticket: string };
    process.stdout.write(JSON.stringify(finalizeJournal(payload.home, payload.ticket)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
