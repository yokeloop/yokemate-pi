import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { authorizeResearchMutation, canonicalResearchTarget, researchIdentity, type ResearchIdentity } from "./research-guard.ts";
import { originOwnerRepo } from "./github.ts";

function parseArgv(command: string): string[] {
  if (/[|;&><`$()\\\n]/.test(command)) throw new Error("research bash accepts only a simple literal argv; use read/grep/find/ls or edit/write");
  const out: string[] = [];
  const re = /\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/gy;
  let offset = 0;
  while (offset < command.length) {
    re.lastIndex = offset;
    const match = re.exec(command);
    if (!match) throw new Error("research bash has invalid quoting");
    out.push(match[1] ?? match[2] ?? match[3]!);
    offset = re.lastIndex;
  }
  return out;
}

function execute(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((accept, reject) => execFile(command, args, {
    cwd, shell: false,
    env: { ...process.env, GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0", GIT_EXTERNAL_DIFF: "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : accept(stdout)));
}

function gitRead(args: string[]): boolean {
  if (args.join(" ") === "status --short" || args.join(" ") === "remote get-url origin") return true;
  if (args[0] === "log" && args.length === 4 && args[1] === "-n" && /^([1-9]|[1-9]\d|100)$/.test(args[2] ?? "") && args[3] === "--oneline") return true;
  if (args[0] !== "diff") return false;
  let index = 1;
  if (args[index] === "--stat") index++;
  if (index === args.length) return true;
  if (args[index++] !== "--" || index === args.length) return false;
  return args.slice(index).every((path) => path !== "" && !path.startsWith("-") && !path.split(/[\\/]/).includes(".."));
}

const ghFields = new Set(["number,title,state,url,body", "number,title,state,url", "number,title,state,url,author"]);
function ghBounded(args: string[], identity: ResearchIdentity): Promise<string> | null {
  if (process.env.YOKEMATE_RESEARCH_TRACKER !== "github" || !identity.projectPath) return null;
  const remote = originOwnerRepo(identity.projectPath);
  const repo = `${remote.owner}/${remote.repo}`;
  const list = args[0] === "gh" && (args[1] === "issue" || args[1] === "pr") && args[2] === "list" && args[3] === "--repo" && args[4] === repo && args[5] === "--json" && ghFields.has(args[6] ?? "") && args[7] === "--limit" && /^(?:[1-9]|[1-9]\d|100)$/.test(args[8] ?? "") && args.length === 9;
  const view = args[0] === "gh" && (args[1] === "issue" || args[1] === "pr") && args[2] === "view" && /^\d+$/.test(args[3] ?? "") && args[4] === "--repo" && args[5] === repo && args[6] === "--json" && ghFields.has(args[7] ?? "") && args.length === 8;
  if (list || view) return execute("gh", args.slice(1), identity.projectPath);
  const create = args[0] === "gh" && args[1] === "issue" && args[2] === "create" && args[3] === "--repo" && args[4] === repo && args[5] === "--title" && args[6] && args[7] === "--body" && args[8] !== undefined && args.length === 9;
  if (!create) return null;
  return execute("gh", args.slice(1), identity.projectPath).then(async (created) => {
    const url = created.trim();
    if (!/^https:\/\/github\.com\//.test(url)) throw new Error("research GitHub create did not return an issue URL");
    await execute("gh", ["issue", "view", url, "--repo", repo, "--json", "number,title,state,url"], identity.projectPath);
    return created;
  });
}

export async function executeResearchBash(command: string, identity: ResearchIdentity | null = researchIdentity()): Promise<string> {
  if (!identity || process.env.YOKEMATE_MODE !== "research") throw new Error("bounded research bash is available only in a valid research session");
  const args = parseArgv(command);
  if (args.length === 1 && args[0] === "pwd") return `${identity.root}\n`;
  if (args.length === 3 && args[0] === "pnpm" && args[1] === "where" && args[2] === "research") return "run\n";
  const gh = ghBounded(args, identity);
  if (gh) return gh;
  if (args[0] !== "git" || args[1] !== "-C" || !identity.projectPath || resolve(args[2] ?? "") !== resolve(identity.projectPath) || !gitRead(args.slice(3))) throw new Error("research bash command is not in the bounded allowlist; present a concrete code change through edit/write");
  return execute("git", ["-c", "core.pager=cat", "-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", "diff.textconv=false", ...args.slice(3)], identity.projectPath);
}

function inside(target: string, root: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function artifactRoot(identity: ResearchIdentity, target: string): string | null {
  const roots = [resolve(identity.root, "home", "notes"), ...(identity.project ? [resolve(identity.root, "home", "knowledge", ...identity.project.split("/"))] : [])];
  return roots.find((root) => inside(target, root)) ?? null;
}

function projectTarget(identity: ResearchIdentity, target: string): boolean {
  return Boolean(identity.projectPath && inside(target, resolve(identity.projectPath)) && !relative(resolve(identity.projectPath), target).split(sep).includes(".git"));
}

async function source(path: string): Promise<Buffer | null> {
  try { return await readFile(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeChecked(path: string, initial: Buffer | null, content: string): Promise<void> {
  const current = await source(path);
  if (!Buffer.from(current ?? "").equals(Buffer.from(initial ?? "")) || (current === null) !== (initial === null)) throw new Error("research edit source changed during consent");
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.nlink > 1) throw new Error("research target changed type during consent");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

export function installResearchTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "bash", label: "bounded research bash", description: "Run a finite research read command.", parameters: Type.Object({ command: Type.String() }),
    async execute(_id, input) {
      return { content: [{ type: "text", text: await executeResearchBash(input.command) }], details: undefined };
    },
  });
  pi.registerTool({
    name: "write", label: "research write", description: "Write a research artifact or one consented project edit.", parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    async execute(id, input, signal, _update, ctx) {
      const identity = researchIdentity(process.env, String((ctx as unknown as { sessionId?: string }).sessionId ?? "runtime"));
      if (!identity) throw new Error("research identity missing");
      const target = resolve(ctx.cwd, input.path);
      const artifacts = artifactRoot(identity, target);
      if (!artifacts && !projectTarget(identity, target)) throw new Error("research writes are limited to artifacts or the selected clone after consent");
      const root = artifacts ?? identity.projectPath!;
      const safe = canonicalResearchTarget(target, root);
      const initial = await source(safe);
      if (!artifacts) {
        const verdict = await authorizeResearchMutation({ identity, target: safe, finalContent: input.content, initialContent: initial?.toString("utf8") ?? null, toolCallId: id, hasUI: ctx.hasUI, aborted: signal?.aborted, confirm: async (details) => ctx.ui.confirm("Research code edit", details) });
        if (!verdict.ok) throw new Error(verdict.reason);
      }
      if (signal?.aborted) throw new Error("research edit aborted");
      await writeChecked(safe, initial, input.content);
      return { content: [{ type: "text", text: `Successfully wrote to ${input.path}` }], details: undefined };
    },
  });
  pi.registerTool({
    name: "edit", label: "research edit", description: "Apply one consented exact replacement.", parameters: Type.Object({ path: Type.String(), edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })) }),
    async execute(id, input, signal, _update, ctx) {
      const identity = researchIdentity(process.env, String((ctx as unknown as { sessionId?: string }).sessionId ?? "runtime"));
      if (!identity || !identity.projectPath) throw new Error("research edit requires a selected project");
      const target = resolve(ctx.cwd, input.path);
      if (!projectTarget(identity, target)) throw new Error("research edits are limited to the selected clone after consent");
      const safe = canonicalResearchTarget(target, identity.projectPath);
      const initial = await source(safe);
      if (!initial) throw new Error("research edit target does not exist");
      const before = initial.toString("utf8");
      const matches = input.edits.map((edit) => {
        const first = before.indexOf(edit.oldText);
        if (first < 0 || before.indexOf(edit.oldText, first + 1) >= 0) throw new Error("each edit oldText must match exactly once");
        return { ...edit, start: first, end: first + edit.oldText.length };
      }).sort((a, b) => a.start - b.start);
      if (matches.some((edit, index) => index > 0 && edit.start < matches[index - 1]!.end)) throw new Error("edit replacements overlap");
      const rebuilt = matches.reduce((text, edit) => text.replace(edit.oldText, edit.newText), before);
      const verdict = await authorizeResearchMutation({ identity, target: safe, finalContent: rebuilt, initialContent: before, toolCallId: id, hasUI: ctx.hasUI, aborted: signal?.aborted, confirm: async (details) => ctx.ui.confirm("Research code edit", details) });
      if (!verdict.ok) throw new Error(verdict.reason);
      if (signal?.aborted) throw new Error("research edit aborted");
      await writeChecked(safe, initial, rebuilt);
      return { content: [{ type: "text", text: `Successfully edited ${input.path}` }], details: undefined };
    },
  });
}
