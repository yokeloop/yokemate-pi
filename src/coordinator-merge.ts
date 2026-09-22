import { execFile } from "node:child_process";
import type { PreparedPart } from "./coordinator-launch.ts";
import { gatherGateFacts, gatherScopedGateFacts, verifyGate } from "./coordinator-result.ts";
import { assertMandatoryBoundary } from "./workflow-boundaries.ts";

export interface CoordinatorMergeRequest { pr: string; expectedHead: string; method: "merge" | "squash" | "rebase" }
export interface MergeSnapshot { url: string; state: string; headRefName: string; headRefOid: string; baseRefName: string; mergedAt?: string }
export interface CoordinatorMergeResult { repo: string; pr: string; head: string; state: "merged" | "open" | "unknown"; reason?: string; repeated?: boolean }
export interface CoordinatorMergeScope { root: string; runId: string; ticket: string; part: PreparedPart; live(): boolean }
export interface CoordinatorMergeDeps {
  snapshot(cwd: string, pr: string): Promise<MergeSnapshot>;
  gate(root: string, ticket: string, part: PreparedPart): Promise<ReturnType<typeof verifyGate>>;
  merge(cwd: string, request: CoordinatorMergeRequest): Promise<{ exit: number; output: string }>;
}

const mutexes = new Map<string, Promise<void>>();
const attempts = new Map<string, Promise<CoordinatorMergeResult>>();

function run(command: string, args: string[], cwd: string): Promise<{ exit: number; output: string }> {
  return new Promise((resolvePromise) => {
    execFile(command, args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => resolvePromise({ exit: error ? typeof error.code === "number" ? error.code : 1 : 0, output: `${stdout ?? ""}${stderr ?? ""}`.trim() }));
  });
}

async function defaultSnapshot(cwd: string, pr: string): Promise<MergeSnapshot> {
  const result = await run("gh", ["pr", "view", pr, "--json", "url,state,headRefName,headRefOid,baseRefName,mergedAt"], cwd);
  if (result.exit !== 0) throw new Error(result.output || `cannot inspect ${pr}`);
  const snapshot = JSON.parse(result.output) as MergeSnapshot;
  if (!snapshot.url || !snapshot.state || !snapshot.headRefName || !/^[0-9a-f]{40}$/.test(snapshot.headRefOid ?? "") || !snapshot.baseRefName) throw new Error(`incomplete PR snapshot for ${pr}`);
  return snapshot;
}

async function defaultGate(root: string, ticket: string, part: PreparedPart): Promise<ReturnType<typeof verifyGate>> {
  const payload = Buffer.from(JSON.stringify({ root, ticket, repo: part.repo, selector: part.pr, ...(part.worktree && part.targetBranch ? { worktree: part.worktree, branch: part.branch, targetBranch: part.targetBranch, receiptPath: `${part.worktree}/.yokemate-ready.json`, expectedScopeId: part.scopeId } : {}) })).toString("base64");
  const result = await run(process.execPath, ["--experimental-strip-types", "--no-warnings", import.meta.filename, "--gate", payload], root);
  if (result.exit !== 0) throw new Error(result.output || `cannot gather fresh gate for ${part.repo}`);
  return JSON.parse(result.output) as ReturnType<typeof verifyGate>;
}

const defaults: CoordinatorMergeDeps = {
  snapshot: defaultSnapshot,
  gate: defaultGate,
  merge: (cwd, request) => run("gh", ["pr", "merge", request.pr, `--${request.method}`, "--match-head-commit", request.expectedHead], cwd),
};

export function canonicalRepository(remote: string): string {
  const value = remote.trim();
  if (/^[^@\s]+@[^:\s]+:/.test(value)) {
    const matched = /^[^@\s]+@([^:\s]+):(.+)$/.exec(value)!;
    return `${matched[1]!.toLowerCase()}/${matched[2]!.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "")}`.toLowerCase();
  }
  const parsed = new URL(value.includes("://") ? value : `https://${value}`);
  return `${parsed.hostname.toLowerCase()}/${parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "")}`.toLowerCase();
}

export function repositoryFromPr(pr: string): string {
  const parsed = new URL(pr);
  const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
  if (!owner || !repo) throw new Error(`cannot derive repository from PR URL ${pr}`);
  return `${parsed.hostname.toLowerCase()}/${owner}/${repo}`.toLowerCase();
}

async function underMutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutexes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const own = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const tail = previous.then(() => own);
  mutexes.set(key, tail);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (mutexes.get(key) === tail) mutexes.delete(key);
  }
}

export interface FreshMergeScope {
  repo: string;
  cwd: string;
  remote: string;
  sourceBranch: string;
  targetBranch: string;
  pr: string;
  expectedHead: string;
  live(): boolean;
  gate(): Promise<{ ok: boolean; reason?: string; head?: string }>;
}

