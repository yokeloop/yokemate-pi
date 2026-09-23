import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { spawn } from "node:child_process";
import { discoverTestFiles, LIGHT_TEST_FILES, MANIFEST_ADAPTER_FILES, partitionTestFiles, standardAdmissionRoot } from "../scripts/test-suite.ts";
import { runSupervisedFile, scheduleRuntimeFiles } from "../scripts/test-runner.ts";

const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function temporaryTestDirectory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ym284-suite-"));
  roots.push(root);
  return root;
}

function fixture(root: string, name: string): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, "import { test } from 'node:test'; test('ok', () => {});\n");
  return file;
}

test("test discovery partitions every file exactly once and defaults unknown files to runtime", () => {
  const root = temporaryTestDirectory();
  for (const name of [...LIGHT_TEST_FILES, ...MANIFEST_ADAPTER_FILES, "runtime-settings-manifest.test.ts", "unknown.test.ts"]) fixture(root, name);
  const discovered = discoverTestFiles(root);
  const partition = partitionTestFiles(discovered);
  assert.deepEqual(new Set([...partition.light, ...partition.runtime, ...partition.manifestOwned]), new Set(discovered));
  assert.equal(partition.light.length + partition.runtime.length + partition.manifestOwned.length, discovered.length);
  assert.ok(partition.runtime.some((file) => path.basename(file) === "unknown.test.ts"));
  assert.ok(partition.runtime.some((file) => path.basename(file) === "runtime-settings-manifest.test.ts"));
  for (const adapter of MANIFEST_ADAPTER_FILES) assert.ok(partition.manifestOwned.some((file) => path.basename(file) === adapter));
});

test("runtime scheduling starts both known long chains before shorter files", () => {
  assert.deepEqual(scheduleRuntimeFiles(["z.test.ts", "subagent-runtime.test.ts", "a.test.ts", "runtime-settings-manifest.test.ts"]), [
    "runtime-settings-manifest.test.ts",
    "subagent-runtime.test.ts",
    "z.test.ts",
    "a.test.ts",
  ]);
});

test("partition rejects missing and duplicate manifest adapters", () => {
  const root = temporaryTestDirectory();
  const files = MANIFEST_ADAPTER_FILES.map((name) => fixture(root, name));
  assert.throws(() => partitionTestFiles(files.slice(1)), /missing manifest adapter/);
  assert.throws(() => partitionTestFiles([...files, files[0]!]), /duplicate test file/);
});

test("the standard admission path is independent of worktree environment", () => {
  assert.equal(standardAdmissionRoot({ TMPDIR: "/one", XDG_RUNTIME_DIR: "/two" }, 123), "/tmp/yokemate-tests-123");
  assert.equal(standardAdmissionRoot({ TMPDIR: "/elsewhere", XDG_RUNTIME_DIR: "/different" }, 123), "/tmp/yokemate-tests-123");
});

test("worker supervisor terminates a detached grandchild and reports watchdog failure", { timeout: 15000 }, async () => {
  const root = temporaryTestDirectory();
  const pidFile = path.join(root, "grandchild.pid");
  const fault = path.resolve(import.meta.dirname, "fixtures/test-runner-fault.mjs");
  const result = await runSupervisedFile(fault, {
    fileTimeoutMs: 500,
    cleanupTimeoutMs: 3000,
    extraArgs: ["detached", pidFile],
    stream: false,
  });
  assert.equal(result.code, 124, result.stderr);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0));
});

test("two runtime schedulers share one admission and a queued body does not start", { timeout: 15000 }, async () => {
  const root = temporaryTestDirectory();
  const admission = path.join(root, "admission");
  const marker = path.join(root, "started");
  const supervisor = path.resolve(import.meta.dirname, "../scripts/test-supervisor.py");
  const holder = spawn("python3", [supervisor, "runtime", "--admission-root", admission, "--admission-timeout", "3", "--active-timeout", "3", "--cleanup-timeout", "2", "--", process.execPath, "-e", "setTimeout(()=>{},1500)"], { stdio: ["ignore", "pipe", "pipe"] });
  const owner = path.join(admission, "owner.json");
  const ownerDeadline = Date.now() + 3000;
  while (!fs.existsSync(owner)) {
    if (Date.now() >= ownerDeadline) throw new Error("holder did not acquire admission");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const queued = spawn("python3", [supervisor, "runtime", "--admission-root", admission, "--admission-timeout", "0.25", "--active-timeout", "3", "--cleanup-timeout", "2", "--", process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'yes')`], { stdio: ["ignore", "pipe", "pipe"] });
  const [queuedCode, holderCode] = await Promise.all([
    new Promise<number | null>((resolve) => queued.on("close", resolve)),
    new Promise<number | null>((resolve) => holder.on("close", resolve)),
  ]);
  assert.equal(queuedCode, 124);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(holderCode, 0);
});
