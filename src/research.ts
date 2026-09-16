import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFindTool, createGrepTool, createLsTool, createReadTool } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import bus from "./bus.ts";
import subagent from "../.pi/extensions/subagent/index.ts";
import { canonicalResearchRead, classifyResearchCall, researchIdentity } from "./research-guard.ts";
import { installResearchMcp, isResearchMcpTool } from "./research-mcp.ts";
import { executeResearchBash, installResearchTools } from "./research-tools.ts";

const requiredTools = ["read", "grep", "find", "ls", "write", "edit", "bash", "subagent", "send_message"];
const optionalTools = ["mcp", "mcpScript"];
const entryPath = resolve(import.meta.filename);

function isResearchRegistration(tool: { name: string; sourceInfo: { source: string; path: string } }, name: string): boolean {
  return tool.name === name && tool.sourceInfo.source !== "builtin" && tool.sourceInfo.source !== "sdk" && resolve(tool.sourceInfo.path) === entryPath;
}

function researchRegistrations(pi: ExtensionAPI, names: string[]): string[] {
  const all = pi.getAllTools();
  const missing = names.filter((name) => !all.some((tool) => isResearchRegistration(tool, name)));
  if (missing.length) throw new Error(`research tool registration is missing or untrusted: ${missing.join(", ")}`);
  return names.filter((name) => all.some((tool) => isResearchRegistration(tool, name)));
}

export default function research(pi: ExtensionAPI): void {
  let ready = false;
  pi.on("tool_call", (event, ctx) => {
    const identity = researchIdentity();
    const verdict = classifyResearchCall(identity, event.toolName);
    if (!verdict.ok && !isResearchMcpTool(event.toolName)) return { block: true, reason: verdict.reason };
    if (identity && ["read", "grep", "find", "ls"].includes(event.toolName)) {
      const input = event.input as { path?: unknown };
      const path = typeof input.path === "string" ? resolve(ctx.cwd, input.path) : ctx.cwd;
      const readable = canonicalResearchRead(path, identity);
      if (!readable.ok) return { block: true, reason: readable.reason };
    }
    return undefined;
  });
  pi.on("user_bash", async (event) => {
    const identity = researchIdentity();
    if (!ready || !identity || resolve(event.cwd) !== identity.root)
      return { result: { output: "research tools are not ready", exitCode: 1, cancelled: false, truncated: false } };
    try {
      return { result: { output: await executeResearchBash(event.command), exitCode: 0, cancelled: false, truncated: false } };
    } catch (error) {
      return { result: { output: (error as Error).message, exitCode: 1, cancelled: false, truncated: false } };
    }
  });
  bus(pi);
  subagent(pi);
  const mcpLoad = installResearchMcp(pi).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  pi.on("session_start", async (_event, ctx) => {
    ready = false;
    pi.setActiveTools([]);
    const identity = researchIdentity(process.env, String((ctx as unknown as { sessionId?: string }).sessionId ?? "runtime"));
    if (!identity || process.env.YOKEMATE_MODE !== "research" || ctx.cwd !== identity.root) {
      ctx.ui.notify("research identity is invalid; no tools were enabled", "error");
      return;
    }
    const mcpError = await mcpLoad;
    if (mcpError) ctx.ui.notify(`research MCP did not load: ${mcpError}`, "error");
    try {
      pi.registerTool(createReadTool(identity.root) as never);
      pi.registerTool(createGrepTool(identity.root) as never);
      pi.registerTool(createFindTool(identity.root) as never);
      pi.registerTool(createLsTool(identity.root) as never);
      installResearchTools(pi);
      const active = researchRegistrations(pi, requiredTools);
      const optional = pi.getAllTools()
        .filter((tool) => optionalTools.includes(tool.name) && isResearchRegistration(tool, tool.name))
        .map((tool) => tool.name);
      pi.setActiveTools([...active, ...optional]);
      ready = true;
      ctx.ui.notify(`Research ${identity.project ?? "free topic"}: code changes require one-edit consent`, "info");
    } catch (error) {
      ready = false;
      pi.setActiveTools([]);
      ctx.ui.notify((error as Error).message, "error");
    }
  });
  pi.on("tool_call", () => ready ? undefined : { block: true, reason: "research tools are not ready" });
}
