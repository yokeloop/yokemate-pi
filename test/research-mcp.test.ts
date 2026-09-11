import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeResearchScript } from "../src/research-mcp.ts";

test("research mcpScript regenerates only data-only calls", () => {
  assert.equal(
    normalizeResearchScript('const result = await tools.search({"query":"docs"}); emit(result);'),
    'const result = await tools.search({"query":"docs"});\nemit(result);',
  );
  for (const code of ["import x from 'x'", "const x = await tools.call(name, {})", "while (true) {}", "emit(globalThis)"])
    assert.throws(() => normalizeResearchScript(code));
});
