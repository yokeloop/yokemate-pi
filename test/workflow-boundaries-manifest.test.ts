import assert from "node:assert/strict";
import { test } from "node:test";
import { MANDATORY_WORKFLOW_BOUNDARIES, MANDATORY_WORKFLOW_BOUNDARY_IDS, WORKFLOW_BOUNDARY_CONSUMER_MANIFEST } from "../src/workflow-boundaries.ts";

const plannedConsumers = ["bash-guard", "guards", "mode-guard", "mode-tab", "stage", "transitions", "report-guard", "bus", "inbox", "guard-policy", "coordinator-runtime", "list-run", "coordinator-control", "coordinator-launch", "plan-binding", "research-guard", "workflow-approval", "coordinator-result", "record-report", "coordinator-merge", "subagent-runs", "plan-publication-target", "subagent-extension"];

test("workflow boundary consumer manifest is exhaustive and names only mandatory boundaries", () => {
  assert.deepEqual(plannedConsumers.filter((consumer) => !(consumer in WORKFLOW_BOUNDARY_CONSUMER_MANIFEST)), []);
  const covered = new Set(Object.values(WORKFLOW_BOUNDARY_CONSUMER_MANIFEST).flat());
  assert.deepEqual(MANDATORY_WORKFLOW_BOUNDARY_IDS.filter((id) => !covered.has(id)), []);
  for (const [consumer, ids] of Object.entries(WORKFLOW_BOUNDARY_CONSUMER_MANIFEST)) {
    assert.equal(new Set(ids).size, ids.length, `${consumer} duplicates a boundary`);
    for (const id of ids) assert.ok(id in MANDATORY_WORKFLOW_BOUNDARIES, `${consumer}: ${id}`);
  }
});