export function freshMerge(scope: FreshMergeScope, method: CoordinatorMergeRequest["method"], deps: Pick<CoordinatorMergeDeps, "snapshot" | "merge"> = defaults): Promise<CoordinatorMergeResult> {
  if (!/^[0-9a-f]{40}$/.test(scope.expectedHead)) throw new Error("merge expectedHead must be a full commit SHA");
  const remote = canonicalRepository(scope.remote);
  if (remote !== repositoryFromPr(scope.pr)) throw new Error(`prepared remote ${remote} does not match ${scope.pr}`);
  return underMutex(`${remote}#${scope.targetBranch}`, async () => {
    if (!scope.live()) throw new Error("merge authority is no longer live");
    const before = await deps.snapshot(scope.cwd, scope.pr);
    if (before.url !== scope.pr || before.baseRefName !== scope.targetBranch || before.headRefName !== scope.sourceBranch || before.headRefOid !== scope.expectedHead) throw new Error("PR identity, target, source, or head changed before merge");
    if (before.state === "MERGED") {
      if (!before.mergedAt) throw new Error("merged PR has no merge timestamp");
      return { repo: scope.repo, pr: before.url, head: before.headRefOid, state: "merged" as const };
    }
    if (before.state !== "OPEN") return { repo: scope.repo, pr: before.url, head: before.headRefOid, state: "unknown" as const, reason: `PR is ${before.state}` };
    const gate = await scope.gate();
    if (!gate.ok) {
      assertMandatoryBoundary("workflow.quality-gates", false, `gate: ${gate.reason ?? "failed"}`);
      throw new Error(`gate: ${gate.reason ?? "failed"}`);
    }
    assertMandatoryBoundary("workflow.quality-gates", gate.head === before.headRefOid, `fresh gate head for ${scope.repo} is ${gate.head ?? "missing"}, PR head is ${before.headRefOid}`);
    const fresh = await deps.snapshot(scope.cwd, scope.pr);
    if (fresh.url !== scope.pr || fresh.state !== "OPEN" || fresh.baseRefName !== scope.targetBranch || fresh.headRefName !== scope.sourceBranch || fresh.headRefOid !== before.headRefOid) throw new Error("PR identity, base, state, or head changed after fresh gate");
    if (!scope.live()) throw new Error("merge authority was revoked before merge spawn");
    const merged = await deps.merge(scope.cwd, { pr: scope.pr, expectedHead: fresh.headRefOid, method });
    let after: MergeSnapshot;
    try { after = await deps.snapshot(scope.cwd, scope.pr); }
    catch (error) { return { repo: scope.repo, pr: scope.pr, head: before.headRefOid, state: "unknown" as const, reason: `merge result cannot be reconciled: ${(error as Error).message}` }; }
    if (after.url === scope.pr && after.state === "MERGED" && after.mergedAt && after.headRefOid === before.headRefOid && after.headRefName === scope.sourceBranch && after.baseRefName === scope.targetBranch) return { repo: scope.repo, pr: after.url, head: after.headRefOid, state: "merged" as const };
    if (merged.exit !== 0 && after.url === scope.pr && after.state === "OPEN" && after.headRefOid === before.headRefOid) return { repo: scope.repo, pr: after.url, head: after.headRefOid, state: "open" as const, reason: merged.output || "merge command failed" };
    return { repo: scope.repo, pr: after.url || scope.pr, head: after.headRefOid || before.headRefOid, state: "unknown" as const, reason: merged.output || `merge exited ${merged.exit} but PR is ${after.state}` };
  });
}

function assertScope(scope: CoordinatorMergeScope, request: CoordinatorMergeRequest): string {
  assertMandatoryBoundary("workflow.explicit-ship", scope.live(), "ship coordinator authority is no longer live");
  if (!scope.part.pr || scope.part.pr !== request.pr) throw new Error("merge PR is outside the prepared coordinator scope");
  if (!scope.part.remote || !scope.part.base || !scope.part.observedHead) throw new Error("prepared merge part is incomplete");
  if (!/^[0-9a-f]{40}$/.test(request.expectedHead)) throw new Error("merge expectedHead must be a full commit SHA");
  const remote = canonicalRepository(scope.part.remote);
  if (remote !== repositoryFromPr(request.pr)) throw new Error(`prepared remote ${remote} does not match ${request.pr}`);
  return `${remote}#${scope.part.base}`;
}

