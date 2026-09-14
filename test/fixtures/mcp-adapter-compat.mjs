import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = await import(pathToFileURL(requirePi.resolve("jiti")).href);
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
const adapterRoot = dirname(fileURLToPath(import.meta.resolve("pi-mcp-adapter")));
const load = (name) => jiti.import(join(adapterRoot, `${name}.ts`));

const { ConsentManager } = await load("consent-manager");
const consent = new ConsentManager();
assert.equal(consent.requiresPrompt("fixture"), true);
consent.registerDecision("fixture", true);
assert.equal(consent.requiresPrompt("fixture"), false);
consent.registerDecision("fixture", false);
assert.throws(() => consent.ensureApproved("fixture"));
const always = new ConsentManager("always");
always.registerDecision("fixture", true);
always.ensureApproved("fixture");
assert.throws(() => always.ensureApproved("fixture"));
assert.equal(new ConsentManager("never").requiresPrompt("fixture"), false);

const { ensureToolCallApproved } = await load("tool-approval");
const { MCP_TOOL_APPROVAL_REQUEST_EVENT } = await load("types");
let claims = 0;
let decision = "allow_once";
const state = {
  config: { mcpServers: {}, settings: { approveTools: true } },
  approvedToolCalls: new Map(),
  approvalEvents: {
    emit(name, request) {
      assert.equal(name, MCP_TOOL_APPROVAL_REQUEST_EVENT);
      claims++;
      assert.equal(request.claim(() => decision), true);
      assert.equal(request.claim(() => "allow_for_session"), false);
    },
  },
};
const tool = { name: "fixture_read", originalName: "read" };
for (let i = 0; i < 2; i++) assert.deepEqual(await ensureToolCallApproved(state, "fixture", tool, {}), { ok: true });
assert.equal(claims, 2);
assert.equal(state.approvedToolCalls.size, 0);
decision = "deny";
assert.deepEqual(await ensureToolCallApproved(state, "fixture", tool, {}), { ok: false, reason: "denied" });
delete state.approvalEvents;
assert.deepEqual(await ensureToolCallApproved(state, "fixture", tool, {}), { ok: false, reason: "approval_required_headless" });

const { OAuthCredentialStoreError } = await load("mcp-auth");
const cause = new Error("fixture");
const authError = new OAuthCredentialStoreError("unavailable", "read", cause);
assert.equal(authError.operation, "read");
assert.equal(authError.cause, cause);
assert.equal(authError.code, "OAUTH_CREDENTIAL_STORE_UNAVAILABLE");
const { SessionRecoveryAuthRequiredError } = await load("session-recovery");
const recovery = new SessionRecoveryAuthRequiredError("fixture");
assert.equal(recovery.serverName, "fixture");
assert.equal(recovery.authMessage, undefined);
assert.match(recovery.message, /fixture/);
assert.equal(new SessionRecoveryAuthRequiredError("fixture", "custom").message, "custom");

const compat = await jiti.import("@earendil-works/pi-ai/compat");
const { createAssistantMessageEventStream } = await jiti.import("@earendil-works/pi-ai");
const { handleSamplingRequest } = await load("sampling-handler");
const model = { id: "fixture", name: "fixture", api: "ym204-fixture", provider: "fixture", baseUrl: "http://invalid.invalid", reasoning: false, input: ["text"], contextWindow: 1024, maxTokens: 32, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
let calls = 0;
const stream = (_model, _context, options) => {
  calls++;
  assert.deepEqual(options.headers, { "x-delete": null, "x-keep": "fixture" });
  const events = createAssistantMessageEventStream();
  const message = { role: "assistant", content: [{ type: "text", text: "fixture reply" }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  events.push({ type: "done", reason: "stop", message });
  events.end(message);
  return events;
};
compat.registerApiProvider({ api: model.api, stream, streamSimple: stream }, "ym204-fixture");
try {
  const options = {
    serverName: "fixture", autoApprove: false,
    modelRegistry: { getAvailable: () => [model], getApiKeyAndHeaders: async () => ({ ok: true, headers: { "x-delete": null, "x-keep": "fixture" } }) },
    getCurrentModel: () => model, getSignal: () => undefined,
  };
  const request = { method: "sampling/createMessage", params: { messages: [{ role: "user", content: { type: "text", text: "fixture" } }], maxTokens: 16 } };
  await assert.rejects(() => handleSamplingRequest(options, request), /interactive approval/);
  assert.equal(calls, 0);
  let approvals = 0;
  const response = await handleSamplingRequest({ ...options, ui: { confirm: async () => { approvals++; return true; } } }, request);
  assert.equal(response.content.text, "fixture reply");
  assert.equal(approvals, 2);
  assert.equal(calls, 1);
} finally {
  compat.unregisterApiProviders("ym204-fixture");
}

const { UnixSocketClientTransport } = await load("unix-socket-transport");
const socketPath = join(process.cwd(), "fixture.sock");
const server = createServer();
const sockets = new Set();
server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
server.listen(socketPath);
await once(server, "listening");
const transport = new UnixSocketClientTransport(socketPath);
try {
  await transport.start();
  const messages = [];
  transport.onmessage = (message) => messages.push(message);
  const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "fixture", params: { text: "Привет" } }) + "\n");
  const split = bytes.indexOf(Buffer.from("П")) + 1;
  transport.socket.emit("data", bytes.subarray(0, split));
  assert.equal(messages.length, 0);
  transport.socket.emit("data", bytes.subarray(split));
  transport.socket.emit("data", JSON.stringify({ jsonrpc: "2.0", method: "string" }) + "\n");
  assert.equal(messages[0].params.text, "Привет");
  assert.equal(messages[1].method, "string");
  let malformed;
  transport.onerror = (error) => { malformed = error; };
  transport.socket.emit("data", '{"jsonrpc":"invalid"}\n');
  assert.ok(malformed instanceof Error);
} finally {
  await transport.close();
  for (const socket of sockets) socket.destroy();
  await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
}

const entry = join(process.cwd(), "adapter-entry.ts");
writeFileSync(entry, `import { createMcpAdapter } from ${JSON.stringify(join(adapterRoot, "index.ts"))};\nexport default createMcpAdapter({ config: { mcpServers: {}, imports: [], settings: { scriptMode: true } } });\n`);
const loader = new DefaultResourceLoader({
  cwd: process.cwd(), agentDir: join(process.cwd(), "agent"),
  settingsManager: SettingsManager.inMemory({}),
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  additionalExtensionPaths: [entry],
});
await loader.reload();
const loaded = loader.getExtensions();
assert.deepEqual(loaded.errors, []);
const extension = loaded.extensions.find((item) => resolve(item.resolvedPath) === entry);
assert.ok(extension);
assert.ok(extension.tools.has("mcp"));
assert.ok(extension.tools.has("mcpScript"));
assert.ok(extension.handlers.has("session_start"));
console.log("MCP compatibility: consent, errors, sampling, socket, loader passed");
