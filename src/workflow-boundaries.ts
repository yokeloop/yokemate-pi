import type { GuardId, GuardPolicy } from "./guard-policy.ts";

export const MANDATORY_WORKFLOW_BOUNDARY_IDS = [
  "workflow.assigned-scope",
  "workflow.target-identity",
  "workflow.required-data",
  "workflow.external-auth",
  "workflow.quality-gates",
  "workflow.ready-pr-report",
  "workflow.explicit-ship",
  "workflow.do-authority",
  "workflow.truthful-outcome",
  "workflow.live-owner",
  "workflow.plan-binding",
  "workflow.terminal-lineage",
  "workflow.single-use",
  "workflow.audit",
  "plan.scout.complete-bytes",
  "plan.writer.admission",
] as const;

export const RECOVERABLE_WORKFLOW_BOUNDARY_ID = "plan.scout.transport-input" as const;
export const RECOVERY_ACTION = "accept-plan-scout-input" as const;

export type MandatoryWorkflowBoundaryId = typeof MANDATORY_WORKFLOW_BOUNDARY_IDS[number];
export type PolicyWorkflowBoundaryId = `policy.${GuardId}`;
export type WorkflowBoundaryId = MandatoryWorkflowBoundaryId | PolicyWorkflowBoundaryId | typeof RECOVERABLE_WORKFLOW_BOUNDARY_ID;
export type WorkflowBoundaryClass = "mandatory" | "optional";
export type WorkflowBoundaryVerdict = "allow" | "refuse";

export interface WorkflowBoundary {
  readonly id: WorkflowBoundaryId;
  readonly owner: string;
  readonly entrypoints: readonly string[];
  readonly defaultVerdict: WorkflowBoundaryVerdict;
  readonly class: WorkflowBoundaryClass;
  readonly action?: typeof RECOVERY_ACTION;
}

export interface WorkflowBoundaryEvaluation {
  readonly id: WorkflowBoundaryId;
  readonly applicable: boolean;
  readonly verdict: WorkflowBoundaryVerdict;
  readonly reason: string;
}

const mandatory = (
  id: MandatoryWorkflowBoundaryId,
  owner: string,
  entrypoints: readonly string[],
): WorkflowBoundary => Object.freeze({ id, owner, entrypoints: Object.freeze([...entrypoints]), defaultVerdict: "refuse", class: "mandatory" });

export const MANDATORY_WORKFLOW_BOUNDARIES = Object.freeze({
  "workflow.assigned-scope": mandatory("workflow.assigned-scope", "request", ["bash-guard.judge", "guards.tool_call", "coordinator-launch.prepareDo", "coordinator-merge", "subagent.execute"]),
  "workflow.target-identity": mandatory("workflow.target-identity", "target", ["mode-guard", "mode-tab", "stage", "transitions", "bus", "inbox", "plan-publication-target"]),
  "workflow.required-data": mandatory("workflow.required-data", "effect", ["coordinator-launch", "plan-binding", "research-guard", "record-report", "plan-publication-target"]),
  "workflow.external-auth": mandatory("workflow.external-auth", "effect", ["workflow-approval", "research-guard", "plan-publication-target", "plan-publication.publishDocument"]),
  "workflow.quality-gates": mandatory("workflow.quality-gates", "repository", ["coordinator-result.verifyGate", "record-report", "coordinator-merge"]),
  "workflow.ready-pr-report": mandatory("workflow.ready-pr-report", "do", ["report-guard", "coordinator-result", "record-report", "coordinator-control"]),
  "workflow.explicit-ship": mandatory("workflow.explicit-ship", "engineer", ["mode-tab.ship", "coordinator-runtime.ShipPermitStore", "coordinator-launch.prepareShip", "coordinator-merge"]),
  "workflow.do-authority": mandatory("workflow.do-authority", "engineer", ["workflow-approval.DoAuthorityStore", "coordinator-launch.prepareDo", "coordinator-control", "subagent.startCoordinator"]),
  "workflow.truthful-outcome": mandatory("workflow.truthful-outcome", "effect", ["coordinator-result", "coordinator-control", "record-report", "plan-record", "subagent.finalizeShip"]),
  "workflow.live-owner": mandatory("workflow.live-owner", "runtime", ["coordinator-control", "list-run", "subagent-runs.OwnedChildState", "subagent.startCoordinator"]),
  "workflow.plan-binding": mandatory("workflow.plan-binding", "plan", ["plan-binding", "plan-record", "coordinator-control", "subagent.recordPlan"]),
  "workflow.terminal-lineage": mandatory("workflow.terminal-lineage", "runtime", ["coordinator-control", "list-run", "coordinator-result", "subagent.plan_finish"]),
  "workflow.single-use": mandatory("workflow.single-use", "authority", ["workflow-approval.DoAuthorityStore", "coordinator-runtime.ShipPermitStore", "workflow-break-glass.BreakGlassPermitStore", "workflow-incident-state"]),
  "workflow.audit": mandatory("workflow.audit", "incident", ["workflow-incident-state", "workflow-break-glass.resolveScoutAcceptance", "plan-record", "plan-publication"]),
  "plan.scout.complete-bytes": mandatory("plan.scout.complete-bytes", "plan-scout", ["subagent-runs.JsonlObservation", "plan-scout-recovery", "subagent.runSingleAgent", "plan-publication-state"]),
  "plan.writer.admission": mandatory("plan.writer.admission", "plan-writer", ["subagent.execute", "subagent.runDetachedAgent", "workflow-incident-state.claimWriterDispatch", "plan-record"]),
} satisfies Record<MandatoryWorkflowBoundaryId, WorkflowBoundary>);

