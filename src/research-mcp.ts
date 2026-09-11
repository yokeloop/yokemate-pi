import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
const MCP_TOOL_APPROVAL_REQUEST_EVENT = "pi-mcp-adapter:tool-approval-request";
type McpToolApprovalRequest = {
  serverName: string;
  originalToolName: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  claim(handler: () => Promise<"allow_once" | "deny">): boolean;
};
import { researchIdentity, type ResearchIdentity, type ResearchVerdict } from "./research-guard.ts";

const youtrackRead = new Set(["find_projects", "get_project", "get_issue_fields_schema", "get_issue", "get_issue_comments", "search_issues", "get_article", "search_articles", "get_current_user"]);
const firecrawl = new Map<string, readonly string[]>([
  ["firecrawl_search", ["query", "limit", "sources", "categories", "includeDomains", "excludeDomains"]],
  ["firecrawl_scrape", ["url", "formats", "maxAge", "onlyMainContent"]],
]);
const youtrackFields = new Map<string, readonly string[]>([
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

function trackerKey(): string | undefined {
  return process.env.YOKEMATE_RESEARCH_TRACKER_KEY || undefined;
}

export function classifyResearchMcp(server: string | undefined, tool: string | undefined, args: unknown, identity: ResearchIdentity | null): ResearchVerdict {
  if (!identity || process.env.YOKEMATE_MODE !== "research") return { ok: false, reason: "research MCP identity is missing or damaged" };
  if (!server || !tool || !object(args)) return { ok: false, reason: "research MCP needs a server, tool, and JSON-object arguments" };
  if (server === "firecrawl" && firecrawl.has(tool)) {
    if (!exactKeys(args, firecrawl.get(tool)!)) return { ok: false, reason: "research Firecrawl call has unsupported arguments" };
    if (tool === "firecrawl_search" && typeof args.query !== "string") return { ok: false, reason: "research Firecrawl search requires query" };
    if (tool === "firecrawl_scrape") {
      if (typeof args.url !== "string" || !/^https?:\/\//.test(args.url)) return { ok: false, reason: "research Firecrawl scrape requires a public http(s) URL" };
      if (args.formats !== undefined && (!Array.isArray(args.formats) || args.formats.some((x) => !["markdown", "html", "links", "summary"].includes(String(x))))) return { ok: false, reason: "research Firecrawl scrape has unsupported formats" };
    }
    return { ok: true };
  }
  const expectedServer = identity.project ? `youtrack-${identity.project.split("/")[0]}` : "";
  if (server === expectedServer && youtrackRead.has(tool)) {
    if (!exactKeys(args, youtrackFields.get(tool)!)) return { ok: false, reason: "research YouTrack read has unsupported arguments" };
    return { ok: true };
  }
  if (server === expectedServer && tool === "create_issue") {
    if (!exactKeys(args, ["project", "summary", "description", "customFields", "parentIssue", "permittedUsers", "permittedGroups"])) return { ok: false, reason: "research create_issue has unsupported arguments" };
    if (args.project !== trackerKey() || typeof args.summary !== "string" || args.summary.length === 0) return { ok: false, reason: "research issue must use the selected passport tracker project and a summary" };
    return { ok: true };
  }
  return { ok: false, reason: `research MCP denies ${server}/${tool}; use a bounded read or concrete edit/write` };
}

function literal(raw: string): unknown {
  try {
    const value = JSON.parse(raw);
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
  } catch { throw new Error("research script arguments must be JSON literals"); }
}

export function normalizeResearchScript(code: string): string {
  if (/\b(?:import|export|function|class|while|for|eval|new|globalThis|process|constructor)\b|=>|tools\s*\[/.test(code)) throw new Error("research script syntax is not allowed");
  const statements = code.split(";").map((part) => part.trim()).filter(Boolean);
  if (statements.length === 0 || statements.length > 32) throw new Error("research mcpScript needs 1..32 data-only operations");
  const names = new Set<string>();
  const output: string[] = [];
  for (const statement of statements) {
    const declaration = statement.match(/^const ([A-Za-z_$][\w$]*) = await tools\.([A-Za-z_$][\w$]*)\((.*)\)$/s);
    if (declaration) {
      const [, name, method, raw] = declaration;
      if (names.has(name!)) throw new Error("research script duplicate variable");
      const parts = raw!.split(/,(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/).map((part) => part.trim()).filter(Boolean);
      const required = method === "call" ? 2 : 1;
      if (parts.length !== required || !["search", "describe", "call"].includes(method!)) throw new Error("research script operation is not allowed");
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
  pi.events.on(MCP_TOOL_APPROVAL_REQUEST_EVENT, (request: McpToolApprovalRequest) => {
    request.claim(async () => {
      if (request.signal?.aborted) return "deny";
      return classifyResearchMcp(request.serverName, request.originalToolName, request.args, researchIdentity()).ok ? "allow_once" : "deny";
    });
  });
  const adapter = await import("pi-mcp-adapter");
  if (typeof adapter.createMcpAdapter !== "function") throw new Error("pi-mcp-adapter 2.20.1 lacks createMcpAdapter");
  adapter.createMcpAdapter()(pi);
}
