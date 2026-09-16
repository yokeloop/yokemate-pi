import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("patched MCP adapter preserves consent, sampling, transport and real Pi loading", { timeout: 60_000 }, () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ym204-mcp-compat-"));
  try {
    const output = execFileSync(process.execPath, [join(import.meta.dirname, "fixtures/mcp-adapter-compat.mjs")], {
      cwd: sandbox,
      env: {
        PATH: process.env.PATH,
        HOME: sandbox,
        XDG_CONFIG_HOME: join(sandbox, "config"),
        XDG_CACHE_HOME: join(sandbox, "cache"),
        XDG_DATA_HOME: join(sandbox, "data"),
        XDG_STATE_HOME: join(sandbox, "state"),
        PI_CODING_AGENT_DIR: join(sandbox, "agent"),
      },
      timeout: 55_000,
      encoding: "utf8",
      maxBuffer: 1_000_000,
    });
    assert.match(output, /MCP compatibility: consent, errors, sampling, socket, loader passed/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
