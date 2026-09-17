import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PublicationFailure, type PublicationAdapter, type RemoteComment } from "./plan-publication.ts";

const approvalEvent = "pi-mcp-adapter:tool-approval-request";
type Execute = (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, update: undefined, ctx: ExtensionContext) => Promise<any>;
type Handler = (event: any, ctx: ExtensionContext) => unknown;

function safeError(details: Record<string, unknown> | undefined): PublicationFailure {
  const error = String(details?.error ?? "");
  if (/auth/.test(error)) return new PublicationFailure("auth");
  if (/permission|forbidden|denied/.test(error)) return new PublicationFailure("permission");
  if (/rate|429/.test(error)) return new PublicationFailure("rate_limit");
  if (/size|large|413/.test(error)) return new PublicationFailure("size");
  return new PublicationFailure("unavailable");
}

function mcpData(result: any): unknown {
  const details = result?.details as Record<string, unknown> | undefined;
  if (result?.isError || details?.error) throw safeError(details);
  const raw = details?.mcpResult as any;
  if (raw?.isError) throw new PublicationFailure("unavailable");
  if (raw?.structuredContent !== undefined) return raw.structuredContent;
  const texts = Array.isArray(raw?.content) ? raw.content.filter((item: any) => item?.type === "text" && typeof item.text === "string").map((item: any) => item.text) : [];
  if (texts.length === 1) {
    try { return JSON.parse(texts[0]!); } catch { throw new PublicationFailure("incomplete_listing"); }
  }
  throw new PublicationFailure("incomplete_listing");
}

class PrivateMcp {
  private execute?: Execute;
  private handlers = new Map<string, Handler[]>();
  private initialized = false;
  private pending?: { tool: string; args: Record<string, unknown> };
  private pi: ExtensionAPI;
  private root: string;
  private server: string;
  private context: () => ExtensionContext | undefined;
  private constructor(pi: ExtensionAPI, root: string, server: string, context: () => ExtensionContext | undefined) {
    this.pi = pi;
    this.root = root;
    this.server = server;
    this.context = context;
  }
  static async create(pi: ExtensionAPI, root: string, server: string, context: () => ExtensionContext | undefined): Promise<PrivateMcp> {
    const bridge = new PrivateMcp(pi, root, server, context);
    const adapterRoot = dirname(fileURLToPath(import.meta.resolve("pi-mcp-adapter")));
    const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const { createJiti } = await import(pathToFileURL(requirePi.resolve("jiti")).href) as any;
    const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
    const configModule = await jiti.import(join(adapterRoot, "config.ts")) as any;
    const adapterModule = await jiti.import(join(adapterRoot, "index.ts")) as any;
    const source = configModule.loadMcpConfig(undefined, root);
    const selected = source.mcpServers?.[server];
    if (!selected) throw new PublicationFailure("unavailable");
    const config = {
      mcpServers: { [server]: { ...selected, lifecycle: "lazy", directTools: false, debug: false, trace: false, requestTimeoutMs: 30_000 } },
      imports: [],
      settings: { ...(source.settings ?? {}), toolPrefix: "none", directTools: false, scriptMode: false, disableProxyTool: false, autoAuth: false, sampling: false, elicitation: false, outputGuard: false, trace: { enabled: false } },
    };
    const events = {
      emit(event: string, request: any) {
        if (event !== approvalEvent) return false;
        const pending = bridge.pending;
        if (!request?.claim || request.signal?.aborted || request.serverName !== bridge.server || request.originalToolName !== pending?.tool || JSON.stringify(request.args) !== JSON.stringify(pending?.args)) return false;
        return request.claim(() => "allow_once");
      },
      on() { return () => undefined; },
    };
    const facade = new Proxy(pi as any, {
      get: (target, property, receiver) => {
        if (property === "events") return events;
        if (property === "registerTool") return (tool: { name: string; execute?: Execute }) => { if (tool.name === "mcp" && tool.execute) bridge.execute = tool.execute; };
        if (property === "registerCommand" || property === "registerShortcut" || property === "registerFlag" || property === "registerMessageRenderer" || property === "registerEntryRenderer") return () => undefined;
        if (property === "on") return (event: string, handler: Handler) => { const list = bridge.handlers.get(event) ?? []; list.push(handler); bridge.handlers.set(event, list); };
        if (property === "getActiveTools") return () => [];
        if (property === "setActiveTools" || property === "appendEntry" || property === "sendMessage") return () => undefined;
        return Reflect.get(target, property, receiver);
      },
    });
    adapterModule.createMcpAdapter({ config })(facade);
    if (!bridge.execute) throw new PublicationFailure("unavailable");
    return bridge;
  }
  private async start(): Promise<void> {
    if (this.initialized) return;
    const ctx = this.context();
    if (!ctx) throw new PublicationFailure("unavailable");
    for (const handler of this.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
    this.initialized = true;
    const connected = await this.invoke({ connect: this.server });
    if (connected?.details?.server !== this.server || connected?.details?.error) throw safeError(connected?.details);
  }
  private async invoke(params: Record<string, unknown>): Promise<any> {
    const ctx = this.context();
    if (!ctx || !this.execute) throw new PublicationFailure("unavailable");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try { return await this.execute(randomUUID(), params, controller.signal, undefined, ctx); }
    catch (error) { if (error instanceof PublicationFailure) throw error; throw new PublicationFailure("unavailable"); }
    finally { clearTimeout(timer); }
  }
  private async describe(tool: string): Promise<void> {
    const result = await this.invoke({ describe: tool });
    const details = result?.details;
    if (details?.error || details?.server !== this.server || !details.tool || details.tool.originalName !== tool || !details.tool.inputSchema || typeof details.tool.inputSchema !== "object") throw new PublicationFailure("unavailable");
  }
  async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    await this.start();
    await this.describe(tool);
    this.pending = { tool, args };
    try { return mcpData(await this.invoke({ server: this.server, tool, args })); }
    finally { this.pending = undefined; }
  }
  async shutdown(): Promise<void> {
    if (!this.initialized) return;
    const ctx = this.context();
    if (ctx) for (const handler of this.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, ctx);
    this.initialized = false;
  }
}

