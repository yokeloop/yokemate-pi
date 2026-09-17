import fs from "node:fs";
import readline from "node:readline";

const commentsFile = process.env.YM216_COMMENTS;
if (process.env.YM216_SERVER_STARTS) {
  let starts = 0;
  try { starts = Number(fs.readFileSync(process.env.YM216_SERVER_STARTS, "utf8")); } catch {}
  fs.writeFileSync(process.env.YM216_SERVER_STARTS, String(starts + 1));
}
const tools = [
  { name: "get_issue", description: "Get issue", inputSchema: { type: "object", properties: { issueId: { type: "string" }, recentCommentsCount: { type: "number" } }, required: ["issueId"] } },
  { name: "get_issue_comments", description: "List comments", inputSchema: { type: "object", properties: { issueId: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["issueId", "offset", "limit"] } },
  { name: "add_issue_comment", description: "Add comment", inputSchema: { type: "object", properties: { issueId: { type: "string" }, text: { type: "string" } }, required: ["issueId", "text"] } },
];
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  const response = { jsonrpc: "2.0", id: request.id };
  if (request.method === "initialize") return send({ ...response, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "ym216-fixture", version: "1" } } });
  if (request.method === "tools/list") return send({ ...response, result: { tools } });
  if (request.method === "tools/call") {
    const { name, arguments: args } = request.params;
    if (process.env.YM216_MCP_ERROR && name === "get_issue") {
      const status = Number(process.env.YM216_MCP_ERROR);
      return send({ ...response, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ status, message: `fixture ${status}` }) }], structuredContent: { status } } });
    }
    let data;
    const rows = JSON.parse(fs.readFileSync(commentsFile, "utf8"));
    if (name === "get_issue") data = { id: args.issueId, url: `https://tracker.example/issue/${args.issueId}?private=query#fragment` };
    else if (name === "get_issue_comments") data = rows.slice(args.offset, args.offset + Math.min(args.limit, 10));
    else if (name === "add_issue_comment") { rows.push({ id: String(rows.length + 1), text: args.text, author: "fixture", url: `https://tracker.example/comment/${rows.length + 1}`, createdAt: "2026-01-01" }); fs.writeFileSync(commentsFile, JSON.stringify(rows)); data = rows.at(-1); }
    else return send({ ...response, error: { code: -32601, message: "not found" } });
    return send({ ...response, result: { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: Array.isArray(data) ? { comments: data } : data } });
  }
  send({ ...response, error: { code: -32601, message: "not found" } });
});
