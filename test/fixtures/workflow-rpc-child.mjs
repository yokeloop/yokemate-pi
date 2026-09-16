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
    send({ type: "response", id: command.id, success: true });
    if (command.message.startsWith("/yokemate-coordinator-ready")) send({ type: "message_end", message: { details: { runId: process.env.YOKEMATE_RUN_ID, ok: true } } });
  } else if (command.type === "abort") process.exit(0);
});
