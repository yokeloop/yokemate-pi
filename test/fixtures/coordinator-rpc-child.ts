import { spawn } from "node:child_process";
import { closeSync, writeFileSync } from "node:fs";

const scenario = process.argv[2] ?? "ready";
const grandchild = scenario === "exit-no-descendants" ? undefined : spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
let buffer = "";
const send = (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`);
if (grandchild) send({ type: "grandchild", pid: grandchild.pid });
writeFileSync("fixture-pids.json", JSON.stringify([process.pid, ...(grandchild ? [grandchild.pid] : [])]));

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
      if (scenario === "state-false") send({ type: "response", id: command.id, success: false, error: "refused" });
      else if (scenario === "invalid-state") send({ type: "response", id: command.id, success: true, data: { model: { provider: "test", id: "model" }, thinkingLevel: "HIGH" } });
      else if (scenario === "provider-mismatch") send({ type: "response", id: command.id, success: true, data: { model: { provider: "wrong", id: "model" }, thinkingLevel: "high" } });
      else if (scenario === "thinking-mismatch") send({ type: "response", id: command.id, success: true, data: { model: { provider: "test", id: "model" }, thinkingLevel: "medium" } });
      else send({ type: "response", id: command.id, success: true, data: { model: { provider: "test", id: "model" }, thinkingLevel: "high" } });
    } else if (command.type === "prompt" && command.message?.startsWith("/yokemate-coordinator-ready")) {
      const runId = command.id?.replace(/:ready$/, "");
      send({ type: "response", id: command.id, success: true });
      send({ type: "message_end", message: { details: { runId, ok: true } } });
    } else if (command.type === "oversized-agent-end") {
      send({ type: "agent_end", messages: ["x".repeat(1024 * 1024)] });
      send({ type: "agent_settled", marker: "after-aggregate" });
    } else if (command.type === "oversized-unknown") {
      send({ type: "fixture_unknown", payload: "x".repeat(1024 * 1024) });
    } else if (command.type === "oversized-control") {
      send({ type: "response", id: "forbidden-oversized", success: true, payload: "x".repeat(1024 * 1024) });
    } else if (command.type === "prompt") {
      send({ type: "work_prompt" });
      send({ type: "extension_ui_request", id: "w1", method: "setWidget", widgetKey: "subagent-running", widgetLines: ["task-reviewer 0:05 review"] });
      send({ type: "response", id: command.id, success: true });
      if (scenario === "exit-no-descendants") { process.stderr.write("private coordinator sentinel"); process.exit(9); }
      setTimeout(() => send({ type: "message_end", message: { details: { kind: "nested-report", delayed: true } } }), 25);
    } else if (command.type === "close_stdin" && scenario === "closed-stdin") {
      closeSync(0);
      send({ type: "stdin_closed" });
    } else if (command.type === "abort") {
      process.exit(0);
    }
  }
});
