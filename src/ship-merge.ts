import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { gate } from "./gate.ts";
import { runWithShipLock } from "./ship-merge-lock.ts";

interface Snapshot { baseRefName: string; headRefOid: string; url: string }
interface Input { ticket: string; url: string; method: "merge" | "squash" | "rebase"; lockRemote?: string; lockBase?: string }

function run(command: string, args: string[], cwd: string): { exit: number; output: string } {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return { exit: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function snapshot(root: string, url: string): Snapshot {
  const result = run("gh", ["pr", "view", url, "--json", "baseRefName,headRefOid,url"], root);
  if (result.exit !== 0) throw new Error(result.output || `cannot inspect ${url}`);
  const value = JSON.parse(result.output) as Partial<Snapshot>;
  if (!value.baseRefName || !/^[0-9a-f]{40}$/.test(value.headRefOid ?? "") || !value.url) throw new Error(`incomplete PR snapshot for ${url}`);
  return value as Snapshot;
}

export function remoteFromPr(url: string): string {
  const parsed = new URL(url);
  const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
  if (!owner || !repo) throw new Error(`cannot derive repository from PR URL ${url}`);
  return `${parsed.host}/${owner}/${repo}`;
}

export function mergeUnderLock(root: string, input: Input): string {
  const current = snapshot(root, input.url);
  const remote = remoteFromPr(current.url);
  if (input.lockRemote !== remote || input.lockBase !== current.baseRefName) throw new Error(`PR target changed before merge: ${remote}#${current.baseRefName}`);
  const verdict = gate(root, input.ticket);
  if (!verdict.ok) throw new Error(`gate: ${verdict.reason}`);
  const repo = remote.split("/").slice(1).join("/");
  if (verdict.heads[repo] !== current.headRefOid) throw new Error(`fresh gate head for ${repo} is ${verdict.heads[repo] ?? "missing"}, PR head is ${current.headRefOid}`);
  const merged = run("gh", ["pr", "merge", current.url, `--${input.method}`, "--match-head-commit", current.headRefOid], root);
  if (merged.exit !== 0) throw new Error(merged.output || `merge failed for ${current.url}`);
  return `${repo} ${current.headRefOid} merged`;
}

export async function shipMerge(root: string, input: Input): Promise<string> {
  const before = snapshot(root, input.url);
  const remote = remoteFromPr(before.url);
  const payload: Input = { ...input, lockRemote: remote, lockBase: before.baseRefName };
  const result = await runWithShipLock(root, remote, before.baseRefName, process.execPath, ["--experimental-strip-types", "--no-warnings", import.meta.filename, "--locked", JSON.stringify(payload)]);
  if (result.exit !== 0) throw new Error(result.output.trim() || `merge lock command failed for ${input.url}`);
  return result.output.trim();
}

function parse(argv: string[]): Input {
  const [ticket, url, methodFlag] = argv;
  const method = methodFlag?.replace(/^--/, "") as Input["method"];
  if (!ticket || !url || !["merge", "squash", "rebase"].includes(method)) throw new Error("usage: ship-merge <TICKET> <PR-URL> <--merge|--squash|--rebase>");
  return { ticket, url, method };
}

if (import.meta.filename === process.argv[1]) {
  try {
    const root = resolve(new URL("..", import.meta.url).pathname);
    if (process.argv[2] === "--locked") console.log(mergeUnderLock(root, JSON.parse(process.argv[3] ?? "{}") as Input));
    else console.log(await shipMerge(root, parse(process.argv.slice(2))));
  } catch (error) {
    console.error(`ship-merge: ${(error as Error).message}`);
    process.exit(1);
  }
}