export function coordinatorMerge(scope: CoordinatorMergeScope, request: CoordinatorMergeRequest, deps: CoordinatorMergeDeps = defaults): Promise<CoordinatorMergeResult> {
  const lockKey = assertScope(scope, request);
  const attemptKey = `${scope.runId}\u0000${scope.part.repo}\u0000${request.pr}\u0000${request.expectedHead}\u0000${request.method}`;
  const prior = attempts.get(attemptKey);
  if (prior) return prior.then((result) => ({ ...result, repeated: true }));
  const attempt = underMutex(lockKey, async () => {
    assertMandatoryBoundary("workflow.live-owner", scope.live(), "ship coordinator authority was revoked before fresh merge validation");
    const before = await deps.snapshot(scope.part.path, request.pr);
    if (before.url !== request.pr || before.baseRefName !== scope.part.base || repositoryFromPr(before.url) !== repositoryFromPr(request.pr)) throw new Error("PR identity or target changed before merge");
    if (before.state === "MERGED") {
      if (before.headRefOid !== request.expectedHead || before.headRefName !== scope.part.branch || !before.mergedAt) throw new Error("merged PR does not match the prepared ticket head");
      return { repo: scope.part.repo, pr: before.url, head: before.headRefOid, state: "merged" as const };
    }
    if (before.state !== "OPEN" || before.headRefName !== scope.part.branch) return { repo: scope.part.repo, pr: before.url, head: before.headRefOid, state: "unknown" as const, reason: `PR is ${before.state} on ${before.headRefName}` };
    if (before.headRefOid !== request.expectedHead) throw new Error(`PR head moved from ${request.expectedHead} to ${before.headRefOid}`);
    const verdict = await deps.gate(scope.root, scope.ticket, scope.part);
    if (!verdict.ok) {
      assertMandatoryBoundary("workflow.quality-gates", false, `gate: ${verdict.reason}`);
      throw new Error(`gate: ${verdict.reason}`);
    }
    assertMandatoryBoundary("workflow.quality-gates", true);
    if (verdict.heads[scope.part.repo] !== before.headRefOid) throw new Error(`fresh gate head for ${scope.part.repo} is ${verdict.heads[scope.part.repo] ?? "missing"}, PR head is ${before.headRefOid}`);
    const fresh = await deps.snapshot(scope.part.path, request.pr);
    if (fresh.url !== request.pr || fresh.state !== "OPEN" || fresh.baseRefName !== scope.part.base || fresh.headRefName !== scope.part.branch || fresh.headRefOid !== before.headRefOid) throw new Error("PR identity, base, state, or head changed after fresh gate");
    if (verdict.heads[scope.part.repo] !== fresh.headRefOid) throw new Error("fresh PR head no longer matches the gate verdict");
    if (!scope.live()) throw new Error("ship coordinator authority was revoked before merge spawn");
    const merge = deps.merge(scope.part.path, { ...request, expectedHead: fresh.headRefOid });
    const merged = await merge;
    let after: MergeSnapshot;
    try { after = await deps.snapshot(scope.part.path, request.pr); }
    catch (error) { return { repo: scope.part.repo, pr: request.pr, head: before.headRefOid, state: "unknown" as const, reason: `merge result cannot be reconciled: ${(error as Error).message}` }; }
    if (after.url === request.pr && after.state === "MERGED" && after.mergedAt && after.headRefOid === before.headRefOid && after.headRefName === scope.part.branch) return { repo: scope.part.repo, pr: after.url, head: after.headRefOid, state: "merged" as const };
    if (merged.exit !== 0 && after.url === request.pr && after.state === "OPEN" && after.headRefOid === before.headRefOid) return { repo: scope.part.repo, pr: after.url, head: after.headRefOid, state: "open" as const, reason: merged.output || "merge command failed" };
    return { repo: scope.part.repo, pr: after.url || request.pr, head: after.headRefOid || before.headRefOid, state: "unknown" as const, reason: merged.output || `merge exited ${merged.exit} but PR is ${after.state}` };
  });
  attempts.set(attemptKey, attempt);
  return attempt;
}

if (import.meta.filename === process.argv[1] && process.argv[2] === "--gate") {
  try {
    const payload = JSON.parse(Buffer.from(process.argv[3] ?? "", "base64").toString("utf8")) as { root: string; ticket: string; repo: string; selector: string; worktree?: string; branch?: string; targetBranch?: string; receiptPath?: string; expectedScopeId?: string };
    const facts = payload.worktree && payload.branch ? gatherScopedGateFacts(payload.ticket, [{ repo: payload.repo, selector: payload.selector, worktree: payload.worktree, branch: payload.branch, targetBranch: payload.targetBranch, receiptPath: payload.receiptPath, expectedScopeId: payload.expectedScopeId }]) : gatherGateFacts(payload.root, payload.ticket, [{ repo: payload.repo, selector: payload.selector }]);
    process.stdout.write(JSON.stringify(verifyGate(facts)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