export class PlanPublicationMcp {
  private bridges = new Map<string, PrivateMcp>();
  private ctx?: ExtensionContext;
  private pi: ExtensionAPI;
  private root: string;
  constructor(pi: ExtensionAPI, root: string) { this.pi = pi; this.root = root; }
  setContext(ctx: ExtensionContext): void { this.ctx = ctx; }
  private async bridge(server: string): Promise<PrivateMcp> {
    let bridge = this.bridges.get(server);
    if (!bridge) { bridge = await PrivateMcp.create(this.pi, this.root, server, () => this.ctx); this.bridges.set(server, bridge); }
    return bridge;
  }
  async shutdown(): Promise<void> { await Promise.all([...this.bridges.values()].map((bridge) => bridge.shutdown())); this.bridges.clear(); }
  async youTrackAdapter(server: string, issueId: string): Promise<{ adapter: PublicationAdapter; canonicalUrl: string }> {
    const bridge = await this.bridge(server);
    const issue = await bridge.call("get_issue", { issueId, recentCommentsCount: 0 }) as any;
    const issueValue = issue?.issue ?? issue;
    const returnedId = issueValue?.idReadable ?? issueValue?.id;
    const rawUrl = issueValue?.url;
    if (returnedId !== issueId || typeof rawUrl !== "string") throw new PublicationFailure("unavailable");
    let canonicalUrl: string;
    try { const url = new URL(rawUrl); if (url.username || url.password) throw new Error(); url.search = ""; url.hash = ""; canonicalUrl = url.toString().replace(/\/$/, ""); }
    catch { throw new PublicationFailure("unavailable"); }
    if (!canonicalUrl.includes(encodeURIComponent(issueId)) && !canonicalUrl.includes(issueId)) throw new PublicationFailure("unavailable");
    const adapter: PublicationAdapter = {
      list: async () => {
        const comments: RemoteComment[] = [];
        const seen = new Set<string>();
        for (let offset = 0; offset < 1_000_000;) {
          const value = await bridge.call("get_issue_comments", { issueId, offset, limit: 10 }) as any;
          const rows = Array.isArray(value) ? value : Array.isArray(value?.comments) ? value.comments : undefined;
          if (!rows) throw new PublicationFailure("incomplete_listing");
          if (rows.length === 0) return comments;
          let added = 0;
          for (const row of rows) {
            if (!row || typeof row.text !== "string" || row.author === undefined || typeof row.url !== "string" || typeof row.createdAt !== "string") throw new PublicationFailure("incomplete_listing");
            const id = typeof row.id === "string" || typeof row.id === "number" ? String(row.id) : row.url;
            if (!id || seen.has(id)) throw new PublicationFailure("incomplete_listing");
            seen.add(id); added++;
            comments.push({ id, text: row.text, ...(typeof row.url === "string" ? { url: row.url } : {}) });
          }
          if (!added) throw new PublicationFailure("incomplete_listing");
          offset += rows.length;
        }
        throw new PublicationFailure("incomplete_listing");
      },
      add: async (text) => { await bridge.call("add_issue_comment", { issueId, text }); },
    };
    return { adapter, canonicalUrl };
  }
}
