import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResearchIdentity, ResearchVerdict } from "./research-guard.ts";

const READ_ONLY = new Set(["firecrawl_search", "firecrawl_scrape", "find_projects", "get_project", "get_issue_fields_schema", "get_issue", "get_issue_comments", "search_issues", "get_article", "search_articles", "get_current_user"]);

function plain(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

export function classifyResearchMcp(server: string | undefined, tool: string | undefined, args: unknown, identity: ResearchIdentity | null): ResearchVerdict {
  if (!identity) return { ok: false, reason: "research MCP identity is missing" };
  if (!tool) return { ok: true };
  if (!plain(args ?? {})) return { ok: false, reason: "research MCP args must be a JSON object" };
  if (READ_ONLY.has(tool)) return { ok: true };
  if (tool === "create_issue") {
    const a = args as Record<string, unknown>;
    if (!identity.project || !identity.projectPath) return { ok: false, reason: "choose a project before creating an issue" };
    if (a.project !== identity.project.split("/").at(-1) && a.project !== process.env.YOKEMATE_RESEARCH_TRACKER_KEY)
      return { ok: false, reason: "research issue must use the selected passport tracker project" };
    return typeof a.summary === "string" ? { ok: true } : { ok: false, reason: "create_issue requires summary" };
  }
  return { ok: false, reason: `research MCP denies ${server ?? "unknown"}/${tool}; use a bounded read or concrete edit/write` };
}

export function normalizeResearchScript(code: string): string {
  const statements = code.split(";").map((s) => s.trim()).filter(Boolean);
  if (statements.length === 0 || statements.length > 32) throw new Error("research mcpScript needs 1..32 operations");
  const names = new Set<string>();
  const output: string[] = [];
  for (const statement of statements) {
    const declaration = statement.match(/^const ([A-Za-z_$][\w$]*) = await tools\.(search|describe|call)\((.*)\)$/s);
    if (declaration) {
      const [, name, method, raw] = declaration;
      if (names.has(name!)) throw new Error("research script duplicate variable");
      const args = raw!.split(/,(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/).map((part) => part.trim()).filter(Boolean);
      if (args.length < 1 || args.length > 2) throw new Error("research script operation has invalid arguments");
      const values = args.map((part) => {
        try { return JSON.parse(part); } catch { throw new Error("research script arguments must be JSON literals"); }
      });
      if (values.some((v) => v && typeof v === "object" && ["__proto__", "constructor", "prototype"].some((k) => Object.prototype.hasOwnProperty.call(v, k)))) throw new Error("research script JSON has a forbidden key");
      names.add(name!);
      output.push(`const ${name} = await tools.${method}(${values.map((v) => JSON.stringify(v)).join(", ")});`);
      continue;
    }
    const emit = statement.match(/^emit\(([A-Za-z_$][\w$]*)\)$/);
    if (emit && names.has(emit[1]!)) { output.push(`emit(${emit[1]});`); continue; }
    throw new Error("research script syntax is not allowed");
  }
  return output.join("\n");
}

export async function installResearchMcp(pi: ExtensionAPI): Promise<void> {
  const adapter = await import("pi-mcp-adapter");
  const factory = adapter.createMcpAdapter;
  if (typeof factory !== "function") throw new Error("pi-mcp-adapter 2.20.1 lacks createMcpAdapter");
  factory()(pi);
}

export const researchApprovalEvents = ["pi-mcp-adapter:tool-approval-request"] as const;
