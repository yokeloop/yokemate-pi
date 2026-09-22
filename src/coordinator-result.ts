import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { dataRoot } from "./data-root.ts";
import { openDb } from "./db.ts";
import type { PreparedCoordinator } from "./coordinator-launch.ts";
import type { ReadyEntry, ReadyReceipt } from "./ready.ts";
import { requiredJobs, type RequiredJob } from "./required-checks.ts";
import { assertMandatoryBoundary } from "./workflow-boundaries.ts";

export interface CoordinatorOutcome { outcome: "done" | "blocked"; summary: string; reason?: string; passedTickets?: string[] }
export interface ShipPartOutcome { repo: string; pr: string; head?: string; state: "merged" | "remaining" | "unknown"; reason?: string }
export interface OutcomeVerification { ok: boolean; reason?: string; parts?: string[]; merged?: string[]; remaining?: string[]; partFacts?: ShipPartOutcome[] }

function gh(cwd: string, args: string[]): unknown { return JSON.parse(execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); }

export interface RollupEntry { name?: string; context?: string; workflowName?: string; status?: string; conclusion?: string | null; state?: string }
export interface GatePrSnapshot { url: string; state: string; headRefName: string; headRefOid: string; baseRefName: string; baseRefOid: string; statusCheckRollup: RollupEntry[] }
export interface GatePartFacts {
  repo: string; branch: string; targetBranch?: string; pr: GatePrSnapshot;
  localHead: string | null;
  baseHead: string;
  baseInHead: boolean;
  required: RequiredJob[];
  manifestHash: string | null; lockHash: string | null;
  receipt: ReadyEntry | null;
}
export interface GateFacts { ticket: string; parts: GatePartFacts[] }
export type GateVerdict = { ok: true; heads: Record<string, string> } | { ok: false; reason: string };

const short = (sha: string | null | undefined) => sha ? sha.slice(0, 7) : "none";

export function verifyGate(facts: GateFacts): GateVerdict {
  const { ticket } = facts;
  const heads: Record<string, string> = {};
  for (const part of facts.parts) {
    const { repo, pr, receipt } = part;
    if (pr.state !== "OPEN" || pr.headRefName !== part.branch) return { ok: false, reason: `${repo}: PR is not open on ${part.branch}` };
    if (part.targetBranch && pr.baseRefName !== part.targetBranch) return { ok: false, reason: `${repo}: PR targets ${pr.baseRefName}, not ${part.targetBranch}` };
    if (part.localHead === null || part.localHead !== pr.headRefOid) return { ok: false, reason: `${repo}: PR head ${short(pr.headRefOid)} differs from local branch ${part.branch} head ${short(part.localHead)}` };
    if (receipt === null) return { ok: false, reason: `${repo}: no ready receipt — run pnpm ready ${ticket}` };
    if (receipt.head !== pr.headRefOid) return { ok: false, reason: `${repo}: ready receipt is for ${short(receipt.head)} but the PR head is ${short(pr.headRefOid)} — run pnpm ready ${ticket}` };
    if (receipt.lockHash !== part.lockHash || receipt.manifestHash !== part.manifestHash) return { ok: false, reason: `${repo}: ready receipt was taken on a lockfile or package.json that differs from the committed head — run pnpm ready ${ticket}` };
    if (receipt.exit !== 0) return { ok: false, reason: `${repo}: ready receipt records a failed bootstrap (exit ${receipt.exit})` };
    if (!part.baseInHead) return { ok: false, reason: `${repo}: base ${pr.baseRefName} is at ${short(part.baseHead)} and it is not in the PR head — update from the base` };
    for (const job of part.required) {
      const runs = pr.statusCheckRollup.filter((entry) => entry.workflowName === job.workflow && entry.name !== undefined && (entry.name === job.job || entry.name.startsWith(`${job.job} / `) || entry.name.startsWith(`${job.job} (`)));
      const label = `${repo}: required job ${job.workflow}/${job.job}`;
      if (runs.length === 0) return { ok: false, reason: `${label} is missing from the PR checks` };
      if (runs.some((entry) => entry.status !== "COMPLETED")) return { ok: false, reason: `${label} is pending` };
      const failed = runs.find((entry) => entry.conclusion !== "SUCCESS");
      if (failed) return { ok: false, reason: `${label} is ${failed.conclusion ?? "without a conclusion"}` };
    }
    heads[repo] = pr.headRefOid;
  }
  assertMandatoryBoundary("workflow.quality-gates", true);
  return { ok: true, heads };
}

