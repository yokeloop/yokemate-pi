import { appendFileSync } from "node:fs";
import net from "node:net";
import readline from "node:readline";
const send = (event) => process.stdout.write(JSON.stringify(event) + "\n");
appendFileSync("fixture-runs", `${process.env.YOKEMATE_RUN_ID}\n`);
if (process.env.WORKFLOW_EVENT_SOCKET) {
  const eventSocket = net.createConnection(process.env.WORKFLOW_EVENT_SOCKET);
  eventSocket.on("data", () => {
    send({ type: "tool_execution_start", toolName: "subagent", toolCallId: `review-${process.env.YOKEMATE_RUN_ID}`, args: { agent: "task-reviewer", task: "review", review: { baseSha: "a".repeat(40), headSha: "b".repeat(40) } } });
    eventSocket.write("sent");
  });
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "get_commands") send({ type: "response", id: command.id, success: true, data: { commands: [{ name: "yokemate-coordinator-ready" }, { name: `skill:${process.env.YOKEMATE_MODE}-worker` }] } });
  else if (command.type === "get_state") send({ type: "response", id: command.id, success: true, data: { model: { provider: "test", id: "model" }, thinkingLevel: "high", sessionId: `child-${process.pid}` } });
  else if (command.type === "prompt") {
    if (command.message.startsWith("/yokemate-coordinator-ready")) {
      send({ type: "response", id: command.id, success: true });
      send({ type: "message_end", message: { details: { runId: process.env.YOKEMATE_RUN_ID, ok: true } } });
    } else if (process.env.WORKFLOW_FAST_TERMINAL) {
      appendFileSync("fixture-fast-terminals", `${process.env.YOKEMATE_RUN_ID}\n`);
      const toolCallId = `finish-${process.env.YOKEMATE_RUN_ID}`;
      process.stdout.write([
        { type: "response", id: command.id, success: true },
        { type: "tool_execution_start", toolName: "coordinator_finish", toolCallId },
        { type: "tool_execution_end", toolName: "coordinator_finish", toolCallId, result: { details: { kind: "yokemate-coordinator-outcome", runId: process.env.YOKEMATE_RUN_ID, outcome: "blocked", summary: "fixture terminal", reason: "fixture terminal after work ACK" } } },
      ].map((event) => JSON.stringify(event)).join("\n") + "\n");
    } else send({ type: "response", id: command.id, success: true });
  } else if (command.type === "abort") process.exit(0);
});
