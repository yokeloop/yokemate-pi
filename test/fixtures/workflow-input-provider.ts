import { createHash } from "node:crypto";
import { connect } from "node:net";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const socketPath = process.env.WORKFLOW_INPUT_SOCKET!;
const marker = process.env.WORKFLOW_INPUT_RENDER_MARKER!;
const readyMarker = process.env.WORKFLOW_INPUT_READY_MARKER!;
const mainMarker = process.env.WORKFLOW_INPUT_MAIN_MARKER!;
const scenario = process.env.WORKFLOW_INPUT_SCENARIO ?? "none";
const report = (phase: string, data: Record<string, unknown> = {}, wait = false): Promise<string> => new Promise((resolve, reject) => {
  const socket = connect(socketPath);
  let response = "";
  socket.once("connect", () => {
    socket.write(JSON.stringify({ phase, at: performance.now(), ...data }) + "\n");
    if (!wait) socket.end(() => resolve(""));
  });
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => { response += chunk; if (response.includes("\n")) { socket.end(); resolve(response.trim()); } });
  socket.once("error", reject);
});
const assistant = (model: any): AssistantMessage => ({ role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });

export default function (pi: ExtensionAPI) {
  pi.registerMarkdownTransformer((markdown, context) => context.messageType === "user" ? `${markdown}\n\n${marker}` : markdown);
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("workflow-input-ready", readyMarker);
    await report("session_start", { sessionId: hash(ctx.sessionManager.getSessionId()) });
  });
  pi.on("input", (event) => { void report("input", { inputHash: hash(event.text), source: event.source }); });
  pi.on("turn_start", () => { void report("turn_start"); });
  pi.on("message_start", (event) => { if (event.message.role === "user") void report("message_start_user"); });
  pi.registerProvider("workflow-input-fixture", {
    baseUrl: "http://invalid.invalid",
    apiKey: "fixture-only",
    api: "workflow-input-fixture-api",
    models: [{ id: "deterministic", name: "Deterministic", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const message = assistant(model);
        stream.push({ type: "start", partial: message });
        const extraction = context.systemPrompt?.includes("Classify only the current raw interactive engineer input") ?? false;
        if (!extraction) {
          await report("main_enter", { contextHash: hash(JSON.stringify(context.messages)) }, scenario === "hold-main");
          message.content = [{ type: "text", text: mainMarker }];
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: mainMarker, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: mainMarker, partial: message });
          if (scenario === "timeout") {
            message.stopReason = "toolUse";
            message.content.push({ type: "toolCall", id: "early-do", name: "subagent", arguments: { coordinator: { mode: "do", tickets: ["YM-1"] } } });
            stream.push({ type: "toolcall_start", contentIndex: 1, partial: message });
            stream.push({ type: "toolcall_end", contentIndex: 1, toolCall: message.content[1] as Extract<typeof message.content[number], { type: "toolCall" }>, partial: message });
          }
          stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
          stream.end();
          return;
        }
        const payload = JSON.parse(String(context.messages.at(-1)?.content ?? "{}"));
        const bindings = Array.isArray(payload.bindings) ? payload.bindings : [];
        const raw = String(payload.raw ?? "");
        await report("extraction_enter", { inputHash: hash(raw), bindingCount: bindings.length, bindingBytes: Buffer.byteLength(JSON.stringify(bindings), "utf8") }, true);
        if (scenario === "error") throw new Error("SENTINEL_PRIVATE_PROVIDER_ERROR");
        if (scenario === "timeout") {
          await new Promise<void>((resolve) => setTimeout(resolve, 30000));
          if (options?.signal?.aborted) await report("extraction_late_after_abort");
        }
        let value: unknown = { kind: "none" };
        if (scenario === "approval") value = { kind: "advance-plan-do", ticket: "YM-1", binding: null, actions: ["plan", "do"], evidence: [{ start: 0, end: raw.length, text: raw }] };
        if (scenario === "malformed") value = { kind: "advance-plan-do", ticket: "YM-1" };
        const text = JSON.stringify(value);
        message.content = [{ type: "text", text }];
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      })().catch((error) => {
        const message = assistant(model);
        message.stopReason = "error";
        message.errorMessage = String(error);
        stream.push({ type: "error", reason: "error", error: message });
        stream.end();
      });
      return stream;
    },
  });
}
