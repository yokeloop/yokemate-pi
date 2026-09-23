import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverTestFiles, MANIFEST_ADAPTER_FILES, partitionTestFiles, standardAdmissionRoot } from "./test-suite.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const supervisorPath = path.join(import.meta.dirname, "test-supervisor.py");

export interface SupervisedFileOptions {
  fileTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  extraArgs?: string[];
  stream?: boolean;
  prefix?: string;
  env?: NodeJS.ProcessEnv;
}

export interface SupervisedFileResult {
  file: string;
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function appendStream(chunk: Buffer, target: "stdout" | "stderr", enabled: boolean, prefix: string): string {
  const text = chunk.toString("utf8");
  if (enabled) {
    const output = text.split(/(?<=\n)/).map((line) => line ? `[${prefix}] ${line}` : "").join("");
    (target === "stdout" ? process.stdout : process.stderr).write(output);
  }
  return text;
}

export function runSupervisedFile(file: string, options: SupervisedFileOptions = {}): Promise<SupervisedFileResult> {
  const absolute = path.resolve(file);
  const testFile = absolute.endsWith(".test.ts");
  const nodeArguments = ["--experimental-strip-types", "--no-warnings", ...(testFile ? ["--test"] : []), absolute, ...(options.extraArgs ?? [])];
  const supervisorArguments = [
    supervisorPath,
    "worker",
    "--timeout", String((options.fileTimeoutMs ?? 600_000) / 1000),
    "--cleanup-timeout", String((options.cleanupTimeoutMs ?? 30_000) / 1000),
    "--",
    process.execPath,
    ...nodeArguments,
  ];
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn("python3", supervisorArguments, { cwd: repositoryRoot, env: { ...process.env, ...(options.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const prefix = options.prefix ?? path.basename(file);
    child.stdout.on("data", (chunk: Buffer) => { stdout += appendStream(chunk, "stdout", options.stream !== false, prefix); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += appendStream(chunk, "stderr", options.stream !== false, prefix); });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ file: absolute, code: code ?? 1, signal, stdout, stderr, durationMs: performance.now() - started }));
  });
}

async function runFiles(files: readonly string[], concurrency: number, phaseDeadline: number): Promise<{ results: SupervisedFileResult[]; maxConcurrency: number }> {
  const results: SupervisedFileResult[] = [];
  let next = 0;
  let active = 0;
  let maximum = 0;
  let stopped = false;
  await new Promise<void>((resolve) => {
    const dispatch = () => {
      while (!stopped && active < concurrency && next < files.length) {
        const file = files[next++]!;
        active += 1;
        maximum = Math.max(maximum, active);
        const remaining = Math.max(1, phaseDeadline - Date.now());
        void runSupervisedFile(file, { fileTimeoutMs: Math.min(600_000, remaining), prefix: path.basename(file) }).then((result) => {
          results.push(result);
          if (result.code !== 0) stopped = true;
        }).catch((error) => {
          results.push({ file, code: 1, signal: null, stdout: "", stderr: String(error), durationMs: 0 });
          stopped = true;
        }).finally(() => {
          active -= 1;
          if ((stopped || next >= files.length) && active === 0) resolve();
          else dispatch();
        });
      }
      if ((stopped || next >= files.length) && active === 0) resolve();
    };
    dispatch();
  });
  return { results, maxConcurrency: maximum };
}

function selectedFiles(arguments_: readonly string[]): { files: string[]; targeted: boolean } {
  const discovered = discoverTestFiles(path.join(repositoryRoot, "test"));
  if (arguments_.length === 0) return { files: discovered, targeted: false };
  const byPath = new Map(discovered.map((file) => [path.resolve(file), file]));
  const selected = arguments_.map((value) => {
    const resolved = path.resolve(repositoryRoot, value);
    const file = byPath.get(resolved);
    if (!file) throw new Error(`targeted test is not a discovered test file: ${value}`);
    return file;
  });
  return { files: [...new Set(selected)], targeted: true };
}

