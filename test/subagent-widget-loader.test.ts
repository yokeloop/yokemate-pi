import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { acknowledgeFixtureReports, createFixtureEngine, loadFixtureExtension, shutdownFixture, withFixtureEnvironment } from "./fixtures/subagent-fixture-engine.ts";

test("RPC with hasUI sends child widget lines and clears them on completion", async () => {
  const engine = createFixtureEngine({ label: "widget", gitRepository: true, agents: { "task-reviewer": "---\nname: task-reviewer\ndescription: Widget fixture\n---\n" } });
  await withFixtureEnvironment(engine, { YOKEMATE_SUBAGENT_TEST_TARGET: engine.resources["subagent-widget-child.js"] }, async () => {
    const childStates: { children: { identity: { runId: string } }[] }[] = [];
    const widgets: unknown[] = [];
    let cleared!: () => void;
    const completion = new Promise<void>((resolve) => { cleared = resolve; });
    const fixture = await loadFixtureExtension(engine, { sessionId: "widget-session", hasUI: true, ui: { setWidget: (key: string, content: unknown) => {
      assert.equal(key, "subagent-running");
      widgets.push(content);
      if (content === undefined && widgets.length > 1) cleared();
    } } });
    const originalAppend = fixture.loader.getExtensions().runtime.appendEntry;
    fixture.loader.getExtensions().runtime.appendEntry = ((type: string, data: any) => {
      originalAppend(type, data);
      assert.equal(type, "yokemate-child-state");
      childStates.push(data);
    }) as any;
    const headSha = execFileSync("git", ["-C", engine.repository!, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const start = fixture.sent.length;
    const result = await fixture.tool.execute("widget-test", { agent: "task-reviewer", task: "review the diff", cwd: engine.repository, review: { baseSha: headSha, headSha } }, undefined, () => undefined, fixture.ctx);
    assert.equal("isError" in result && result.isError, false);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([completion, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("child widget did not clear")), 5000); })]);
    } finally {
      clearTimeout(timer);
    }
    assert.ok(Array.isArray(widgets[0]));
    assert.match((widgets[0] as string[])[0]!, /^task-reviewer \d+:\d{2} review the diff$/);
    assert.equal(widgets.at(-1), undefined);
    const ack = result.details as { children: { identity: { runId: string } }[] };
    assert.deepEqual(childStates[0]!.children.map((child) => child.identity.runId), ack.children.map((child) => child.identity.runId));
    assert.deepEqual(childStates.at(-1)!.children, []);
    const started = Date.now();
    while (fixture.sent.length !== start + 2) {
      if (Date.now() - started > 5000) throw new Error("widget reports timed out");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await acknowledgeFixtureReports(fixture, fixture.sent.slice(start));
    await shutdownFixture(fixture);
  });
});
