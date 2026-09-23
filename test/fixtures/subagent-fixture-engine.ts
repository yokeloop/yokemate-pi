import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DefaultResourceLoader, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sha256 } from "../../src/subagent-runs.ts";
import { RuntimeResources } from "./runtime-resources.ts";

const fixtureNames = ["subagent-json-relay.mjs", "subagent-report-child.js", "runtime-settings-child.mjs", "subagent-widget-child.js", "subagent-runtime-provider.ts"] as const;
const environmentQueue: Array<() => void> = [];
let environmentBusy = false;
let sharedDependencies: string | undefined;

export interface FixtureEngine {
  root: string;
  sourceRoot: string;
  extensionPath: string;
  agentDir: string;
  sessionDir: string;
  homeDir: string;
  tmpDir: string;
  runtimeDir: string;
  snapshotDir: string;
  reportDir: string;
  dependencyRoot: string;
  repository?: string;
  resources: Record<(typeof fixtureNames)[number], string>;
  loaded: LoadedFixture[];
}

export interface SentFixtureMessage {
  message: any;
  options: any;
}

export interface LoadedFixture {
  engine: FixtureEngine;
  loader: DefaultResourceLoader;
  extension: ReturnType<DefaultResourceLoader["getExtensions"]>["extensions"][number];
  tool: any;
  ctx: ExtensionContext;
  sent: SentFixtureMessage[];
  entries: Array<{ type: string; data: any }>;
  shutdownPromise?: Promise<void>;
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(candidate));
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertContained(root: string, candidate: string): void {
  assert.equal(contained(root, candidate), true, `${candidate} escapes ${root}`);
}

function verifyDependencyLinks(root: string): void {
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        assertContained(root, file);
        continue;
      }
      if (entry.isDirectory()) visit(file);
    }
  };
  visit(path.join(root, "node_modules"));
}

