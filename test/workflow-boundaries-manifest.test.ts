import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MANDATORY_WORKFLOW_BOUNDARIES, MANDATORY_WORKFLOW_BOUNDARY_IDS, WORKFLOW_BOUNDARY_CONSUMER_MANIFEST } from "../src/workflow-boundaries.ts";

const plannedConsumers = ["bash-guard", "guards", "mode-guard", "mode-tab", "stage", "transitions", "report-guard", "bus", "inbox", "guard-policy", "coordinator-runtime", "list-run", "coordinator-control", "coordinator-launch", "plan-binding", "research-guard", "workflow-approval", "coordinator-result", "record-report", "coordinator-merge", "subagent-runs", "plan-scout-recovery", "plan-publication-target", "workflow-incident-state", "workflow-break-glass", "plan-record", "plan-publication", "subagent-extension"];

const sourceFor = (consumer: string): string => readFileSync(consumer === "subagent-extension"
  ? join(import.meta.dirname, "..", ".pi", "extensions", "subagent", "index.ts")
  : join(import.meta.dirname, "..", "src", `${consumer}.ts`), "utf8");

test("workflow boundary consumer manifest is exhaustive and names only mandatory boundaries", () => {
  assert.deepEqual(plannedConsumers.filter((consumer) => !(consumer in WORKFLOW_BOUNDARY_CONSUMER_MANIFEST)), []);
  const covered = new Set(Object.values(WORKFLOW_BOUNDARY_CONSUMER_MANIFEST).flat());
  assert.deepEqual(MANDATORY_WORKFLOW_BOUNDARY_IDS.filter((id) => !covered.has(id)), []);
  for (const [consumer, ids] of Object.entries(WORKFLOW_BOUNDARY_CONSUMER_MANIFEST)) {
    assert.equal(new Set(ids).size, ids.length, `${consumer} duplicates a boundary`);
    const source = sourceFor(consumer);
    for (const id of ids) {
      assert.ok(id in MANDATORY_WORKFLOW_BOUNDARIES, `${consumer}: ${id}`);
      assert.match(source, new RegExp(`assertMandatoryBoundary\\(["']${id.replaceAll(".", "\\.")}["']`), `${consumer} declares ${id} without an actual assertion`);
    }
  }
});
