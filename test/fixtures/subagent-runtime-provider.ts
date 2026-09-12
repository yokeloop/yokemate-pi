import { connect } from "node:net";
import { realpathSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const barrier = (phase: string, data: unknown = {}) => new Promise<void>((resolve, reject) => {
    const socket = connect(process.env.YM204_FIXTURE_SOCKET!);
    socket.once("connect", () => socket.write(JSON.stringify({ phase, role: process.env.YOKEMATE_ROLE, runId: process.env.YOKEMATE_RUN_ID, data }) + "\n"));
    socket.once("data", () => { socket.end(); resolve(); });
    socket.once("error", reject);
  });
  let calledA = false;
  let calledB = false;
  let observedOldBatch = false;
  pi.on("project_trust", () => ({ trusted: "yes", remember: false }));
  pi.on("session_start", async (_event, ctx) => {
    const file = realpathSync(import.meta.filename);
    await barrier("loaded", { file, hash: createHash("sha256").update(readFileSync(file)).digest("hex"), sessionId: ctx.sessionManager.getSessionId(), model: ctx.model?.id, thinking: ctx.thinkingLevel, tools: pi.getAllTools().map((tool) => ({ name: tool.name, path: tool.sourceInfo.path })) });
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
          await barrier(text.includes("review-B") ? "B-working" : "A-working");
          message.content = [{ type: "text", text: '{"status":"approved",' }, { type: "text", text: '"findings":[]}' }];
        } else {
          const call = (id: string, task: string) => {
            message.stopReason = "toolUse";
            message.content = [{ type: "toolCall", id, name: "subagent", arguments: { agent: "task-reviewer", task, cwd: process.env.YM204_FIXTURE_REVIEW_CWD, review: { baseSha: process.env.YM204_FIXTURE_BASE, headSha: process.env.YM204_FIXTURE_HEAD } } }];
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
            stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0] as any, partial: message });
          };
          if (!calledA) { calledA = true; call("batch-A", "review-A"); }
          else if (!calledB && text.includes("[subagent task-reviewer]")) { calledB = true; call("batch-B", "review-B"); }
          else {
            if (calledB && !observedOldBatch && text.includes("[subagent batch complete]")) {
              observedOldBatch = true;
              await barrier("old-batch-after-B", context.messages);
            }
            message.content = [{ type: "text", text: "Waiting for correlated results." }];
          }
        }
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
        stream.end();
      })().catch((error) => stream.end({ role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: String(error), timestamp: Date.now() }));
      return stream;
    },
  });
}