function dependencyPool(sourceRoot: string): string {
  const supplied = process.env.YM245_FIXTURE_DEPENDENCY_ROOT;
  if (supplied) {
    const canonical = fs.realpathSync(supplied);
    assert.ok(fs.existsSync(path.join(canonical, "node_modules")));
    verifyDependencyLinks(canonical);
    return canonical;
  }
  if (sharedDependencies) return sharedDependencies;
  const pool = fs.mkdtempSync(path.join(tmpdir(), "ym245-fixture-dependencies-"));
  fs.cpSync(path.join(sourceRoot, "node_modules"), path.join(pool, "node_modules"), { recursive: true, verbatimSymlinks: true, filter: (source) => !path.basename(source).startsWith(".ym226-unpatched-") });
  verifyDependencyLinks(pool);
  const version = JSON.parse(fs.readFileSync(path.join(pool, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version;
  assert.equal(version, "0.85.1");
  const producer = awaitImportText(path.join(pool, "node_modules/@earendil-works/pi-coding-agent/dist/modes/json-event.js"));
  assert.match(producer, /YOKEMATE_SUBAGENT_JSON_CONTRACT_VERSION/);
  sharedDependencies = pool;
  process.once("exit", () => fs.rmSync(pool, { recursive: true, force: true }));
  return pool;
}

function awaitImportText(file: string): string {
  return fs.readFileSync(file, "utf8");
}

export function createFixtureEngine(options: { label: string; sourceRoot?: string; agents: Record<string, string>; dependencyRoot?: string; gitRepository?: boolean }): FixtureEngine {
  const sourceRoot = fs.realpathSync(options.sourceRoot ?? path.resolve(import.meta.dirname, "../.."));
  const root = fs.mkdtempSync(path.join(tmpdir(), `ym245-${options.label}-`));
  try {
  fs.cpSync(path.join(sourceRoot, "src"), path.join(root, "src"), { recursive: true });
  fs.cpSync(path.join(sourceRoot, ".pi/extensions/subagent"), path.join(root, ".pi/extensions/subagent"), { recursive: true });
  fs.mkdirSync(path.join(root, "test/fixtures"), { recursive: true });
  const resources = Object.fromEntries(fixtureNames.map((name) => {
    const target = path.join(root, "test/fixtures", name);
    fs.copyFileSync(path.join(sourceRoot, "test/fixtures", name), target);
    return [name, target];
  })) as FixtureEngine["resources"];
  const directories = {
    agentDir: path.join(root, "agent"),
    sessionDir: path.join(root, "sessions"),
    homeDir: path.join(root, "home"),
    tmpDir: path.join(root, "tmp"),
    runtimeDir: path.join(root, "runtime"),
  };
  for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(path.join(root, ".pi/agents"), { recursive: true });
  for (const [name, body] of Object.entries(options.agents)) fs.writeFileSync(path.join(root, ".pi/agents", `${name}.md`), body);
  fs.writeFileSync(path.join(root, ".pi/settings.json"), "{}");
  const dependencyRoot = options.dependencyRoot ? fs.realpathSync(options.dependencyRoot) : dependencyPool(sourceRoot);
  verifyDependencyLinks(dependencyRoot);
  fs.symlinkSync(path.join(dependencyRoot, "node_modules"), path.join(root, "node_modules"), "dir");
  assertContained(dependencyRoot, path.join(root, "node_modules"));
  let repository: string | undefined;
  if (options.gitRepository) {
    repository = path.join(root, "repository");
    fs.mkdirSync(repository);
    execFileSync("git", ["init", "-b", "main", repository], { stdio: "pipe", timeout: 30_000 });
    execFileSync("git", ["-C", repository, "config", "user.name", "Fixture"], { stdio: "pipe", timeout: 30_000 });
    execFileSync("git", ["-C", repository, "config", "user.email", "fixture@example.invalid"], { stdio: "pipe", timeout: 30_000 });
    fs.writeFileSync(path.join(repository, "fixture.txt"), "fixture\n");
    execFileSync("git", ["-C", repository, "add", "fixture.txt"], { stdio: "pipe", timeout: 30_000 });
    execFileSync("git", ["-C", repository, "commit", "-m", "Create fixture"], { stdio: "pipe", timeout: 30_000 });
  }
  const engine: FixtureEngine = {
    root,
    sourceRoot,
    extensionPath: path.join(root, ".pi/extensions/subagent/index.ts"),
    ...directories,
    snapshotDir: path.join(root, "sessions/subagent-runs"),
    reportDir: path.join(root, ".pi/subagent-reports"),
    dependencyRoot,
    repository,
    resources,
    loaded: [],
  };
  for (const target of [engine.root, engine.agentDir, engine.sessionDir, engine.homeDir, engine.tmpDir, engine.runtimeDir, path.dirname(engine.extensionPath), ...Object.values(resources), ...(repository ? [repository] : [])]) assertContained(root, target);
  assert.equal(fs.realpathSync(engine.extensionPath).startsWith(`${fs.realpathSync(root)}${path.sep}`), true);
  return engine;
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function acquireEnvironment(signal?: AbortSignal, timeoutMs = 30_000): Promise<void> {
  if (!environmentBusy) {
    environmentBusy = true;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      const index = environmentQueue.indexOf(granted);
      if (index >= 0) environmentQueue.splice(index, 1);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const granted = () => finish();
    const aborted = () => finish(signal?.reason ?? new Error("fixture environment acquisition aborted"));
    const timer = setTimeout(() => finish(new Error("fixture environment acquisition timed out")), timeoutMs);
    environmentQueue.push(granted);
    if (signal?.aborted) aborted();
    else signal?.addEventListener("abort", aborted, { once: true });
  });
}

function releaseEnvironment(): void {
  const next = environmentQueue.shift();
  if (next) next();
  else environmentBusy = false;
}

export async function withFixtureEnvironment<T>(engine: FixtureEngine, overrides: Record<string, string | undefined>, body: () => Promise<T>, resources?: RuntimeResources): Promise<T> {
  await acquireEnvironment(resources?.signal);
  const previous = { ...process.env };
  const cwd = process.cwd();
  let bodyError: unknown;
  let value: T | undefined;
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    for (const key of ["PATH", "NODE_TEST_CONTEXT", "YOKEMATE_TEST_RESOURCE_ROOT", "YOKEMATE_TEST_RESOURCE_REGISTRY", "YOKEMATE_TEST_ABSOLUTE_DEADLINE", "YOKEMATE_TEST_ADMISSION_HELD"] as const) if (previous[key] !== undefined) process.env[key] = previous[key];
    Object.assign(process.env, {
      HOME: engine.homeDir,
      TMPDIR: engine.tmpDir,
      XDG_RUNTIME_DIR: engine.runtimeDir,
      PI_CODING_AGENT_DIR: engine.agentDir,
      PI_CODING_AGENT_SESSION_DIR: engine.sessionDir,
      YOKEMATE_SUBAGENT_TEST_RELAY: engine.resources["subagent-json-relay.mjs"],
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    });
    for (const [key, item] of Object.entries(overrides)) if (item === undefined) delete process.env[key]; else process.env[key] = item;
    process.chdir(engine.root);
    value = await body();
  } catch (error) {
    bodyError = error;
  }
  const shutdownErrors: unknown[] = [];
  for (const fixture of [...engine.loaded].reverse()) {
    try { await shutdownFixture(fixture, bodyError ? { expectedDeliveryState: "terminal" } : undefined); }
    catch (error) { shutdownErrors.push(error); }
  }
  try { process.chdir(cwd); }
  catch (error) { shutdownErrors.push(error); }
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
  } catch (error) { shutdownErrors.push(error); }
  if (!shutdownErrors.length) fs.rmSync(engine.root, { recursive: true, force: true });
  releaseEnvironment();
  const errors = [...(bodyError !== undefined ? [bodyError] : []), ...shutdownErrors];
  if (errors.length > 1) throw new AggregateError(errors, `fixture body or cleanup failed: ${errors.map(String).join("; ")}`);
  if (errors.length === 1) throw errors[0];
  return value as T;
}

export async function loadFixtureExtension(engine: FixtureEngine, options: { sessionId: string; mode?: "rpc" | "tui"; hasUI?: boolean; ui?: Record<string, unknown>; model?: unknown; thinkingLevel?: string; isProjectTrusted?: () => boolean }): Promise<LoadedFixture> {
  const loader = new DefaultResourceLoader({ cwd: engine.root, agentDir: engine.agentDir, settingsManager: SettingsManager.create(engine.root, engine.agentDir), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [engine.extensionPath] });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.find((entry) => fs.realpathSync(entry.path) === fs.realpathSync(engine.extensionPath));
  assert.ok(extension);
  const sent: SentFixtureMessage[] = [];
  const entries: Array<{ type: string; data: any }> = [];
  loaded.runtime.appendEntry = ((type: string, data: any) => { entries.push({ type, data }); }) as any;
  loaded.runtime.sendMessage = ((message: any, sendOptions: any) => { sent.push({ message, options: sendOptions }); }) as any;
  const ctx = {
    cwd: engine.root,
    mode: options.mode ?? "rpc",
    hasUI: options.hasUI ?? false,
    model: options.model,
    thinkingLevel: options.thinkingLevel ?? "off",
    isProjectTrusted: options.isProjectTrusted ?? (() => true),
    sessionManager: { getSessionId: () => options.sessionId },
    ui: { notify: () => undefined, setWidget: () => undefined, ...(options.ui ?? {}) },
    modelRegistry: { getAll: () => [], hasConfiguredAuth: () => true },
  } as unknown as ExtensionContext;
  const fixture: LoadedFixture = { engine, loader, extension, tool: extension.tools.get("subagent")?.definition, ctx, sent, entries };
  engine.loaded.push(fixture);
  try {
    for (const handler of extension.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" } as never, ctx);
    assert.ok(fixture.tool);
    return fixture;
  } catch (error) {
    try { await shutdownFixture(fixture, { expectedDeliveryState: "terminal" }); }
    catch (shutdownError) { throw new AggregateError([error, shutdownError], "fixture startup and shutdown failed"); }
    throw error;
  }
}

function deliveryStates(fixture: LoadedFixture): Map<string, string> {
  const states = new Map<string, string>();
  for (const entry of fixture.entries) {
    if (entry.type !== "yokemate-child-state") continue;
    for (const delivery of entry.data?.deliveries ?? []) states.set(delivery.deliveryId, delivery.state);
  }
  return states;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string, signal?: AbortSignal): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (signal?.aborted) throw signal.reason ?? new Error(`${label} aborted`);
    if (Date.now() - started > timeoutMs) throw new Error(`${label} timed out`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function acknowledgeFixtureReports(fixture: LoadedFixture, reports: readonly SentFixtureMessage[], timeoutMs = 5000, signal?: AbortSignal): Promise<void> {
  assert.ok(reports.length > 0);
  const selected = reports.filter(({ message }) => message.customType === "subagent-report");
  assert.equal(selected.length, reports.length);
  const ids = new Set(selected.map(({ message }) => message.details.deliveryId));
  assert.equal(ids.size, selected.length);
  const batches = selected.filter(({ message }) => message.details.envelope.kind === "batch");
  for (const { message } of batches) {
    const runIds = new Set(message.details.envelope.results.map((result: any) => result.identity.runId));
    const members = selected.filter(({ message: candidate }) => {
      const envelope = candidate.details.envelope;
      const batchId = envelope.kind === "result" ? envelope.identity.batchId : envelope.batchId;
      return envelope.kind !== "batch" && batchId === message.details.envelope.batchId;
    });
    const memberIds = new Set(members.flatMap(({ message: candidate }) => candidate.details.envelope.kind === "result" ? [candidate.details.envelope.identity.runId] : candidate.details.envelope.results.map((result: any) => result.identity.runId)));
    assert.deepEqual(memberIds, runIds);
  }
  const archives = selected.map(({ message }) => {
    const archive = message.details.display.archive;
    assert.equal(archive.state, "available");
    const bytes = fs.readFileSync(archive.reportPath);
    return { path: archive.reportPath, bytes, hash: sha256(bytes) };
  });
  const messages = selected.map(({ message }) => ({ role: "custom", timestamp: Date.now(), ...message }));
  for (const handler of fixture.extension.handlers.get("context") ?? []) await handler({ type: "context", messages } as never, fixture.ctx);
  await waitFor(() => [...ids].every((id) => deliveryStates(fixture).get(id) === "observed"), timeoutMs, "fixture report ACK", signal);
  for (const archive of archives) {
    const bytes = fs.readFileSync(archive.path);
    assert.equal(sha256(bytes), archive.hash);
    assert.deepEqual(bytes, archive.bytes);
  }
}

export async function shutdownFixture(fixture: LoadedFixture, options: { expectedDeliveryState?: "observed" | "delivery_unknown" | "terminal"; timeoutMs?: number } = {}): Promise<void> {
  if (!fixture.shutdownPromise) fixture.shutdownPromise = (async () => {
    const timeoutMs = options.timeoutMs ?? 10000;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        (async () => { for (const handler of fixture.extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "shutdown" } as never, fixture.ctx); })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("fixture shutdown timed out")), timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const states = [...deliveryStates(fixture).values()];
    const expected = options.expectedDeliveryState ?? "observed";
    if (states.length) assert.ok(states.every((state) => expected === "terminal" ? ["observed", "delivery_unknown"].includes(state) : state === expected), JSON.stringify(states));
    const latest = [...fixture.entries].reverse().find((entry) => entry.type === "yokemate-child-state")?.data;
    if (latest) assert.deepEqual(latest.children, []);
  })();
  await fixture.shutdownPromise;
}

export function snapshotStoreManifest(engine: FixtureEngine): Array<{ name: string; bytes: number; hash: string }> {
  if (!fs.existsSync(engine.snapshotDir)) return [];
  return fs.readdirSync(engine.snapshotDir).filter((name) => name.endsWith(".json")).sort().map((name) => {
    const bytes = fs.readFileSync(path.join(engine.snapshotDir, name));
    return { name, bytes: bytes.length, hash: sha256(bytes) };
  });
}