function run(cwd: string, file: string, args: string[]): string {
  return execFileSync(file, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function blobHash(cwd: string, oid: string, path: string): string | null {
  try {
    return createHash("sha256").update(execFileSync("git", ["show", `${oid}:${path}`], { cwd, stdio: ["ignore", "pipe", "pipe"] })).digest("hex");
  } catch { return null; }
}

function readReceipt(root: string, ticket: string): ReadyReceipt | null {
  try { return JSON.parse(readFileSync(join(root, "work", ticket, "ready.json"), "utf8")) as ReadyReceipt; } catch { return null; }
}

export function gatherScopedGateFacts(ticket: string, parts: { repo: string; selector: string; worktree: string; branch: string; targetBranch?: string; receiptPath?: string; receipt?: ReadyEntry | null; expectedScopeId?: string }[]): GateFacts {
  return {
    ticket,
    parts: parts.map(({ repo, selector, worktree, branch, targetBranch, receiptPath, receipt: suppliedReceipt, expectedScopeId }) => {
      if (!existsSync(worktree)) throw new Error(`${repo}: no worktree ${worktree}`);
      const pr = JSON.parse(run(worktree, "gh", ["pr", "view", selector, "--json", "url,state,headRefName,headRefOid,baseRefName,baseRefOid,statusCheckRollup"])) as GatePrSnapshot;
      pr.statusCheckRollup ??= [];
      let localHead: string | null;
      try { localHead = run(worktree, "git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).trim() || null; } catch { localHead = null; }
      const baseHead = run(worktree, "git", ["ls-remote", "origin", `refs/heads/${pr.baseRefName}`]).split(/\s/)[0] ?? "";
      let baseInHead: boolean;
      try { run(worktree, "git", ["merge-base", "--is-ancestor", baseHead, pr.headRefOid]); baseInHead = baseHead !== ""; } catch { baseInHead = false; }
      let listing: string;
      try { listing = run(worktree, "git", ["ls-tree", "--name-only", pr.headRefOid, ".github/workflows/"]); } catch { listing = ""; }
      const files = listing.split("\n")
        .filter((path) => /\.ya?ml$/.test(path))
        .map((path) => ({ path, text: run(worktree, "git", ["show", `${pr.headRefOid}:${path}`]) }));
      let receipt: ReadyEntry | null = suppliedReceipt ?? null;
      if (receiptPath) {
        try {
          const value = JSON.parse(readFileSync(receiptPath, "utf8")) as { entry?: ReadyEntry; scopeId?: string };
          receipt = expectedScopeId && value.scopeId !== expectedScopeId ? null : value.entry ?? null;
        } catch {}
      }
      return {
        repo, branch, targetBranch, pr, localHead, baseHead, baseInHead,
        required: requiredJobs(files),
        manifestHash: blobHash(worktree, pr.headRefOid, "package.json"),
        lockHash: receipt ? blobHash(worktree, pr.headRefOid, receipt.lockfile) : null,
        receipt,
      };
    }),
  };
}

export function gatherGateFacts(root: string, ticket: string, parts: { repo: string; selector: string }[]): GateFacts {
  const receipts = readReceipt(root, ticket);
  return gatherScopedGateFacts(ticket, parts.map((part) => ({ ...part, worktree: join(root, "work", ticket, part.repo.split("/")[1]!), branch: ticket, receipt: receipts?.parts?.[part.repo] ?? null })));
}

export function verifyPreparedShipMerged(root: string, prepared: PreparedCoordinator): OutcomeVerification {
  const merged: string[] = [];
  try {
    for (const part of prepared.parts) {
      if (!part.pr) return { ok: false, reason: `missing PR snapshot for ${part.repo}` };
      const pr = gh(part.passportPath ?? root, ["pr", "view", part.pr, "--json", "state,mergedAt,headRefName,url"]) as { state: string; mergedAt?: string; headRefName: string; url: string };
      if (pr.state !== "MERGED" || !pr.mergedAt || pr.headRefName !== part.branch) return { ok: false, reason: `${part.repo} is not merged` };
      merged.push(pr.url);
    }
    return { ok: true, merged };
  } catch (error) { return { ok: false, reason: (error as Error).message }; }
}

export function verifyCoordinatorOutcome(root: string, prepared: PreparedCoordinator, outcome: CoordinatorOutcome, pending = 0): OutcomeVerification {
  if (outcome.outcome === "blocked") {
    assertMandatoryBoundary("workflow.truthful-outcome", !!(outcome.reason || outcome.summary), "blocked outcome needs a reason or summary");
    if (prepared.mode !== "ship") return { ok: true, reason: outcome.reason || "blocked", remaining: prepared.tickets.filter((ticket) => existsSync(join(root, "work", ticket))) };
    const partFacts: ShipPartOutcome[] = prepared.parts.map((part) => {
      if (!part.pr) return { repo: part.repo, pr: "", state: "unknown", reason: "missing prepared PR" };
      try {
        const pr = gh(part.passportPath ?? root, ["pr", "view", part.pr, "--json", "state,mergedAt,headRefName,headRefOid,url"]) as { state: string; mergedAt?: string; headRefName: string; headRefOid?: string; url: string };
        if (pr.state === "MERGED" && pr.mergedAt && pr.headRefName === part.branch) return { repo: part.repo, pr: pr.url, head: pr.headRefOid, state: "merged" };
        if (pr.state === "OPEN" && pr.headRefName === part.branch) return { repo: part.repo, pr: pr.url, head: pr.headRefOid, state: "remaining" };
        return { repo: part.repo, pr: pr.url, head: pr.headRefOid, state: "unknown", reason: `PR is ${pr.state} on ${pr.headRefName}` };
      } catch (error) { return { repo: part.repo, pr: part.pr, state: "unknown", reason: (error as Error).message }; }
    });
    return { ok: true, reason: outcome.reason || "blocked", merged: partFacts.filter((part) => part.state === "merged").map((part) => part.pr), remaining: partFacts.filter((part) => part.state !== "merged").map((part) => part.pr), partFacts };
  }
  if (pending > 0) return { ok: false, reason: `${pending} child report(s) are pending` };
  try {
    if (prepared.mode === "do") {
      const ticket = prepared.tickets[0]!;
      const db = openDb(join(root, "yokemate.db"));
      if (prepared.group) {
        if (prepared.group.role === "parent") {
          const group = db.prepare("SELECT phase FROM task_group WHERE id=? AND active_revision=?").get(prepared.group.groupId, prepared.group.revisionHash) as { phase: string } | undefined;
          if (group?.phase !== "review") return { ok: false, reason: `${prepared.group.root}: group is still ${group?.phase ?? "missing"}` };
          const pending = db.prepare("SELECT repo FROM group_repository WHERE group_id=? AND revision_hash=? AND (final_pr IS NULL OR head_sha IS NULL OR ship_state!='ready') ORDER BY repo").all(prepared.group.groupId, prepared.group.revisionHash) as unknown as { repo: string }[];
          return pending.length ? { ok: false, reason: `group assembly is incomplete: ${pending.map((row) => row.repo).join(", ")}` } : { ok: true, parts: prepared.parts.map((part) => part.repo) };
        }
        const member = db.prepare("SELECT member_identity,execution FROM group_member WHERE group_id=? AND revision_hash=? AND ticket=?").get(prepared.group.groupId, prepared.group.revisionHash, ticket) as { member_identity: string; execution: string } | undefined;
        if (!member || member.execution !== "running") return { ok: false, reason: `${ticket}: group member is ${member?.execution ?? "missing"}` };
        if (prepared.group.ownWork === "coordination-only") return prepared.parts.length === 0 ? { ok: true, parts: [] } : { ok: false, reason: `${ticket}: coordination-only member has repository parts` };
        const rows = db.prepare("SELECT repo,pr_identity,readiness_json FROM group_part WHERE group_id=? AND revision_hash=? AND member_identity=? ORDER BY repo").all(prepared.group.groupId, prepared.group.revisionHash, member.member_identity) as unknown as { repo: string; pr_identity: string | null; readiness_json: string | null }[];
        if (rows.length !== prepared.parts.length || rows.some((row) => !row.pr_identity || !row.readiness_json || !(JSON.parse(row.readiness_json) as { ok?: boolean }).ok)) return { ok: false, reason: `${ticket}: group member readiness is incomplete` };
        const verdict = verifyGate(gatherScopedGateFacts(ticket, prepared.parts.map((part) => ({ repo: part.repo, selector: rows.find((row) => row.repo === part.repo)!.pr_identity!, worktree: part.worktree!, branch: part.branch, targetBranch: part.targetBranch, receiptPath: join(part.worktree!, ".yokemate-ready.json"), expectedScopeId: part.scopeId }))));
        return verdict.ok ? { ok: true, parts: rows.map((row) => row.repo) } : { ok: false, reason: verdict.reason };
      }
      const work = db.prepare("SELECT id, stage FROM work WHERE ticket = ?").get(ticket) as { id: number; stage: string } | undefined;
      if (!work || work.stage !== "review") return { ok: false, reason: `${ticket} is still ${work?.stage ?? "unrecorded"}` };
      const rows = db.prepare("SELECT repo, branch, pr FROM part WHERE work_id = ? ORDER BY repo").all(work.id) as { repo: string; branch: string; pr: string }[];
      if (rows.length !== prepared.parts.length) return { ok: false, reason: `recorded ${rows.length}/${prepared.parts.length} parts` };
      for (const expected of prepared.parts) {
        const row = rows.find((part) => part.repo === expected.repo && part.branch === ticket);
        if (!row?.pr) return { ok: false, reason: `missing recorded part ${expected.repo}` };
      }
      const verdict = verifyGate(gatherGateFacts(root, ticket, rows.map((row) => ({ repo: row.repo, selector: row.pr }))));
      if (!verdict.ok) return { ok: false, reason: verdict.reason };
      assertMandatoryBoundary("workflow.truthful-outcome", true);
      return { ok: true, parts: rows.map((row) => row.repo) };
    }
    const verified = verifyPreparedShipMerged(root, prepared);
    if (!verified.ok) return verified;
    const merged = verified.merged ?? [];
    const remaining: string[] = [];
    for (const ticket of prepared.tickets) if (existsSync(join(root, "work", ticket))) remaining.push(ticket);
    if (remaining.length) return { ok: false, reason: `task folders remain: ${remaining.join(", ")}`, merged, remaining };
    const journalDir = join(dataRoot(root), "journal");
    const lines = existsSync(journalDir) ? readdirSync(journalDir).filter((name) => /^\d{4}-\d{2}\.md$/.test(name)).map((name) => readFileSync(join(journalDir, name), "utf8")).join("\n") : "";
    const missing = prepared.tickets.filter((ticket) => !new RegExp(`^\\- \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} ${ticket} отгружено(?:$|:)`, "m").test(lines));
    if (!missing.length) assertMandatoryBoundary("workflow.truthful-outcome", merged.length === prepared.parts.length && remaining.length === 0, "ship outcome is not fully verified");
    return missing.length ? { ok: false, reason: `missing shipped journal lines: ${missing.join(", ")}`, merged, remaining } : { ok: true, merged, remaining };
  } catch (error) { return { ok: false, reason: (error as Error).message }; }
}
