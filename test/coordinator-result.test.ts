import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareDo, type PreparedCoordinator } from "../src/coordinator-launch.ts";
import { verifyCoordinatorOutcome, verifyGate, type GateFacts, type GatePartFacts, type RollupEntry } from "../src/coordinator-result.ts";
import { openDb } from "../src/db.ts";
import { requiredJobs } from "../src/required-checks.ts";
import { git, green, notify, stand, withShim, writePr, writeReceipt } from "./fixtures/gate-stand.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
// Synthetic multi-job workflow, not yokemate's actual CI contract.
const required = requiredJobs([{ path: "fixture.yml", text: "name: ci\non: pull_request\njobs:\n  checks:\n    runs-on: ubuntu-latest\n  secondary-check:\n    runs-on: ubuntu-latest\n" }]);

function part(overrides: Partial<GatePartFacts> = {}, rollup: RollupEntry[] = [green("checks"), green("secondary-check"), notify]): GatePartFacts {
  return {
    repo: "org/repo",
    pr: { url: "https://github.com/org/repo/pull/1", state: "OPEN", headRefName: "YM-1", headRefOid: HEAD, baseRefName: "main", baseRefOid: BASE, statusCheckRollup: rollup },
    localHead: HEAD, baseHead: BASE, baseInHead: true, required,
    manifestHash: "m", lockHash: "l",
    receipt: { worktree: "/w", branch: "YM-1", head: HEAD, lockfile: "pnpm-lock.yaml", lockHash: "l", manifestHash: "m", command: "pnpm install --frozen-lockfile --prod=false", exit: 0, bins: {}, packages: {}, at: "t" },
    ...overrides,
  };
}

const facts = (...parts: GatePartFacts[]): GateFacts => ({ ticket: "YM-1", parts });
const reason = (verdict: ReturnType<typeof verifyGate>) => verdict.ok ? "" : verdict.reason;

test("verifyGate refuses each broken fact with its own reason", () => {
  const base = part();
  assert.match(reason(verifyGate(facts(part({ pr: { ...base.pr, state: "MERGED" } })))), /^org\/repo: PR is not open on YM-1/);
  assert.match(reason(verifyGate(facts(part({ pr: { ...base.pr, headRefName: "other" } })))), /^org\/repo: PR is not open on YM-1/);
  assert.match(reason(verifyGate(facts(part({ localHead: null })))), /^org\/repo: PR head aaaaaaa differs from local branch YM-1 head none/);
  assert.match(reason(verifyGate(facts(part({ localHead: "c".repeat(40) })))), /^org\/repo: PR head aaaaaaa differs from local branch YM-1 head ccccccc/);
  assert.match(reason(verifyGate(facts(part({ receipt: null })))), /^org\/repo: no ready receipt — run pnpm ready YM-1/);
  assert.match(reason(verifyGate(facts(part({ receipt: { ...base.receipt!, head: "d".repeat(40) } })))), /^org\/repo: ready receipt is for ddddddd but the PR head is aaaaaaa/);
  assert.match(reason(verifyGate(facts(part({ lockHash: "other" })))), /^org\/repo: ready receipt was taken on a lockfile or package.json that differs/);
  assert.match(reason(verifyGate(facts(part({ manifestHash: null })))), /^org\/repo: ready receipt was taken on a lockfile or package.json that differs/);
  assert.match(reason(verifyGate(facts(part({ receipt: { ...base.receipt!, exit: 1 } })))), /^org\/repo: ready receipt records a failed bootstrap \(exit 1\)/);
  assert.match(reason(verifyGate(facts(part({ baseInHead: false })))), /^org\/repo: base main is at bbbbbbb and it is not in the PR head/);
  assert.match(reason(verifyGate(facts(part({}, [notify])))), /^org\/repo: required job ci\/checks is missing from the PR checks/);
  assert.match(reason(verifyGate(facts(part({}, [{ ...green("checks"), status: "IN_PROGRESS", conclusion: null }, green("secondary-check")])))), /^org\/repo: required job ci\/checks is pending/);
  assert.match(reason(verifyGate(facts(part({}, [{ ...green("checks"), conclusion: "SKIPPED" }, green("secondary-check")])))), /^org\/repo: required job ci\/checks is SKIPPED/);
  assert.match(reason(verifyGate(facts(part({}, [green("checks"), { ...green("secondary-check"), conclusion: "FAILURE" }])))), /^org\/repo: required job ci\/secondary-check is FAILURE/);
});

test("verifyGate passes a green part and an empty CI contract with a receipt", () => {
  assert.deepEqual(verifyGate(facts(part())), { ok: true, heads: { "org/repo": HEAD } });
  assert.deepEqual(verifyGate(facts(part({ required: [] }, []))), { ok: true, heads: { "org/repo": HEAD } });
  assert.deepEqual(verifyGate(facts(part({}, [{ ...green("checks (22)") }, green("secondary-check / smoke")]))), { ok: true, heads: { "org/repo": HEAD } });
});

test("verifyGate names the second part when it is the broken one", () => {
  const second = part({ repo: "org/other", receipt: null });
  assert.match(reason(verifyGate(facts(part(), second))), /^org\/other: no ready receipt/);
});