export const RECOVERABLE_WORKFLOW_BOUNDARY: WorkflowBoundary = Object.freeze({
  id: RECOVERABLE_WORKFLOW_BOUNDARY_ID,
  owner: "engineer",
  entrypoints: Object.freeze(["workflow-ingress", "workflow-break-glass.previewScoutAcceptance", "workflow-break-glass.resolveScoutAcceptance"]),
  defaultVerdict: "refuse",
  class: "optional",
  action: RECOVERY_ACTION,
});

export function policyWorkflowBoundary(id: GuardId, entrypoints: readonly string[]): WorkflowBoundary {
  return Object.freeze({ id: `policy.${id}`, owner: "runtime-settings", entrypoints: Object.freeze([...entrypoints]), defaultVerdict: "refuse", class: "optional" });
}

export function optionalBoundaryApplicable(boundary: WorkflowBoundary, policy?: GuardPolicy): boolean {
  if (boundary.class !== "optional") return true;
  if (boundary.id === RECOVERABLE_WORKFLOW_BOUNDARY_ID) return true;
  if (!boundary.id.startsWith("policy.") || !policy) return false;
  return policy.guards[boundary.id.slice("policy.".length) as GuardId] === true;
}

export function evaluateWorkflowBoundary(
  boundary: WorkflowBoundary,
  facts: { satisfied: boolean; reason?: string; applicable?: boolean; policy?: GuardPolicy; action?: string },
): WorkflowBoundaryEvaluation {
  try {
    const applicable = boundary.class === "mandatory" ? true : facts.applicable ?? optionalBoundaryApplicable(boundary, facts.policy);
    if (!applicable) return { id: boundary.id, applicable: false, verdict: "allow", reason: "inapplicable" };
    if (boundary.id === RECOVERABLE_WORKFLOW_BOUNDARY_ID && facts.action !== RECOVERY_ACTION)
      return { id: boundary.id, applicable: true, verdict: "refuse", reason: "unknown recovery action" };
    return { id: boundary.id, applicable: true, verdict: facts.satisfied ? "allow" : boundary.defaultVerdict, reason: facts.satisfied ? "satisfied" : facts.reason ?? "boundary not satisfied" };
  } catch {
    return { id: boundary.id, applicable: true, verdict: "refuse", reason: "boundary evaluation failed" };
  }
}

export function assertRecoveryBoundary(id: string, action: string): void {
  if (id !== RECOVERABLE_WORKFLOW_BOUNDARY_ID || action !== RECOVERY_ACTION) throw new Error("unknown or immutable workflow boundary");
  const verdict = evaluateWorkflowBoundary(RECOVERABLE_WORKFLOW_BOUNDARY, { satisfied: true, action });
  if (verdict.verdict !== "allow") throw new Error(verdict.reason);
}
