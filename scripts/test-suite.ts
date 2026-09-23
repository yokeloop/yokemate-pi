import fs from "node:fs";
import path from "node:path";

export const MANIFEST_ADAPTER_FILES = [
  "runtime-settings-entrypoints.test.ts",
  "workflow-approval-runtime.test.ts",
  "mode-tab.test.ts",
] as const;

export const LIGHT_TEST_FILES = [
  "coordinator-merge.test.ts",
  "coordinator-runtime.test.ts",
  "github.test.ts",
  "guard-policy.test.ts",
  "guards.test.ts",
  "mode-surface.test.ts",
  "plan-lifecycle.test.ts",
  "plan-publication.test.ts",
  "plan-scout-recovery.test.ts",
  "pool.test.ts",
  "required-checks.test.ts",
  "research-guard.test.ts",
  "research-launch.test.ts",
  "research-mcp.test.ts",
  "review-rework.test.ts",
  "runtime-settings.test.ts",
  "subagent-report-store.test.ts",
  "subagent-report.test.ts",
  "subagent-widget.test.ts",
  "ticket-preview.test.ts",
  "transitions.test.ts",
  "warmup.test.ts",
  "workflow-approval.test.ts",
  "workflow-boundaries-manifest.test.ts",
  "workflow-boundaries.test.ts",
  "workflow-break-glass.test.ts",
  "workflow-incident-state.test.ts",
  "workflow-ingress.test.ts",
] as const;

export interface TestPartition {
  light: string[];
  runtime: string[];
  manifestOwned: string[];
}

export function discoverTestFiles(testDirectory: string): string[] {
  return fs.readdirSync(testDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => path.resolve(testDirectory, entry.name))
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
}

export function partitionTestFiles(files: readonly string[]): TestPartition {
  const seen = new Set<string>();
  for (const file of files) {
    const canonical = path.resolve(file);
    if (seen.has(canonical)) throw new Error(`duplicate test file: ${file}`);
    seen.add(canonical);
  }
  const byName = new Map<string, string[]>();
  for (const file of files) {
    const name = path.basename(file);
    const matches = byName.get(name) ?? [];
    matches.push(path.resolve(file));
    byName.set(name, matches);
  }
  for (const adapter of MANIFEST_ADAPTER_FILES) {
    const matches = byName.get(adapter) ?? [];
    if (matches.length === 0) throw new Error(`missing manifest adapter: ${adapter}`);
    if (matches.length !== 1) throw new Error(`duplicate manifest adapter: ${adapter}`);
  }
  const lightNames = new Set<string>(LIGHT_TEST_FILES);
  const adapterNames = new Set<string>(MANIFEST_ADAPTER_FILES);
  for (const name of lightNames) if (adapterNames.has(name)) throw new Error(`test classification intersects: ${name}`);
  const light: string[] = [];
  const runtime: string[] = [];
  const manifestOwned: string[] = [];
  for (const file of files.map((value) => path.resolve(value))) {
    const name = path.basename(file);
    if (adapterNames.has(name)) manifestOwned.push(file);
    else if (lightNames.has(name)) light.push(file);
    else runtime.push(file);
  }
  return { light, runtime, manifestOwned };
}

export function standardAdmissionRoot(_env: NodeJS.ProcessEnv = process.env, uid = process.getuid?.() ?? -1): string {
  return `/tmp/yokemate-tests-${uid}`;
}
