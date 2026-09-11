import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { researchIdentity, type ResearchIdentity, type ResearchVerdict } from "./research-guard.ts";

const MCP_TOOL_APPROVAL_REQUEST_EVENT = "pi-mcp-adapter:tool-approval-request";

const directTools = new Set<string>();
const firecrawl = new Map<string, readonly string[]>([
  ["firecrawl_search", ["query", "limit", "sources", "categories", "includeDomains", "excludeDomains"]],
  ["firecrawl_scrape", ["url", "formats", "maxAge", "onlyMainContent"]],
]);
const youtrackRead = new Map<string, readonly string[]>([
  ["find_projects", ["fields"]], ["get_project", ["project", "fields"]],
  ["get_issue_fields_schema", ["project"]], ["get_issue", ["issueId", "fields"]],
  ["get_issue_comments", ["issueId", "fields", "top", "skip"]],
  ["search_issues", ["query", "fields", "top", "skip"]], ["get_article", ["articleId", "fields"]],
  ["search_articles", ["query", "fields", "top", "skip"]], ["get_current_user", ["fields"]],
]);

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function strings(value: unknown): boolean { return Array.isArray(value) && value.every((v) => typeof v === "string"); }
function count(value: unknown): boolean { return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100; }
function trackerServer(): string | null {
  const tracker = process.env.YOKEMATE_RESEARCH_TRACKER;
  return tracker && tracker !== "github" ? `youtrack-${tracker}` : null;
}

export function isResearchMcpTool(name: string): boolean { return directTools.has(name); }

export function classifyResearchMcp(server: string | undefined, tool: string | undefined, args: unknown, identity: ResearchIdentity | null): ResearchVerdict {
  if (!identity || process.env.YOKEMATE_MODE !== "research") return { ok: false, reason: "research MCP identity is missing or damaged" };
  if (!server || !tool || !object(args)) return { ok: false, reason: "research MCP needs a server, tool, and JSON-object arguments" };
  if (server === "firecrawl" && firecrawl.has(tool)) {
    if (!exactKeys(args, firecrawl.get(tool)!)) return { ok: false, reason: "research Firecrawl call has unsupported arguments" };
    if (tool === "firecrawl_search") {
      if (typeof args.query !== "string" || (args.limit !== undefined && !count(args.limit)) || (args.sources !== undefined && !strings(args.sources)) || (args.categories !== undefined && !strings(args.categories)) || (args.includeDomains !== undefined && !strings(args.includeDomains)) || (args.excludeDomains !== undefined && !strings(args.excludeDomains))) return { ok: false, reason: "research Firecrawl search has invalid arguments" };
    } else if (typeof args.url !== "string" || !/^https?:\/\//.test(args.url) || (args.formats !== undefined && (!strings(args.formats) || args.formats.some((v) => !["markdown", "html", "links", "summary"].includes(v)))) || (args.maxAge !== undefined && !count(args.maxAge)) || (args.onlyMainContent !== undefined && typeof args.onlyMainContent !== "boolean")) return { ok: false, reason: "research Firecrawl scrape has invalid arguments" };
    return { ok: true };
  }
  if (server === trackerServer() && youtrackRead.has(tool)) {
    if (!exactKeys(args, youtrackRead.get(tool)!)) return { ok: false, reason: "research YouTrack read has unsupported arguments" };
    return { ok: true };
  }
  if (server === trackerServer() && tool === "create_issue") {
    if (!exactKeys(args, ["project", "summary", "description", "customFields", "parentIssue", "permittedUsers", "permittedGroups"])) return { ok: false, reason: "research create_issue has unsupported arguments" };
    if (args.project !== process.env.YOKEMATE_RESEARCH_TRACKER_KEY || typeof args.summary !== "string" || args.summary.length === 0) return { ok: false, reason: "research issue must use the selected passport tracker project and a summary" };
    return { ok: true };
  }
  return { ok: false, reason: `research MCP denies ${server}/${tool}; use a bounded read or concrete edit/write` };
}

function literal(raw: string): unknown {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("research script arguments must be JSON literals"); }
  const visit = (item: unknown): void => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) return item.forEach(visit);
    for (const [key, child] of Object.entries(item)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("research script JSON has a forbidden key");
      visit(child);
    }
  };
  visit(value);
  return value;
}

