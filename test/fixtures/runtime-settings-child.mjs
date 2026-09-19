import net from "node:net";
const socket = net.createConnection(process.env.RUNTIME_SETTINGS_TEST_SOCKET);
socket.on("connect", () => socket.write(JSON.stringify({ pid: process.pid, task: process.argv.at(-1) }) + "\n"));
if (process.env.SUBAGENT_CANCEL_MODE === "term") process.on("SIGTERM", () => {
  socket.write(JSON.stringify({ pid: process.pid, phase: "term" }) + "\n");
  setTimeout(() => process.exit(0), 50);
});
if (process.env.SUBAGENT_CANCEL_MODE === "kill") process.on("SIGTERM", () => socket.write(JSON.stringify({ pid: process.pid, phase: "term-ignored" }) + "\n"));
socket.on("data", () => {
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "fixture complete" }], stopReason: "stop", model: "fixture", usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } } } }));
  socket.end();
});
