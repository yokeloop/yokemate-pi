import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { convertToLlm, CustomMessageComponent, DefaultResourceLoader, initTheme, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { reportContent, type ReportDelivery, type ReportEnvelope } from "../src/subagent-runs.ts";

const root = resolve(import.meta.dirname, "..");
const extension = join(root, ".pi/extensions/subagent/index.ts");
const child = join(root, "test/fixtures/subagent-report-child.js");

async function waitFor(predicate: () => boolean, timeout = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("report fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("real loader keeps canonical reports byte-equivalent while renderer collapses and expands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ym217-loader-"));
  const agentDir = join(dir, "agent");
  const originalArgv = process.argv[1];
  const originalCwd = process.cwd();
  const sent: { message: any; options: any }[] = [];
  let providerTurns = 0;
  try {
    mkdirSync(join(dir, ".pi/agents"), { recursive: true });
    writeFileSync(join(dir, ".pi/agents/worker.md"), "---\nname: worker\ndescription: report fixture\n---\nReturn output.\n");
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir,
      settingsManager: SettingsManager.create(dir, agentDir),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [extension],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    loaded.runtime.appendEntry = () => undefined;
    loaded.runtime.sendMessage = ((message: any, options: any) => { sent.push({ message, options }); }) as any;
    const tool = loaded.extensions.flatMap((entry) => [...entry.tools.values()]).find((entry) => entry.definition.name === "subagent");
    assert.ok(tool);
    const ctx = { cwd: dir, mode: "rpc", hasUI: false, model: undefined, thinkingLevel: "off", ui: { setWidget: () => undefined }, sessionManager: { getSessionId: () => "loader-session" } } as unknown as ExtensionContext;
    process.chdir(dir);
    process.argv[1] = child;
    const ack = await tool.definition.execute("loader-batch", { agent: "worker", task: "produce multiline canonical output" }, undefined, () => undefined, ctx);
    assert.match((ack.content[0] as any).text, /^Detached, not terminal: /);
    const parsedAck = JSON.parse((ack.content[0] as any).text.slice("Detached, not terminal: ".length));
    assert.deepEqual(parsedAck, { version: 1, kind: "ack", terminal: false, batchId: "loader-batch", children: (ack.details as any).children });
    assert.equal((ack.details as any).display.members[0].taskExcerpt, "produce multiline canoni");
    await waitFor(() => sent.length === 2);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent.map((entry) => entry.options), [
      { deliverAs: "followUp", triggerTurn: true },
      { deliverAs: "followUp", triggerTurn: true },
    ]);
    for (const { message } of sent) {
      const envelope = message.details.envelope as ReportEnvelope;
      const delivery = { deliveryId: message.details.deliveryId, envelopeHash: message.details.envelopeHash } as ReportDelivery;
      assert.equal(message.content, reportContent(envelope, delivery));
      assert.equal(message.customType, "subagent-report");
      assert.equal(message.display, true);
      assert.equal(message.details.display.version, 1);
      const llm = convertToLlm([{ role: "custom", timestamp: 0, ...message }]);
      assert.equal((llm[0]!.content[0] as any).text, message.content);
    }
    assert.equal(sent[0]!.message.details.envelope.kind, "result");
    assert.equal(sent[1]!.message.details.envelope.kind, "batch");
    assert.equal(sent[0]!.message.details.envelope.identity.runId, parsedAck.children[0].identity.runId);

    initTheme("dark", false);
    const renderer = loaded.extensions.flatMap((entry) => [...entry.messageRenderers.entries()]).find(([name]) => name === "subagent-report")?.[1];
    assert.ok(renderer);
    const component = new CustomMessageComponent({ role: "custom", timestamp: 0, ...sent[0]!.message }, renderer, undefined, 1);
    const collapsed = component.render(80).map(stripTerminalSequences);
    assert.equal(collapsed.filter((line) => line.trim()).length, 1);
    assert.match(collapsed.join("\n"), /worker.*result.*done.*produce multiline/);
    for (const width of [1, 2, 3, 40, 80, 120]) assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
    const sendsBefore = sent.length;
    component.setExpanded(true);
    const expanded = component.render(120).map(stripTerminalSequences).join("\n");
    assert.match(expanded, /canonical tail/);
    assert.match(expanded, /report\.txt:/);
    component.setExpanded(false);
    component.setOutputPad(2);
    component.invalidate();
    component.render(40);
    assert.equal(sent.length, sendsBefore);
    assert.equal(providerTurns, 0);

    const legacy = { ...sent[0]!.message, details: { envelope: sent[0]!.message.details.envelope } };
    const legacyComponent = new CustomMessageComponent({ role: "custom", timestamp: 0, ...legacy }, renderer, undefined, 1);
    assert.doesNotThrow(() => legacyComponent.render(40));
    legacyComponent.setExpanded(true);
    assert.match(legacyComponent.render(120).map(stripTerminalSequences).join("\n"), /canonical tail/);
  } finally {
    process.argv[1] = originalArgv;
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