export function normalizeResearchScript(code: string): string {
  if (/\b(?:import|export|function|class|while|for|eval|new|globalThis|process|constructor)\b|=>|tools\s*\[/.test(code)) throw new Error("research script syntax is not allowed");
  const statements = code.split(";").map((part) => part.trim()).filter(Boolean);
  if (statements.length === 0 || statements.length > 32) throw new Error("research mcpScript needs 1..32 data-only operations");
  const names = new Set<string>();
  const output: string[] = [];
  for (const statement of statements) {
    const declaration = statement.match(/^const ([A-Za-z_$][\w$]*) = await tools\.(search|describe|call)\((.*)\)$/s);
    if (declaration) {
      const [, name, method, raw] = declaration;
      if (names.has(name!)) throw new Error("research script duplicate variable");
      const parts = raw!.split(/,(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/).map((part) => part.trim()).filter(Boolean);
      const required = method === "call" ? 2 : 1;
      if (parts.length !== required) throw new Error("research script operation is not allowed");
      const values = parts.map(literal);
      if ((method === "search" || method === "describe") && !object(values[0])) throw new Error("research script discovery arguments must be objects");
      if (method === "call" && (typeof values[0] !== "string" || !object(values[1]))) throw new Error("research tools.call needs a literal name and object");
      names.add(name!);
      output.push(`const ${name} = await tools.${method}(${values.map((value) => JSON.stringify(value)).join(", ")});`);
      continue;
    }
    const emit = statement.match(/^emit\(([A-Za-z_$][\w$]*)\)$/);
    if (emit && names.has(emit[1]!)) { output.push(`emit(${emit[1]});`); continue; }
    throw new Error("research script syntax is not allowed");
  }
  return output.join("\n");
}

export const researchApprovalEvents = [MCP_TOOL_APPROVAL_REQUEST_EVENT] as const;

export async function installResearchMcp(pi: ExtensionAPI): Promise<void> {
  const events = new Proxy(pi.events, {
    get(target, property, receiver) {
      if (property !== "emit") return Reflect.get(target, property, receiver);
      return (event: string, request: { claim?: (handler: () => Promise<"allow_once" | "deny">) => boolean; serverName?: string; originalToolName?: string; args?: unknown; signal?: AbortSignal }) => {
        if (event !== MCP_TOOL_APPROVAL_REQUEST_EVENT) return target.emit(event as never, request as never);
        if (!request.claim || request.signal?.aborted) return false;
        return request.claim(async () => classifyResearchMcp(request.serverName, request.originalToolName, request.args, researchIdentity()).ok ? "allow_once" : "deny");
      };
    },
  });
  const facade = new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "events") return events;
      if (property === "registerTool") return (tool: { name: string; execute?: (...args: any[]) => Promise<unknown> }) => {
        if (tool.name !== "mcp" && tool.name !== "mcpScript") directTools.add(tool.name);
        const execute = tool.execute;
        if (!execute) return target.registerTool(tool as never);
        return target.registerTool({ ...tool, async execute(...args: any[]) {
          const params = args[1] as Record<string, unknown>;
          if (tool.name === "mcpScript") args[1] = { ...params, code: normalizeResearchScript(String(params.code ?? "")) };
          if (tool.name === "mcp" && (params.action || params.connect)) throw new Error("research MCP configuration and authentication operations are unavailable");
          return execute(...args);
        } } as never);
      };
      return Reflect.get(target, property, receiver);
    },
  });
  const adapter = await import("pi-mcp-adapter");
  if (typeof adapter.createMcpAdapter !== "function") throw new Error("pi-mcp-adapter 2.20.1 lacks createMcpAdapter");
  adapter.createMcpAdapter()(facade as ExtensionAPI);
}
