import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const helper = new URL("./fixtures/bounded-runtime-case.ts", import.meta.url).href;

test("runtime case timeouts finish cleanup before the next scenario", { timeout: 15000 }, () => {
  const sandbox = mkdtempSync(join(tmpdir(), "runtime-timeout-"));
  const fixture = join(sandbox, "timeout.test.mts");
  try {
    writeFileSync(fixture, `
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:net";
import { runBoundedRuntimeCase, untilAborted } from ${JSON.stringify(helper)};

for (const scenario of ["stalled request", "missing child barrier"]) {
  const priorEnv = { ...process.env };
  let cleaned = false;
  let server;
  let timer;
  test(scenario, { timeout: 100 }, (t) => runBoundedRuntimeCase(t, async (signal) => {
    process.env.RUNTIME_TIMEOUT_CASE = scenario;
    server = createServer();
    try {
      await untilAborted(new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)), signal);
      const pending = new Promise((resolve) => {
        if (scenario === "stalled request") timer = setTimeout(resolve, 30000);
      });
      await untilAborted(pending, signal);
      assert.fail("stalled operation unexpectedly resolved");
    } finally {
      clearTimeout(timer);
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, priorEnv);
      cleaned = true;
    }
  }));
  test(scenario + " successor", () => {
    assert.equal(cleaned, true);
    assert.equal(server.listening, false);
    assert.deepEqual({ ...process.env }, priorEnv);
  });
}
`);
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--test", fixture], { env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10000 });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.signal, null);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /not ok 1 - stalled request\n/);
    assert.match(result.stdout, /ok 2 - stalled request successor\n/);
    assert.match(result.stdout, /not ok 3 - missing child barrier\n/);
    assert.match(result.stdout, /ok 4 - missing child barrier successor\n/);
    assert.equal((result.stdout.match(/failureType: 'testTimeoutFailure'/g) ?? []).length, 2, result.stdout);
    assert.match(result.stdout, /# pass 2\n/);
    assert.match(result.stdout, /# fail 0\n/);
    assert.match(result.stdout, /# cancelled 2\n/);
    assert.equal(result.stderr, "");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
