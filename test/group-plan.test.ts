import { test } from "node:test";
import assert from "node:assert/strict";
import { bindGroupRevision, parseGroupExecution, validateCompatibility, validateGroupManifest, type CompatibilityReport, type GroupExecutionManifest } from "../src/group-plan.ts";
import type { TaskTree } from "../src/group-tree.ts";
import type { PlanBinding } from "../src/plan-binding.ts";

const tree: TaskTree = {
  root: { identity: "yt:YM-1", ticket: "YM-1", parentIdentity: null, issueSnapshotHash: "1".repeat(64), trackerState: "open" },
  nodes: [
    { identity: "yt:YM-1", ticket: "YM-1", parentIdentity: null, issueSnapshotHash: "1".repeat(64), trackerState: "open" },
    { identity: "yt:YM-2", ticket: "YM-2", parentIdentity: "yt:YM-1", issueSnapshotHash: "2".repeat(64), trackerState: "open" },
  ],
  treeHash: "a".repeat(64),
};

const manifest: GroupExecutionManifest = {
  version: 1,
  root: "YM-1",
  ownerProject: "yokeloop/yokemate-pi",
  members: [
    { ticket: "YM-1", parent: null, ownWork: "coordination-only", implementationRepos: [], requirements: ["R1"] },
    { ticket: "YM-2", parent: "YM-1", ownWork: "implementation", implementationRepos: ["yokeloop/yokemate-pi"], requirements: ["R2"] },
  ],
  requirements: [
    { id: "R1", sourceTicket: "YM-1", text: "Coordinate", owner: "YM-1", planStep: "1", acceptance: "Graph verified" },
    { id: "R2", sourceTicket: "YM-2", text: "Implement", owner: "YM-2", planStep: "1", acceptance: "Tests pass" },
  ],
  contracts: [{ id: "C1", providers: ["YM-2"], consumers: ["YM-1"], specification: "JSON v1", verification: "schema test" }],
  startDependencies: [{ before: "YM-2", after: "YM-1", when: "integrated" }],
  acceptanceObligations: [{ id: "A1", members: ["YM-1", "YM-2"], repos: ["yokeloop/yokemate-pi"], criterion: "assembled", evidenceRequired: "green check" }],
  repositories: [{ repo: "yokeloop/yokemate-pi", role: "app" }],
  planRefs: [{ ticket: "YM-1", path: "ai/YM-1-root/YM-1-root-plan.md" }, { ticket: "YM-2", path: "ai/YM-2-child/YM-2-child-plan.md" }],
};

const bindings: PlanBinding[] = [
  { ticket: "YM-1", path: "/knowledge/YM-1.md", contentHash: "b".repeat(64), scopeHash: "c".repeat(64), repositories: ["yokeloop/yokemate-pi"] },
  { ticket: "YM-2", path: "/knowledge/YM-2.md", contentHash: "d".repeat(64), scopeHash: "e".repeat(64), repositories: ["yokeloop/yokemate-pi"] },
];

const compatibility = (inputHash: string): CompatibilityReport => ({
  inputHash,
  requirements: [{ id: "R1", coveredBy: "YM-1 step 1", evidence: "plan" }, { id: "R2", coveredBy: "YM-2 step 1", evidence: "plan" }],
  contracts: [{ id: "C1", providers: ["YM-2"], consumers: ["YM-1"], evidence: "matching JSON v1" }],
  parentWork: [{ ticket: "YM-1", evidence: "coordination declared" }, { ticket: "YM-2", evidence: "parent relation reviewed" }],
  conflicts: [],
});

test("parses the one group-execution block from Steps", () => {
  const markdown = `# YM-1\n\n## Goal\nG\n\n## Affected repositories\n- yokeloop/yokemate-pi\n\n## Steps\n\n\`\`\`group-execution\n${JSON.stringify(manifest)}\n\`\`\`\n\n## Assumptions\nA`;
  assert.deepEqual(parseGroupExecution(markdown), manifest);
  assert.throws(() => parseGroupExecution(markdown.replace("group-execution", "json")), /exactly one/);
});

test("revision hash is stable without self-reference and compatibility binds to it", () => {
  const first = bindGroupRevision({ rootIdentity: "youtrack-yokeloop:YM-1", ownerProject: manifest.ownerProject, tree, manifest, bindings });
  const second = bindGroupRevision({ rootIdentity: "youtrack-yokeloop:YM-1", ownerProject: manifest.ownerProject, tree, manifest: structuredClone(manifest), bindings: [...bindings].reverse() });
  assert.equal(first.revisionHash, second.revisionHash);
  assert.match(first.revisionHash, /^[a-f0-9]{64}$/);
  assert.doesNotThrow(() => validateCompatibility(compatibility(first.revisionHash), first));
  assert.throws(() => validateCompatibility({ ...compatibility(first.revisionHash), inputHash: "0".repeat(64) }, first), /stale/);
});

test("missing requirements, parent, contracts, repo union and start cycles block activation", () => {
  assert.throws(() => validateGroupManifest({ ...manifest, requirements: manifest.requirements.slice(0, 1) }, tree), /requirement ownership/);
  assert.throws(() => validateGroupManifest({ ...manifest, members: manifest.members.map((member) => member.ticket === "YM-2" ? { ...member, parent: "YM-9" } : member) }, tree), /parent is missing/);
  assert.throws(() => validateGroupManifest({ ...manifest, contracts: [{ ...manifest.contracts[0]!, consumers: ["YM-9"] }] }, tree), /unknown provider or consumer/);
  assert.throws(() => validateGroupManifest({ ...manifest, repositories: [{ repo: "other/repo", role: "app" }] }, tree), /repository union/);
  assert.throws(() => validateGroupManifest({ ...manifest, startDependencies: [{ before: "YM-1", after: "YM-2", when: "integrated" }, { before: "YM-2", after: "YM-1", when: "integrated" }] }, tree), /cycle/);
});

test("acceptance obligations do not become start dependencies", () => {
  const withObligationCycle = { ...manifest, acceptanceObligations: [{ ...manifest.acceptanceObligations[0]!, members: ["YM-2", "YM-1"] }] };
  assert.doesNotThrow(() => validateGroupManifest(withObligationCycle, tree));
});

test("semantic compatibility requires evidence for every requirement, contract and parent work", () => {
  const revision = bindGroupRevision({ rootIdentity: "youtrack-yokeloop:YM-1", ownerProject: manifest.ownerProject, tree, manifest, bindings });
  assert.throws(() => validateCompatibility({ ...compatibility(revision.revisionHash), requirements: [] }, revision), /R1/);
  assert.throws(() => validateCompatibility({ ...compatibility(revision.revisionHash), contracts: [] }, revision), /C1/);
  assert.throws(() => validateCompatibility({ ...compatibility(revision.revisionHash), parentWork: [] }, revision), /YM-1/);
  assert.throws(() => validateCompatibility({ ...compatibility(revision.revisionHash), conflicts: ["mismatch"] }, revision), /conflicts/);
});