function summarize(results: readonly SupervisedFileResult[], mode: "full" | "targeted", started: number, maxRuntimeChains: number, admissionMs: number, fileCount = results.length): void {
  const failures = results.filter((result) => result.code !== 0);
  const scenarioIds = new Set<string>();
  for (const result of results) {
    for (const match of result.stdout.matchAll(/RUNTIME_CASE\s+(\S+)|^\s*# Subtest:\s*(.+)$/gm)) scenarioIds.add(match[1] ?? `${path.basename(result.file)}:${match[2]}`);
  }
  let sha = "unknown";
  try { sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8", timeout: 10_000 }).trim(); } catch {}
  const packageVersion = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).version;
  const totalMs = started > 1_000_000_000_000 ? Date.now() - started : performance.now() - started;
  process.stdout.write(`TEST_SUITE_SUMMARY ${JSON.stringify({ mode, sha, version: packageVersion, files: fileCount, uniqueScenarioIds: scenarioIds.size, activeMs: Math.round(totalMs), admissionMs: Math.round(admissionMs), cleanupMs: 0, totalMs: Math.round(totalMs + admissionMs), maxRuntimeChains, failures: failures.map((result) => ({ file: path.basename(result.file), code: result.code, signal: result.signal })), cleanup: failures.some((result) => /failed cleanup/.test(result.stderr)) ? "failed" : "clean" })}\n`);
}

async function runRuntimePhase(files: readonly string[], mode: "full" | "targeted", suiteStarted: number, lightCount: number): Promise<number> {
  const runtime = await runFiles(files, 2, suiteStarted + 720_000);
  summarize(runtime.results, mode, suiteStarted, runtime.maxConcurrency, Number(process.env.YOKEMATE_TEST_ADMISSION_WAIT_MS ?? 0), lightCount + files.length);
  return runtime.results.some((result) => result.code !== 0) ? 1 : 0;
}

export async function runSuite(arguments_: readonly string[] = []): Promise<number> {
  const started = performance.now();
  const wallStarted = Date.now();
  const selection = selectedFiles(arguments_);
  const completePartition = partitionTestFiles(discoverTestFiles(path.join(repositoryRoot, "test")));
  const selected = new Set(selection.files);
  const adapterSelected = completePartition.manifestOwned.some((file) => selected.has(file));
  if (adapterSelected) {
    for (const file of completePartition.manifestOwned) selected.delete(file);
    selected.add(path.join(repositoryRoot, "test/runtime-settings-manifest.test.ts"));
  }
  const light = completePartition.light.filter((file) => selected.has(file));
  const runtime = completePartition.runtime.filter((file) => selected.has(file));
  const lightRun = await runFiles(light, 4, wallStarted + 120_000);
  if (lightRun.results.some((result) => result.code !== 0)) {
    summarize(lightRun.results, selection.targeted ? "targeted" : "full", started, 0, 0);
    return 1;
  }
  if (runtime.length === 0) {
    summarize(lightRun.results, selection.targeted ? "targeted" : "full", started, 0, 0);
    return 0;
  }
  const runtimeArguments = [
    supervisorPath,
    "runtime",
    "--admission-root", process.env.YOKEMATE_TEST_ADMISSION_ROOT ?? standardAdmissionRoot(),
    "--admission-timeout", "750",
    "--active-timeout", String(Math.max(1, (wallStarted + 720_000 - Date.now()) / 1000)),
    "--cleanup-timeout", "30",
    "--",
    process.execPath,
    "--experimental-strip-types",
    "--no-warnings",
    fileURLToPath(import.meta.url),
    "--runtime-phase",
    selection.targeted ? "targeted" : "full",
    String(wallStarted),
    String(light.length),
    ...runtime,
  ];
  const admissionStarted = performance.now();
  const runtimeResult = await new Promise<number>((resolve, reject) => {
    const child = spawn("python3", runtimeArguments, { cwd: repositoryRoot, stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  const admissionMs = performance.now() - admissionStarted;
  if (runtimeResult !== 0) {
    summarize(lightRun.results, selection.targeted ? "targeted" : "full", started, 0, admissionMs);
    return runtimeResult;
  }
  return 0;
}

async function main(): Promise<void> {
  if (process.argv[2] === "--runtime-phase") {
    const mode = process.argv[3] === "targeted" ? "targeted" : "full";
    const wallStarted = Number(process.argv[4]);
    const lightCount = Number(process.argv[5]);
    process.exitCode = await runRuntimePhase(process.argv.slice(6), mode, wallStarted, lightCount);
    return;
  }
  process.exitCode = await runSuite(process.argv.slice(2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
