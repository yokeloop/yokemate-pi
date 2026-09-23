const scenario = process.env.YM217_REPORT_SCENARIO || "success";
const payload = scenario === "review"
  ? JSON.stringify({ status: "changes_required", findings: [{ severity: "blocking", lens: 1, file: "src/a.ts", line: 1, problem: "problem", evidence: "evidence", fix: "fix" }] })
  : scenario === "isolation" ? JSON.stringify({ args: process.argv.slice(2), agentDir: process.env.PI_CODING_AGENT_DIR, sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR, role: process.env.YOKEMATE_ROLE })
  : "line one\nline two\ncanonical tail";
const message = {
  role: "assistant",
  content: [{ type: "text", text: payload }],
  stopReason: "stop",
  provider: "fixture",
  model: "fixture",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};
process.stdout.write(JSON.stringify({ type: "session", id: "11111111-1111-1111-1111-111111111111" }) + "\n");
process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\n");
