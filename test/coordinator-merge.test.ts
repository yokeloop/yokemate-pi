import test from "node:test";
import assert from "node:assert/strict";
import { canonicalRepository, coordinatorMerge, repositoryFromPr, type CoordinatorMergeDeps, type MergeSnapshot } from "../src/coordinator-merge.ts";
import type { PreparedPart } from "../src/coordinator-launch.ts";

const HEAD = "a".repeat(40);
const snapshot = (repo = "repo", state = "OPEN"): MergeSnapshot => ({ url: `https://github.com/org/${repo}/pull/1`, state, headRefName: "YM-1", headRefOid: HEAD, baseRefName: "main", ...(state === "MERGED" ? { mergedAt: "2026-09-17T00:00:00Z" } : {}) });
const part = (repo = "repo"): PreparedPart => ({ repo: `org/${repo}`, org: "org", role: "app", roleAssumed: false, path: `/tmp/${repo}`, passportPath: `/tmp/${repo}`, branch: "YM-1", pr: `https://github.com/org/${repo}/pull/1`, base: "main", remote: `git@github.com:org/${repo}.git`, observedHead: HEAD });

function scope(repo = "repo", live = () => true) { return { root: "/root", runId: `run-${repo}`, ticket: "YM-1", part: part(repo), live }; }
function deps(values: MergeSnapshot[], merge: CoordinatorMergeDeps["merge"] = async () => ({ exit: 0, output: "" })): CoordinatorMergeDeps {
  return { snapshot: async () => values.shift()!, gate: async (_root, _ticket, prepared) => ({ ok: true, heads: { [prepared.repo]: HEAD } }), merge };
}

test("canonical repository normalizes SSH, HTTPS and PR identities", () => {
  assert.equal(canonicalRepository("git@github.com:Org/Repo.git"), "github.com/org/repo");
  assert.equal(canonicalRepository("https://github.com/Org/Repo.git"), "github.com/org/repo");
  assert.equal(repositoryFromPr("https://github.com/Org/Repo/pull/1"), "github.com/org/repo");
});

test("same repository and base serializes fresh sections while different repositories overlap", async () => {
  let active = 0;
  let max = 0;
  const entered: (() => void)[] = [];
  const makeDeps = (repo: string): CoordinatorMergeDeps => ({
    snapshot: async () => snapshot(repo),
    gate: async (_root, _ticket, prepared) => {
      active++;
      max = Math.max(max, active);
      await new Promise<void>((resolve) => entered.push(resolve));
      active--;
      return { ok: true, heads: { [prepared.repo]: HEAD } };
    },
    merge: async () => ({ exit: 1, output: "not merged" }),
  });
  const one = coordinatorMerge({ ...scope("repo"), runId: "same-1" }, { pr: snapshot("repo").url, expectedHead: HEAD, method: "merge" }, makeDeps("repo"));
  const two = coordinatorMerge({ ...scope("repo"), runId: "same-2" }, { pr: snapshot("repo").url, expectedHead: HEAD, method: "merge" }, makeDeps("repo"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(entered.length, 1);
  entered.shift()!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(entered.length, 1);
  entered.shift()!();
  await Promise.all([one, two]);
  assert.equal(max, 1);

  active = 0;
  max = 0;
  const left = coordinatorMerge(scope("left"), { pr: snapshot("left").url, expectedHead: HEAD, method: "merge" }, makeDeps("left"));
  const right = coordinatorMerge(scope("right"), { pr: snapshot("right").url, expectedHead: HEAD, method: "merge" }, makeDeps("right"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(entered.length, 2);
  entered.splice(0).forEach((release) => release());
  await Promise.all([left, right]);
  assert.equal(max, 2);
});

test("ambiguous merge reconciles exact merged state and duplicate attempt is not spawned twice", async () => {
  let merges = 0;
  const request = { pr: snapshot().url, expectedHead: HEAD, method: "squash" as const };
  const first = await coordinatorMerge(scope(), request, deps([snapshot(), snapshot("repo", "MERGED")], async () => { merges++; return { exit: 1, output: "network lost" }; }));
  assert.equal(first.state, "merged");
  const repeated = await coordinatorMerge(scope(), request, deps([], async () => { merges++; return { exit: 0, output: "" }; }));
  assert.equal(repeated.state, "merged");
  assert.equal(repeated.repeated, true);
  assert.equal(merges, 1);
});

test("open reconciliation is truthful and revocation before spawn refuses", async () => {
  const open = await coordinatorMerge({ ...scope(), runId: "open-run" }, { pr: snapshot().url, expectedHead: HEAD, method: "merge" }, deps([snapshot(), snapshot()], async () => ({ exit: 1, output: "required check changed" })));
  assert.deepEqual({ state: open.state, reason: open.reason }, { state: "open", reason: "required check changed" });
  let live = true;
  let spawned = false;
  const revokedDeps: CoordinatorMergeDeps = { snapshot: async () => snapshot("revoked"), gate: async (_root, _ticket, prepared) => { live = false; return { ok: true, heads: { [prepared.repo]: HEAD } }; }, merge: async () => { spawned = true; return { exit: 0, output: "" }; } };
  await assert.rejects(() => coordinatorMerge({ ...scope("revoked", () => live), runId: "revoked-run" }, { pr: snapshot("revoked").url, expectedHead: HEAD, method: "rebase" }, revokedDeps), /revoked before merge spawn/);
  assert.equal(spawned, false);
});