test("ship verification reads the journal after the worktree is gone", async () => {
  const s = stand("YM-1");
  try {
    writeFileSync(join(s.shim, "34.json"), JSON.stringify({ state: "MERGED", mergedAt: "2026-09-12T20:00:00Z", headRefName: "YM-1", url: "https://github.com/org/repo/pull/34" }));
    rmSync(join(s.root, "work"), { recursive: true, force: true });
    const prepared = { mode: "ship", tickets: ["YM-1"], model: "m", cwd: s.root, plans: {}, prompt: "", skillsPath: "", resourcesPath: "", parts: [{ repo: "org/repo", org: "org", role: "app", roleAssumed: false, path: join(s.root, "work", "YM-1", "repo"), branch: "YM-1", pr: "https://github.com/org/repo/pull/34" }] } as PreparedCoordinator;
    await withShim(s, () => {
      assert.deepEqual(verifyCoordinatorOutcome(s.root, prepared, { outcome: "done", summary: "" }), { ok: false, reason: "missing shipped journal lines: YM-1", merged: ["https://github.com/org/repo/pull/34"], remaining: [] });
      mkdirSync(join(s.root, "home", "journal"), { recursive: true });
      writeFileSync(join(s.root, "home", "journal", "2026-09.md"), "- 2026-09-12 20:00 YM-1 отгружено\n");
      assert.deepEqual(verifyCoordinatorOutcome(s.root, prepared, { outcome: "done", summary: "" }), { ok: true, merged: ["https://github.com/org/repo/pull/34"], remaining: [] });
    });
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("blocked ship verification reports confirmed merged and remaining parts", async () => {
  const s = stand("YM-1");
  try {
    writeFileSync(join(s.shim, "34.json"), JSON.stringify({ state: "MERGED", mergedAt: "2026-09-12T20:00:00Z", headRefName: "YM-1", headRefOid: HEAD, url: "https://github.com/org/repo/pull/34" }));
    writeFileSync(join(s.shim, "35.json"), JSON.stringify({ state: "OPEN", headRefName: "YM-1", headRefOid: HEAD, url: "https://github.com/org/other/pull/35" }));
    const prepared = { mode: "ship", tickets: ["YM-1"], model: "m", cwd: s.root, plans: {}, prompt: "", skillsPath: "", resourcesPath: "", parts: [
      { repo: "org/repo", org: "org", role: "app", roleAssumed: false, path: s.worktree, passportPath: s.root, branch: "YM-1", pr: "https://github.com/org/repo/pull/34" },
      { repo: "org/other", org: "org", role: "app", roleAssumed: false, path: s.worktree, passportPath: s.root, branch: "YM-1", pr: "https://github.com/org/other/pull/35" },
    ] } as PreparedCoordinator;
    await withShim(s, () => {
      const result = verifyCoordinatorOutcome(s.root, prepared, { outcome: "blocked", summary: "", reason: "second PR blocked" });
      assert.deepEqual(result.merged, ["https://github.com/org/repo/pull/34"]);
      assert.deepEqual(result.remaining, ["https://github.com/org/other/pull/35"]);
      assert.deepEqual(result.partFacts?.map(({ repo, state }) => ({ repo, state })), [{ repo: "org/repo", state: "merged" }, { repo: "org/other", state: "remaining" }]);
    });
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("do verification runs the gate on the recorded PR", async () => {
  const s = stand("YM-9");
  try {
    mkdirSync(join(s.root, ".pi", "agents", "do"), { recursive: true });
    writeFileSync(join(s.root, ".pi", "settings.json"), "{}");
    const plan = join(s.root, "home", "knowledge", "org", "repo", "ai", "YM-9-work", "YM-9-work-plan.md");
    const prepared = prepareDo(s.root, { mode: "do", tickets: ["YM-9"], plan }, {});
    const db = openDb(join(s.root, "yokemate.db"));
    db.prepare("INSERT INTO work (ticket, url, stage) VALUES ('YM-9','u','review')").run();
    const work = db.prepare("SELECT id FROM work WHERE ticket = 'YM-9'").get() as { id: number };
    db.prepare("INSERT INTO part (work_id, repo, role, branch, pr) VALUES (?, 'org/repo', 'app', 'YM-9', 'https://github.com/org/repo/pull/34')").run(work.id);
    writeReceipt(s);
    await withShim(s, () => {
      writePr(s, "34", [{ ...green("checks"), conclusion: "FAILURE" }, notify]);
      assert.match(verifyCoordinatorOutcome(s.root, prepared, { outcome: "done", summary: "" }).reason ?? "", /required job ci\/checks is FAILURE/);
      writePr(s, "34", [{ ...green("checks"), status: "IN_PROGRESS", conclusion: null }, notify]);
      assert.match(verifyCoordinatorOutcome(s.root, prepared, { outcome: "done", summary: "" }).reason ?? "", /is pending/);
      writePr(s, "34", [green("checks"), notify]);
      assert.deepEqual(verifyCoordinatorOutcome(s.root, prepared, { outcome: "done", summary: "" }), { ok: true, parts: ["org/repo"] });
    });
    assert.equal(git(s.worktree, "rev-parse", "--abbrev-ref", "HEAD"), "YM-9");
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});
