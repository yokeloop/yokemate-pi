import { connect } from "node:net";
import fs, { realpathSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

function exactProfile(bytes: number, tail: string): string {
  const prefix = "# Scout\n\n## Facts and sources\n- Протокол проверен.\n\n";
  const suffix = `\n${tail}\n\n## Assumptions\n- Deterministic.\n\n## Forks and recommendations\n- Keep framing bounded.\n`;
  return prefix + "x".repeat(bytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)) + suffix;
}

export default function (pi: ExtensionAPI) {
  const barrier = (phase: string, data: unknown = {}) => new Promise<void>((resolve, reject) => {
    const socket = connect(process.env.YM204_FIXTURE_SOCKET!);
    socket.once("connect", () => socket.write(JSON.stringify({ phase, role: process.env.YOKEMATE_ROLE, runId: process.env.YOKEMATE_RUN_ID, data }) + "\n"));
    socket.once("data", () => { socket.end(); resolve(); });
    socket.once("error", reject);
  });
  const scenario = process.env.YM204_FIXTURE_SCENARIO;
  let childTurns = 0;
  let reportSends = 0;
let cancelIssued = false;
let repeatedCancelIssued = false;
let cancelledRunId: string | undefined;
  if ((scenario === "delivery_sync" || scenario === "delivery_async") && process.env.YOKEMATE_ROLE === "coordinator") {
    const original = AgentSession.prototype.sendCustomMessage;
    AgentSession.prototype.sendCustomMessage = function (message, options) {
      if (message.customType === "subagent-report" && ++reportSends === 1) {
        if (scenario === "delivery_sync") throw new Error("fixture synchronous transport error");
        return Promise.reject(new Error("fixture asynchronous transport error"));
      }
      return original.call(this, message, options);
    };
  }
  if (scenario === "spawn_error" && process.env.YOKEMATE_ROLE === "coordinator") {
    const original = fs.promises.mkdtemp;
    fs.promises.mkdtemp = ((prefix: string, ...args: any[]) => prefix.includes("pi-subagent-") ? Promise.reject(Object.assign(new Error("private fixture ENOSPC"), { code: "ENOSPC" })) : (original as any)(prefix, ...args)) as any;
  }
  if (scenario === "cleanup_error" && process.env.YOKEMATE_ROLE === "coordinator") {
    const original = fs.rmSync;
    fs.rmSync = ((file: any, options: any) => { if (String(file).includes("pi-subagent-")) throw new Error("private cleanup fault"); original(file, options); }) as any;
  }
  if (scenario === "write_cleanup_error" && process.env.YOKEMATE_ROLE === "coordinator") {
    const write = fs.promises.writeFile;
    const remove = fs.promises.rm;
    fs.promises.writeFile = ((file: any, ...args: any[]) => String(file).includes("pi-subagent-") ? Promise.reject(new Error("private write fault")) : (write as any)(file, ...args)) as any;
    fs.promises.rm = ((file: any, ...args: any[]) => String(file).includes("pi-subagent-") ? Promise.reject(new Error("private cleanup fault")) : (remove as any)(file, ...args)) as any;
  }
  if (scenario === "diagnostic_error") {
    const original = fs.renameSync;
    fs.renameSync = ((from: any, to: any) => { if (String(to).includes("reviewer-runs")) throw new Error("private diagnostic fault"); original(from, to); }) as any;
  }
  if (scenario === "storage_error" && process.env.YOKEMATE_ROLE === "coordinator") {
    const original = fs.renameSync;
    fs.renameSync = ((from: any, to: any) => { if (String(to).includes("subagent-reports")) throw Object.assign(new Error("private storage fault"), { code: "EIO" }); original(from, to); }) as any;
  }
  if (scenario === "nonzero" || scenario === "plan_writer_nonzero") pi.on("session_shutdown", () => { if (process.env.YOKEMATE_ROLE === "executor") process.exit(7); });
  let calledA = false;
  let calledB = false;
  let observedOldBatch = false;
  pi.on("project_trust", () => ({ trusted: "yes", remember: false }));
  pi.on("session_start", async (_event, ctx) => {
    const file = realpathSync(import.meta.filename);
    await barrier("loaded", { pid: process.pid, file, hash: createHash("sha256").update(readFileSync(file)).digest("hex"), sessionId: ctx.sessionManager.getSessionId(), model: ctx.model?.id, thinking: ctx.thinkingLevel, commands: pi.getCommands().map((command) => ({ name: command.name, path: command.sourceInfo.path })), tools: pi.getAllTools().map((tool) => ({ name: tool.name, path: tool.sourceInfo.path })) });
  });
  pi.on("context", async (event) => {
    if (process.env.YOKEMATE_ROLE !== "coordinator") return;
    const reports = event.messages.filter((message) => message.role === "custom" && message.customType === "subagent-report");
    await barrier("context", reports);
  });
  pi.registerProvider("ym204-fixture", {
    baseUrl: "http://invalid.invalid",
    apiKey: "fixture-only",
    api: "ym204-fixture-api",
    models: [{ id: "deterministic", name: "Deterministic", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 100000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
        stream.push({ type: "start", partial: message });
        const text = JSON.stringify(context.messages);
        if (process.env.YOKEMATE_ROLE === "executor") {
          message.content.push({ type: "thinking", thinking: "fixture thinking" });
          stream.push({ type: "thinking_start", contentIndex: 0, partial: message });
          stream.push({ type: "thinking_delta", contentIndex: 0, delta: "fixture thinking", partial: message });
          const heavyReads = text.includes("read-heavy-32") ? 32 : text.includes("read-heavy-24") ? 24 : 0;
          if (heavyReads) {
            childTurns++;
            await barrier("child-working", { pid: process.pid, turn: childTurns });
            if (childTurns <= heavyReads + 3) {
              const tool = childTurns <= heavyReads
                ? { id: `read-${childTurns}`, name: "read", arguments: { path: process.env.YM204_FIXTURE_READ_FILE } }
                : { id: `shell-${childTurns}`, name: "bash", arguments: { command: ["grep -n fixture", "find . -maxdepth 1 -type f", "ls -la"][childTurns - heavyReads - 1] } };
              message.stopReason = "toolUse";
              message.content = [{ type: "toolCall", ...tool } as any];
              stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
              stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0] as any, partial: message });
            } else message.content = [{ type: "text", text: exactProfile(heavyReads === 24 ? 16070 : 25684, heavyReads === 24 ? "READ-HEAVY-216-TAIL" : "READ-HEAVY-217-TAIL") }];
            stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
            stream.end();
            return;
          }
          await barrier(scenario ? "child-working" : text.includes("review-B") ? "B-working" : "A-working", { pid: process.pid });
          childTurns++;
          if (scenario === "plan_writer_write_empty") {
            if (childTurns === 1) {
              message.stopReason = "toolUse";
              message.content = [{ type: "toolCall", id: "write-plan", name: "write", arguments: { path: process.env.YM204_FIXTURE_PLAN_PATH, content: process.env.YM204_FIXTURE_PLAN_CONTENT } } as any];
              stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
              stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0] as any, partial: message });
            } else message.content = [];
            stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
            stream.end();
            return;
          }
          message.content = [{ type: "text", text: '{"status":"approved",' }, { type: "text", text: '"findings":[]}' }];
          if (scenario === "plan_scout" || scenario === "plan_scout_terminal" || scenario === "plan_scout_failed_send") message.content = [{ type: "text", text: `# Scout\n\n## Facts and sources\n${"evidence line\n".repeat(5000)}EVIDENCE-TAIL${scenario === "plan_scout_failed_send" ? "-FAILED-SEND" : ""}${process.env.WORKFLOW_SCOUT_REVISION ?? ""}\n\n## Assumptions\n- Fixture assumption.\n\n## Forks and recommendations\n- Fixture recommendation.\n` }];
          if (scenario === "plan_writer" || scenario?.startsWith("plan_writer_")) message.content = [{ type: "text", text: readFileSync(process.env.YM204_FIXTURE_READ_FILE!, "utf8") }];
          if (scenario === "plan_writer_error") message.stopReason = "error";
          if (scenario === "plan_writer_aborted") message.stopReason = "aborted";
          if (scenario === "plan_writer_length") message.stopReason = "length";
          if (scenario === "plan_writer_protocol_invalid") fs.writeSync(1, "{private writer malformed}\n");
          if (scenario === "plan_scout_secret") message.content = [{ type: "text", text: `# Scout\n${"evidence line\n".repeat(5000)}\nconst token = "literal-secret-value"` }];
          if (scenario === "parallel_max" || scenario === "chain_max") message.content = [{ type: "text", text: JSON.stringify({ status: "approved", findings: [{ severity: "advice", lens: 1, file: "fixture.ts", line: 1, problem: "fixture", evidence: '"'.repeat(24000), fix: "fixture" }] }) }];
          if (scenario === "chain_long") message.content = [{ type: "text", text: text.includes("step-1") ? "x".repeat(60 * 1024) + "UNTRUNCATED-TAIL" : text.includes("UNTRUNCATED-TAIL") ? "tail received" : "tail missing" }];
          if (scenario === "missing" || (scenario === "old_final" && childTurns > 1)) message.content = [{ type: "thinking", thinking: "private thinking" }];
          if (scenario === "invalid" || (scenario === "chain" && text.includes("step-2"))) message.content = [{ type: "text", text: "{}" }];
          if (scenario === "output_limit") message.content = [{ type: "text", text: JSON.stringify({ status: "approved", findings: [], padding: "x".repeat(51 * 1024) }) }];
          if (scenario === "protocol_invalid") fs.writeSync(1, "{private malformed}\n");
          if (scenario === "old_final" && childTurns === 1) {
            message.stopReason = "toolUse";
            message.content.push({ type: "toolCall", id: "read-fixture", name: "read", arguments: { path: process.env.YM204_FIXTURE_READ_FILE } });
            stream.push({ type: "toolcall_start", contentIndex: 2, partial: message });
            stream.push({ type: "toolcall_end", contentIndex: 2, toolCall: message.content[2] as any, partial: message });
          }
          if (scenario === "retry" && childTurns === 1) {
            message.stopReason = "error";
            message.errorMessage = "503 overloaded fixture";
            stream.push({ type: "error", reason: "error", error: message });
            stream.end();
            return;
          }
        } else {
          const call = (id: string, task: string) => {
            message.stopReason = "toolUse";
            message.content = [{ type: "toolCall", id, name: "subagent", arguments: { agent: "task-reviewer", task, cwd: process.env.YM204_FIXTURE_REVIEW_CWD, review: { baseSha: process.env.YM204_FIXTURE_BASE, headSha: process.env.YM204_FIXTURE_HEAD } } }];
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
            stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0] as any, partial: message });
          };
          if (!calledA) {
            calledA = true;
            if (scenario?.includes("read_heavy")) {
              message.stopReason = "toolUse";
              const items = scenario.includes("parallel") ? ["read-heavy-24", "read-heavy-32"] : [scenario.includes("32") ? "read-heavy-32" : "read-heavy-24"];
              const tasks = items.map((task) => ({ agent: "plan-scout", task, ticket: "YM-204" }));
              message.content = [{ type: "toolCall", id: "read-heavy", name: "subagent", arguments: tasks.length === 1 ? tasks[0] : { tasks } }];
              stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
              stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0] as any, partial: message });
            } else if (scenario === "plan_scout_terminal") {
              message.stopReason = "toolUse";
              message.content = [{ type: "toolCall", id: "scout-terminal", name: "subagent", arguments: { agent: "plan-scout", task: "Return a complete fixture scout.", ticket: "YM-1" } }];
              stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
              stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0] as any, partial: message });
            } else call("batch-A", "review-A");
            if (scenario === "parallel" || scenario === "chain" || scenario === "chain_long" || scenario === "parallel_max" || scenario === "chain_max" || scenario === "public_cancel_parallel" || scenario === "public_cancel_chain") {
              const block = message.content[0] as any;
              const single = block.arguments;
              const parallel = scenario === "parallel" || scenario === "parallel_max" || scenario === "public_cancel_parallel";
              const length = scenario === "parallel_max" || scenario === "public_cancel_parallel" ? 8 : scenario === "chain_max" ? 20 : scenario === "chain" || scenario === "public_cancel_chain" ? 3 : 2;
              block.arguments = { [parallel ? "tasks" : "chain"]: Array.from({ length }, (_, i) => ({ ...single, agent: scenario === "chain_long" ? "worker" : single.agent, task: `step-${i + 1}${i ? " {previous}" : ""}` })) };
            }
          }
          else if (scenario?.startsWith("public_cancel") && !cancelIssued && text.includes('"kind":"ack"')) {
            const runIds = [...text.matchAll(/"runId":"([0-9a-f-]{36})"/g)].map((match) => match[1]!);
            const runId = scenario === "public_cancel_parallel" ? runIds.at(-1) : scenario === "public_cancel_chain" ? runIds[1] : runIds[0];
            if (!runId) throw new Error("public cancellation fixture did not observe child ACK runId");
            cancelIssued = true;
            cancelledRunId = runId;
            message.stopReason = "toolUse";
            message.content = [{ type: "toolCall", id: "cancel-child", name: "subagent", arguments: { cancelRun: runId } }];
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
            stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0] as any, partial: message });
          }
          else if (scenario !== "public_cancel" && scenario?.startsWith("public_cancel") && cancelIssued && text.includes('"status":"cancellation_requested"')) {
            await barrier("public-cancel-result", context.messages);
            message.content = [{ type: "text", text: "continued after deferred public cancellation" }];
          }
          else if (scenario?.startsWith("public_cancel") && cancelIssued && !repeatedCancelIssued && text.includes('"status":"cancelled"')) {
            repeatedCancelIssued = true;
            message.stopReason = "toolUse";
            message.content = [{ type: "toolCall", id: "repeat-cancel-child", name: "subagent", arguments: { cancelRun: cancelledRunId } }];
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
            stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0] as any, partial: message });
          }
          else if (scenario?.startsWith("public_cancel") && repeatedCancelIssued && text.includes('"status":"already_terminal"')) {
            await barrier("public-cancel-result", context.messages);
            message.content = [{ type: "text", text: "continued after public cancellation" }];
          }
          else if (!scenario && !calledB && text.includes("[subagent task-reviewer]")) { calledB = true; call("batch-B", "review-B"); }
          else {
            if (calledB && !observedOldBatch && text.includes("[subagent batch complete]")) {
              observedOldBatch = true;
              await barrier("old-batch-after-B", context.messages);
              message.stopReason = "toolUse";
              message.content = [{ type: "toolCall", id: "premature-finish", name: "coordinator_finish", arguments: { outcome: "blocked", summary: "premature", reason: "premature" } }];
              stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
              stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0] as any, partial: message });
            } else message.content = [{ type: "text", text: "Waiting for correlated results." }];
          }
        }
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
        stream.end();
      })().catch((error) => stream.end({ role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: String(error), timestamp: Date.now() }));
      return stream;
    },
  });
}
