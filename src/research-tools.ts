import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { authorizeResearchMutation, canonicalResearchTarget, researchIdentity, type ResearchIdentity } from "./research-guard.ts";

function argv(command: string): string[] {
  if (/[|;&><`$()\\\n]/.test(command)) throw new Error("research bash accepts only a simple literal argv; use read/grep/find/ls or edit/write");
  const out: string[] = [];
  const re = /\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/gy;
  let i = 0;
  while (i < command.length) {
    re.lastIndex = i;
    const m = re.exec(command);
    if (!m) throw new Error("research bash has invalid quoting");
    out.push(m[1] ?? m[2] ?? m[3]!);
    i = re.lastIndex;
  }
  return out;
}

function exec(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((ok, no) => execFile(command, args, {
    cwd, shell: false, env: { ...process.env, GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0", GIT_EXTERNAL_DIFF: "", GIT_CONFIG_NOSYSTEM: "1" },
  }, (error, stdout, stderr) => error ? no(new Error(stderr || error.message)) : ok(stdout)));
}

export async function executeResearchBash(command: string, identity: ResearchIdentity | null = researchIdentity()): Promise<string> {
  if (!identity) throw new Error("bounded research bash is available only in a research session");
  const a = argv(command);
  if (a.length === 1 && a[0] === "pwd") return `${identity.root}\n`;
  if (a.join(" ") === "pnpm where research") return "run\n";
  if (a[0] !== "git" || a[1] !== "-C" || !a[2]) throw new Error("research bash denies this command; present a concrete code change through edit/write");
  if (!identity.projectPath || resolve(a[2]) !== resolve(identity.projectPath)) throw new Error("research git reads only the selected clone");
  const rest = a.slice(3);
  const allowed =
    (rest.join(" ") === "status --short") ||
    (rest[0] === "diff" && rest.slice(1).every((v) => v === "--stat" || v === "--" || !v.startsWith("-"))) ||
    (rest[0] === "log" && /^-n$/.test(rest[1] ?? "") && /^([1-9]|[1-9]\d|100)$/.test(rest[2] ?? "") && rest[3] === "--oneline") ||
    (rest.join(" ") === "remote get-url origin");
  if (!allowed) throw new Error("research bash command is not in the bounded allowlist");
  return exec("git", ["-c", "core.pager=cat", "-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", "diff.textconv=false", ...rest], identity.projectPath);
}

export function installResearchTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "bash", label: "bounded research bash", description: "Run a finite research read command.",
    parameters: Type.Object({ command: Type.String() }),
    async execute(_id, input) {
      const text = await executeResearchBash(input.command);
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
  pi.registerTool({
    name: "write", label: "research write", description: "Write a research artifact or one consented project edit.",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    async execute(id, input, signal, _update, ctx) {
      const identity = researchIdentity(process.env, String((ctx as unknown as { sessionId?: string }).sessionId ?? "runtime"));
      if (!identity) throw new Error("research identity missing");
      const target = resolve(ctx.cwd, input.path);
      const artifactRoots = [resolve(identity.root, "home", "notes"), ...(identity.project ? [resolve(identity.root, "home", "knowledge", ...identity.project.split("/"))] : [])];
      const artifact = artifactRoots.some((r) => target === r || target.startsWith(r + "/"));
      if (!artifact) {
        const initial = await readFile(target, "utf8").catch(() => null);
        const verdict = await authorizeResearchMutation({ identity, target, finalContent: input.content, initialContent: initial, toolCallId: id, hasUI: ctx.hasUI, aborted: signal?.aborted, confirm: async (details) => ctx.ui.confirm("Research code edit", details) });
        if (!verdict.ok) throw new Error(verdict.reason);
      }
      const canonicalRoot = artifact ? artifactRoots.find((r) => target === r || target.startsWith(r + "/"))! : identity.projectPath!;
      const safe = canonicalResearchTarget(target, canonicalRoot);
      if (signal?.aborted) throw new Error("research edit aborted");
      await mkdir(dirname(safe), { recursive: true });
      await writeFile(safe, input.content, "utf8");
      return { content: [{ type: "text", text: `Successfully wrote to ${input.path}` }], details: undefined };
    },
  });
  pi.registerTool({
    name: "edit", label: "research edit", description: "Apply one consented exact replacement.",
    parameters: Type.Object({ path: Type.String(), edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })) }),
    async execute(id, input, signal, update, ctx) {
      const target = resolve(ctx.cwd, input.path);
      const before = await readFile(target, "utf8");
      let after = before;
      for (const edit of input.edits) {
        const first = after.indexOf(edit.oldText);
        if (first < 0 || after.indexOf(edit.oldText, first + 1) >= 0) throw new Error("each edit oldText must match exactly once");
        after = after.slice(0, first) + edit.newText + after.slice(first + edit.oldText.length);
      }
      return (pi as unknown as { getTool?: (name: string) => unknown }) && (async () => {
        const identity = researchIdentity(process.env, String((ctx as unknown as { sessionId?: string }).sessionId ?? "runtime"));
        if (!identity) throw new Error("research identity missing");
        const verdict = await authorizeResearchMutation({ identity, target, finalContent: after, initialContent: before, toolCallId: id, hasUI: ctx.hasUI, aborted: signal?.aborted, confirm: async (details) => ctx.ui.confirm("Research code edit", details) });
        if (!verdict.ok) throw new Error(verdict.reason);
        const safe = canonicalResearchTarget(target, identity.projectPath!);
        if ((await readFile(safe, "utf8")) !== before) throw new Error("research edit source changed during consent");
        await writeFile(safe, after, "utf8");
        return { content: [{ type: "text" as const, text: `Successfully edited ${input.path}` }], details: undefined };
      })();
    },
  });
}
