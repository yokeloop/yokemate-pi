import fs from "node:fs";

let buffer = "";
let runId = "";
const scenario = process.env.YOKEMATE_COORDINATOR_REPORT_SCENARIO ?? "verified";
const sessionId = "coordinator-report-session";
const starttime = () => {
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19]!;
};
const send = (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`);

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const command = JSON.parse(buffer.slice(0, newline)) as { id?: string; type?: string; message?: string };
    buffer = buffer.slice(newline + 1);
    if (command.type === "get_commands") {
      send({ type: "response", id: command.id, success: true, data: { commands: [{ name: "yokemate-coordinator-ready" }, { name: "skill:do-worker" }] } });
      continue;
    }
    if (command.type === "get_state") {
      send({ type: "response", id: command.id, success: true, data: { model: { provider: "test", id: "model" }, thinkingLevel: "off", sessionId } });
      continue;
    }
    if (command.type === "prompt" && command.message?.startsWith("/yokemate-coordinator-ready")) {
      const encoded = command.message.split(" ")[1]!;
      const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      runId = payload.identity.runId;
      send({ type: "response", id: command.id, success: true });
      send({ type: "entry_appended", entry: { type: "custom", customType: "yokemate-child-state", data: { version: 1, ownerRunId: runId, ownerSessionId: sessionId, pid: process.pid, starttime: starttime(), sequence: 1, children: [], deliveries: [] } } });
      send({ type: "message_end", message: { details: { runId, ok: true } } });
      continue;
    }
    if (command.type === "prompt" && command.id?.endsWith(":work")) {
      send({ type: "response", id: command.id, success: true });
      send({ type: "message_end", message: { details: { kind: "nested-report", canonical: "nested child report" } } });
      if (scenario === "blocked") {
        process.stderr.write("private blocked sentinel");
        process.exit(9);
      }
      if (scenario === "local") continue;
      send({ type: "tool_execution_start", toolName: "coordinator_finish", toolCallId: "finish-1" });
      send({ type: "tool_execution_end", toolName: "coordinator_finish", toolCallId: "finish-1", isError: false, result: { details: { kind: "yokemate-coordinator-outcome", runId, outcome: "blocked", summary: "verified summary", reason: "fixture blocked" } } });
      continue;
    }
    if (["abort", "abort_retry", "abort_bash"].includes(command.type ?? "")) process.exit(0);
  }
});
