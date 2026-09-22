import { randomUUID } from "node:crypto";
import { canonicalHash } from "./group-state.ts";
import { visibleWorkflowText } from "./workflow-approval.ts";
import { assertMandatoryBoundary } from "./workflow-boundaries.ts";

export interface PlanApproachOwner { sessionId: string; runtimeId: string; planRunId: string }
export interface AcceptedScoutBinding { ticket: string; acceptanceId: number; hash: string }
export interface PlanApproachProposal {
  planRunId: string;
  owner: PlanApproachOwner;
  generation: number;
  approachText: string;
  approachHash: string;
  treeHash: string;
  acceptedScouts: AcceptedScoutBinding[];
}
export interface PlanApproachInput { serial: number; proposalGeneration: number; inputHash: string }
export interface PlanApproachReceipt {
  id: string;
  proposal: PlanApproachProposal;
  input: PlanApproachInput;
  evidence: { start: number; end: number; text: string }[];
  state: "current" | "consumed" | "revoked";
}
export type PlanApproachExtraction = { kind: "none" } | { kind: "approve" | "revoke"; evidence: { start: number; end: number; text: string }[] };

const cloneProposal = (proposal: PlanApproachProposal): PlanApproachProposal => ({ ...proposal, owner: { ...proposal.owner }, acceptedScouts: proposal.acceptedScouts.map((scout) => ({ ...scout })) });
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const approval = /\b(?:approve|approved|agree|agreed|confirmed|proceed|looks good)\b|(?:согласен|согласна|согласовано|подтверждаю|подтверждено|подходит|давай(?:те)?\s+так|окей)/iu;
const revoke = /\b(?:stop|cancel|reject|revoke|change the approach)\b|(?:стоп|отмени|не\s+согласен|отклоняю|измени\s+подход)/iu;
const ambiguous = /\?|\b(?:if|would|could|maybe|perhaps|hypothetically)\b|(?:если|может|возможно|а\s+что\s+если|гипотет)/iu;
const negativeApproval = /\b(?:do not|don['’]t|not approved|disagree)\b|(?:не\s+(?:согласен|подтверждаю|подходит)|не\s+надо)/iu;

export function validatePlanApproachExtraction(value: unknown, raw: string): PlanApproachExtraction {
  const fail = (reason: string): never => { throw new Error(`plan approach extraction: ${reason}`); };
  if (!record(value)) return fail("result must be an object");
  if (value.kind === "none") {
    if (!exactKeys(value, ["kind"])) return fail("extra fields");
    return { kind: "none" };
  }
  if (!exactKeys(value, ["kind", "evidence"]) || value.kind !== "approve" && value.kind !== "revoke") return fail("invalid fields or kind");
  if (!Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 8) return fail("missing evidence");
  for (const span of value.evidence) {
    if (!record(span) || !exactKeys(span, ["start", "end", "text"]) || !Number.isInteger(span.start) || !Number.isInteger(span.end) || typeof span.text !== "string" || Number(span.start) < 0 || Number(span.end) <= Number(span.start) || Number(span.end) > raw.length || raw.slice(Number(span.start), Number(span.end)) !== span.text) return fail("literal evidence span mismatch");
  }
  const visible = visibleWorkflowText(raw).trim();
  if (ambiguous.test(visible)) return fail("question or hypothetical cannot approve an approach");
  if (value.kind === "approve" && (!approval.test(visible) || negativeApproval.test(visible))) return fail("current input does not unambiguously approve the approach");
  if (value.kind === "revoke" && !revoke.test(visible)) return fail("current input does not revoke the approach");
  return value as PlanApproachExtraction;
}

export class PlanApproachStore {
  readonly owner: PlanApproachOwner;
  private generation = 0;
  private inputSerial = 0;
  private shown?: PlanApproachProposal;
  private input?: PlanApproachInput;
  private raw = "";
  private receipt?: PlanApproachReceipt;

  constructor(owner: PlanApproachOwner) {
    if (!owner.sessionId || !owner.runtimeId || !owner.planRunId) throw new Error("invalid plan approach owner");
    this.owner = { ...owner };
  }

  present(input: { approachText: string; treeHash: string; acceptedScouts: AcceptedScoutBinding[] }): PlanApproachProposal {
    if (!input.approachText.trim() || !/^[a-f0-9]{64}$/.test(input.treeHash)) throw new Error("approach proposal is incomplete");
    const tickets = new Set(input.acceptedScouts.map((scout) => scout.ticket));
    if (!input.acceptedScouts.length || tickets.size !== input.acceptedScouts.length || input.acceptedScouts.some((scout) => !Number.isInteger(scout.acceptanceId) || scout.acceptanceId < 1 || !/^[a-f0-9]{64}$/.test(scout.hash))) throw new Error("accepted scout bindings are incomplete");
    this.revoke();
    this.generation++;
    const acceptedScouts = input.acceptedScouts.map((scout) => ({ ...scout })).sort((a, b) => a.ticket.localeCompare(b.ticket));
    this.shown = {
      planRunId: this.owner.planRunId,
      owner: { ...this.owner },
      generation: this.generation,
      approachText: input.approachText,
      approachHash: canonicalHash(input.approachText),
      treeHash: input.treeHash,
      acceptedScouts,
    };
    this.input = undefined;
    this.raw = "";
    return cloneProposal(this.shown);
  }

  observeInput(raw: string, owner: PlanApproachOwner): PlanApproachInput {
    this.assertOwner(owner);
    if (!this.shown) throw new Error("plan approach has not been presented");
    this.inputSerial++;
    this.raw = raw;
    this.input = { serial: this.inputSerial, proposalGeneration: this.shown.generation, inputHash: canonicalHash(raw) };
    if (this.receipt?.state !== "consumed") this.receipt = undefined;
    return { ...this.input };
  }

  approve(input: PlanApproachInput, extraction: PlanApproachExtraction, owner: PlanApproachOwner): PlanApproachReceipt {
    this.assertOwner(owner);
    if (!this.shown || !this.input || JSON.stringify(input) !== JSON.stringify(this.input) || input.proposalGeneration !== this.shown.generation) throw new Error("stale plan approach input");
    if (extraction.kind !== "approve") throw new Error("plan approach was not approved");
    const validated = validatePlanApproachExtraction(extraction, this.raw);
    if (validated.kind !== "approve") throw new Error("plan approach was not approved");
    this.receipt = { id: randomUUID(), proposal: cloneProposal(this.shown), input: { ...this.input }, evidence: validated.evidence.map((span) => ({ ...span })), state: "current" };
    return this.currentReceipt();
  }

  assertCurrent(input: { treeHash: string; acceptedScouts: AcceptedScoutBinding[]; approachHash?: string; consume?: boolean }, owner: PlanApproachOwner): PlanApproachReceipt {
    this.assertOwner(owner);
    const receipt = this.receipt;
    assertMandatoryBoundary("workflow.plan-approach", Boolean(receipt) && receipt!.state === "current", "a current interactive plan approach receipt is required");
    if (!receipt) throw new Error("unreachable plan approach refusal");
    const scouts = input.acceptedScouts.map((scout) => ({ ...scout })).sort((a, b) => a.ticket.localeCompare(b.ticket));
    assertMandatoryBoundary("workflow.plan-approach", receipt.proposal.treeHash === input.treeHash && JSON.stringify(receipt.proposal.acceptedScouts) === JSON.stringify(scouts) && (!input.approachHash || receipt.proposal.approachHash === input.approachHash), "plan approach receipt is stale for the current tree, scouts or approach");
    if (input.consume) receipt.state = "consumed";
    return this.currentReceipt();
  }

  revoke(): void {
    if (this.receipt && this.receipt.state !== "consumed") this.receipt.state = "revoked";
  }

  private currentReceipt(): PlanApproachReceipt {
    if (!this.receipt) throw new Error("plan approach receipt is missing");
    return { ...this.receipt, proposal: cloneProposal(this.receipt.proposal), input: { ...this.receipt.input }, evidence: this.receipt.evidence.map((span) => ({ ...span })) };
  }

  private assertOwner(owner: PlanApproachOwner): void {
    assertMandatoryBoundary("workflow.live-owner", owner.sessionId === this.owner.sessionId && owner.runtimeId === this.owner.runtimeId && owner.planRunId === this.owner.planRunId, "plan approach owner mismatch");
  }
}

export const PLAN_APPROACH_EXTRACTION_INSTRUCTION = `Classify only the current raw interactive engineer input after a concrete plan approach was displayed in the same owned plan surface. Return one JSON object and no tools. Approval must be an unambiguous present-tense agreement with that shown approach. Questions, quotations, reports, conditions, hypotheses and negations are none. Stop, rejection or a requested material approach change is revoke. Schema: {"kind":"none"} or {"kind":"approve"|"revoke","evidence":[{"start":0,"end":1,"text":"literal substring"}]}. Evidence offsets are UTF-16 indices into the unchanged raw input. Do not infer approval from history or from an agent/tool message. No extra fields.`;
