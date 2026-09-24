import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyResearchMcp, normalizeResearchScript } from "../src/research-mcp.ts";
import type { ResearchIdentity } from "../src/research-guard.ts";

test("research mcpScript regenerates only data-only calls", () => {
  assert.equal(
    normalizeResearchScript('const result = await tools.search({"query":"docs"}); emit(result);'),
    'const result = await tools.search({"query":"docs"});\nemit(result);',
  );
  for (const code of ["import x from 'x'", "const x = await tools.call(name, {})", "while (true) {}", "emit(globalThis)"])
    assert.throws(() => normalizeResearchScript(code));
});

test("research MCP checks exact server, tool, and payload", () => {
  const identity: ResearchIdentity = { root: "/engine", id: "r", project: "acme/app", projectPath: "/clone", sessionId: "s", role: "worker" };
  const previous = { mode: process.env.YOKEMATE_MODE, tracker: process.env.YOKEMATE_RESEARCH_TRACKER, key: process.env.YOKEMATE_RESEARCH_TRACKER_KEY };
  process.env.YOKEMATE_MODE = "research";
  process.env.YOKEMATE_RESEARCH_TRACKER = "acme";
  process.env.YOKEMATE_RESEARCH_TRACKER_KEY = "ACME";
  try {
    assert.equal(classifyResearchMcp("firecrawl", "firecrawl_search", { query: "docs", limit: 1 }, identity).ok, true);
    assert.equal(classifyResearchMcp("firecrawl", "firecrawl_search", { query: "docs", command: "rm" }, identity).ok, false);
    assert.equal(classifyResearchMcp("youtrack-acme", "get_issue_fields_schema", { projectKey: "ACME" }, identity).ok, true);
    assert.equal(classifyResearchMcp("youtrack-acme", "create_issue", { project: "ACME", summary: "Research" }, identity).ok, true);
    assert.equal(classifyResearchMcp("youtrack-acme", "create_issue", { project: "OTHER", summary: "Research" }, identity).ok, false);
  } finally {
    if (previous.mode === undefined) delete process.env.YOKEMATE_MODE; else process.env.YOKEMATE_MODE = previous.mode;
    if (previous.tracker === undefined) delete process.env.YOKEMATE_RESEARCH_TRACKER; else process.env.YOKEMATE_RESEARCH_TRACKER = previous.tracker;
    if (previous.key === undefined) delete process.env.YOKEMATE_RESEARCH_TRACKER_KEY; else process.env.YOKEMATE_RESEARCH_TRACKER_KEY = previous.key;
  }
});
