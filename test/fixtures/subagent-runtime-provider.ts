import { connect } from "node:net";
import fs, { realpathSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function exactProfile(bytes: number, tail: string): string {
  const prefix = "# Scout\n\n## Facts and sources\n- Протокол проверен.\n\n";
  const suffix = `\n${tail}\n\n## Assumptions\n- Deterministic.\n\n## Forks and recommendations\n- Keep framing bounded.\n`;
  return prefix + "x".repeat(bytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)) + suffix;
}

async function writeStdoutRecord(event: unknown): Promise<void> {
  const record = Buffer.from(`${JSON.stringify(event)}\n`);
  let offset = 0;
  while (offset < record.length) {
    try { offset += fs.writeSync(1, record, offset, record.length - offset); }
    catch (error) {
      if (!["EAGAIN", "EWOULDBLOCK", "ENOBUFS"].includes(String((error as NodeJS.ErrnoException).code))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
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
  let aggregateTurns = 0;
  let aggregateSequence = 0;
  let reportSends = 0;
  let providerCalls = 0;
  let contextCalls = 0;
  if (scenario === "owned_busy_report_boundary" && process.env.YOKEMATE_ROLE === "coordinator") {
    pi.registerTool({
      name: "fixture_hold",
      label: "Fixture hold",
      description: "Hold the current tool batch on the fixture barrier.",
      parameters: Type.Object({ phase: Type.String() }),
      async execute(_id, params) {
        await barrier(params.phase, { providerCalls });
        return { content: [{ type: "text", text: `${params.phase} released` }], details: { phase: params.phase } };
      },
    });
  }
  if (scenario?.startsWith("delivery_") && process.env.YOKEMATE_ROLE === "coordinator") {
    const original = AgentSession.prototype.sendCustomMessage;
    AgentSession.prototype.sendCustomMessage = function (message, options) {
      if (message.customType !== "subagent-report") return original.call(this, message, options);
      reportSends++;
      const target = scenario.endsWith("_batch") ? reportSends === 2 : scenario.endsWith("_both") ? true : reportSends === 1;
      if (!target) return original.call(this, message, options);
      if (scenario === "delivery_async_after_observed") return original.call(this, message, options).then(async () => { await barrier("async-fault-after-observed", { reportSends }); throw new Error("fixture asynchronous transport error"); });
      if (scenario.startsWith("delivery_sync")) throw new Error("fixture synchronous transport error");
      return Promise.reject(new Error("fixture asynchronous transport error"));
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
  pi.on("agent_end", async (event) => {
    if (!["coordinator_aggregate", "child_aggregate"].includes(scenario ?? "")) return;
    const serializedMessages = JSON.stringify(event.messages);
    const serializedEvent = JSON.stringify({ ...event, willRetry: false });
    const bytes = Buffer.byteLength(serializedEvent);
    if (bytes <= 1024 * 1024) return;
    aggregateSequence++;
    await barrier("aggregate-raw", { sequence: aggregateSequence, count: event.messages.length, bytes: Buffer.byteLength(serializedMessages), sha256: createHash("sha256").update(serializedMessages).digest("hex"), rawEventBytes: bytes, rawEventHash: createHash("sha256").update(serializedEvent).digest("hex") });
  });
  pi.on("context", async (event) => {
    if (process.env.YOKEMATE_ROLE !== "coordinator" && !(scenario === "snapshot_probe" && process.env.YOKEMATE_ROLE !== "executor")) return;
    const reports = event.messages.filter((message) => message.role === "custom" && message.customType === "subagent-report");
    contextCalls++;
    await barrier("context", scenario === undefined || scenario === "owned_busy_report_boundary" || scenario === "owned_active_child_yield" ? { ordinal: contextCalls, providerCalls, reports } : reports);
  });
  pi.on("turn_end", async () => {
    if (process.env.YOKEMATE_ROLE === "coordinator" && (scenario === "owned_busy_report_boundary" || scenario === "owned_active_child_yield")) await barrier("turn-end-provider", { providerCalls, contextCalls });
  });
  pi.registerProvider("ym204-fixture", {
    baseUrl: "http://invalid.invalid",
    apiKey: "fixture-only",
    api: "ym204-fixture-api",
    models: [{ id: "deterministic", name: "Deterministic", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 100000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        providerCalls++;
        const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
        stream.push({ type: "start", partial: message });
        const text = JSON.stringify(context.messages);
        const aggregateRun = scenario === "coordinator_aggregate" && process.env.YOKEMATE_ROLE === "coordinator" || scenario === "child_aggregate" && process.env.YOKEMATE_ROLE === "executor";
        if (aggregateRun) {
          aggregateTurns++;
          if (aggregateTurns <= 40) {
            message.stopReason = "toolUse";
            message.content = [{ type: "toolCall", id: `aggregate-read-${aggregateTurns}`, name: "read", arguments: { path: process.env.YM204_FIXTURE_READ_FILE } } as any];
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
            stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0] as any, partial: message });
          } else {
            message.content = [{ type: "text", text: scenario === "child_aggregate" ? '{"status":"approved","findings":[]}' : "coordinator aggregate complete" }];
          }
          stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
          stream.end();
          return;
        }
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
          if (scenario === "protocol_oversized_unknown") await writeStdoutRecord({ type: "future_event", content: "x".repeat(1024 * 1024) });
          if (scenario === "protocol_oversized_control") await writeStdoutRecord({ type: "response", id: "oversized", success: true, data: "x".repeat(1024 * 1024) });
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
            if (scenario === "owned_busy_report_boundary") {
              message.stopReason = "toolUse";
              message.content = [
                { type: "toolCall", id: "busy-child", name: "subagent", arguments: { agent: "task-reviewer", task: "owned busy report", cwd: process.env.YM204_FIXTURE_REVIEW_CWD, review: { baseSha: process.env.YM204_FIXTURE_BASE, headSha: process.env.YM204_FIXTURE_HEAD } } },
                { type: "toolCall", id: "busy-tool", name: "fixture_hold", arguments: { phase: "coordinator-tool-held" } },
              ];
              for (let index = 0; index < message.content.length; index++) {
                stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
                stream.push({ type: "toolcall_end", contentIndex: index, toolCall: message.content[index] as any, partial: message });
              }
            } else if (scenario === "owned_active_child_yield") {
              call("active-child", "owned active yield");
            } else if (scenario === "snapshot_probe") {
              message.stopReason = "toolUse";
              const single = { agent: "worker", task: "return deterministic snapshot probe" };
              message.content = [{ type: "toolCall", id: "snapshot-probe", name: "subagent", arguments: process.env.YM245_PRESERVATION === "1" ? { tasks: [single, { ...single, task: "return held-delivery snapshot probe" }] } : single }];
              stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
              stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0] as any, partial: message });
            } else if (scenario?.includes("read_heavy")) {
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
            } else call("batch-A", scenario === "child_aggregate" ? "aggregate-child" : "review-A");
            if (scenario === "parallel" || scenario === "chain" || scenario === "chain_long" || scenario === "parallel_max" || scenario === "chain_max") {
              const block = message.content[0] as any;
              const single = block.arguments;
              const parallel = scenario === "parallel" || scenario === "parallel_max";
              const length = scenario === "parallel_max" ? 8 : scenario === "chain_max" ? 20 : scenario === "chain" ? 3 : 2;
              block.arguments = { [parallel ? "tasks" : "chain"]: Array.from({ length }, (_, i) => ({ ...single, agent: scenario === "chain_long" ? "worker" : single.agent, task: `step-${i + 1}${i ? " {previous}" : ""}` })) };
            }
          }
          else if ((scenario === "owned_busy_report_boundary" || scenario === "owned_active_child_yield") && text.includes("[subagent task-reviewer]")) {
            await barrier("owned-report-provider", { providerCalls, context: contextCalls });
            message.content = [{ type: "text", text: "Observed owned report." }];
          }
          else if (scenario === "owned_busy_report_boundary") {
            message.stopReason = "toolUse";
            message.content = [{ type: "toolCall", id: `unexpected-busy-${providerCalls}`, name: "fixture_hold", arguments: { phase: "unexpected-before-report" } }];
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
            stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0] as any, partial: message });
          }
          else if (scenario === "owned_active_child_yield") {
            message.stopReason = "toolUse";
            message.content = [{ type: "toolCall", id: `unexpected-active-${providerCalls}`, name: "read", arguments: { path: process.env.YM204_FIXTURE_READ_FILE } }];
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
            stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0] as any, partial: message });
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
