import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { RuntimeResources, stopOwnedProcess, waitForEvent } from "./fixtures/runtime-resources.ts";

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

test("waitForEvent rejects an early close and removes every listener", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const socket = createConnection(address.port, "127.0.0.1");
  const pending = waitForEvent(socket, "data", { timeoutMs: 1000, label: "fixture checkpoint" });
  socket.destroy();
  await assert.rejects(pending, /fixture checkpoint source closed/);
  assert.equal(socket.listenerCount("data"), 0);
  assert.equal(socket.listenerCount("error"), 0);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("RuntimeResources destroys a held peer and proves server close", async () => {
  const resources = new RuntimeResources(undefined, 3000);
  const server = createServer();
  resources.server(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const peer = createConnection(address.port, "127.0.0.1");
  await waitForEvent(peer, "connect", { timeoutMs: 1000 });
  await resources.cleanup();
  assert.equal(server.listening, false);
  assert.equal(peer.destroyed, true);
});

test("stopOwnedProcess gives a TERM-ignoring child the production grace then reaps it", { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); process.stdout.write('ready\\n'); setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "pipe"] });
  assert.ok(child.stdout);
  await waitForEvent(child.stdout, "data", { timeoutMs: 1000, closeEvents: ["close"], label: "TERM-ignore ready" });
  const started = Date.now();
  await stopOwnedProcess(child);
  assert.ok(Date.now() - started >= 4900);
  assert.equal(child.signalCode, "SIGKILL");
});
