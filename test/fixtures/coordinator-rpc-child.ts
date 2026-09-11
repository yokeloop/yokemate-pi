import { spawn } from "node:child_process";

const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
let buffer = "";
const send = (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`);
send({ type: "grandchild", pid: grandchild.pid });

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const command = JSON.parse(line) as { id?: string; type?: string; message?: string };
    if (command.type === "get_commands") {
      send({ type: "response", id: command.id, success: true, data: { commands: [{ name: "yokemate-coordinator-ready" }, { name: "skill:do-worker" }] } });
    } else if (command.type === "get_state") {
      send({ type: "response", id: command.id, success: true, data: { model: { provider: "test", id: "model" } } });
    } else if (command.type === "prompt" && command.message?.startsWith("/yokemate-coordinator-ready")) {
      const runId = command.id?.replace(/:ready$/, "");
      send({ type: "response", id: command.id, success: true });
      send({ type: "message_end", message: { details: { runId, ok: true } } });
    } else if (command.type === "prompt") {
      send({ type: "response", id: command.id, success: true });
      setTimeout(() => send({ type: "message_end", message: { details: { kind: "nested-report", delayed: true } } }), 25);
    } else if (command.type === "abort") {
      process.exit(0);
    }
  }
});
