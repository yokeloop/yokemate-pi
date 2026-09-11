import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFindTool, createGrepTool, createLsTool, createReadTool } from "@earendil-works/pi-coding-agent";
import bus from "./bus.ts";
import subagent from "../.pi/extensions/subagent/index.ts";
import { classifyResearchCall, researchIdentity } from "./research-guard.ts";
import { installResearchMcp } from "./research-mcp.ts";
import { installResearchTools } from "./research-tools.ts";

export default function research(pi: ExtensionAPI): void {
  let ready = false;
  pi.on("tool_call", (event) => {
    const verdict = classifyResearchCall(researchIdentity(), event.toolName);
    return verdict.ok ? undefined : { block: true, reason: verdict.reason };
  });
  pi.setActiveTools([]);
  bus(pi);
  subagent(pi);
  pi.on("session_start", async (_event, ctx) => {
    const identity = researchIdentity(process.env, String((ctx as unknown as { sessionId?: string }).sessionId ?? "runtime"));
    if (!identity || process.env.YOKEMATE_MODE !== "research" || ctx.cwd !== identity.root) {
      ctx.ui.notify("research identity is invalid; no tools were enabled", "error");
      return;
    }
    pi.registerTool(createReadTool(identity.root) as never);
    pi.registerTool(createGrepTool(identity.root) as never);
    pi.registerTool(createFindTool(identity.root) as never);
    pi.registerTool(createLsTool(identity.root) as never);
    installResearchTools(pi);
    try { await installResearchMcp(pi); } catch (e) { ctx.ui.notify(`research MCP unavailable: ${(e as Error).message}`, "warning"); }
    ready = true;
    const active = ["read", "grep", "find", "ls", "write", "edit", "bash", "mcp", "mcpScript", "subagent", "send_message"];
    pi.setActiveTools(active.filter((name) => pi.getAllTools().some((tool) => tool.name === name)));
    ctx.ui.notify(`Research ${identity.project ?? "free topic"}: code changes require one-edit consent`, "info");
  });
  pi.on("tool_call", (event) => ready ? undefined : { block: true, reason: "research tools are not ready" });
}
