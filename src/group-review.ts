import type { DatabaseSync } from "node:sqlite";
import { canonicalHash, canonicalJson } from "./group-state.ts";
import type { GroupAcceptanceObligation } from "./group-plan.ts";
import type { PlanBinding } from "./plan-binding.ts";

export interface GroupCandidatePart { repo: string; pr: string; headSha: string; baseRef: string; baseSha: string }
export interface ObligationEvidence { id: string; evidence: unknown; hash: string }
export interface GroupCandidate { groupId: string; revisionHash: string; parts: GroupCandidatePart[]; obligationEvidence: ObligationEvidence[]; candidateHash: string }
export interface GroupReviewDeps {
  verifyRepository(part: GroupCandidatePart): Promise<{ ok: boolean; reason?: string }>;
  verifyObligation(obligation: GroupAcceptanceObligation, evidence: ObligationEvidence): Promise<{ ok: boolean; reason?: string }>;
}
export interface GroupReworkBinding { groupId: string; revisionHash: string; candidateHash: string; reworkPlanBinding: PlanBinding }

export async function prepareGroupReview(db: DatabaseSync, input: { groupId: string; revisionHash: string; obligations: GroupAcceptanceObligation[]; evidence: ObligationEvidence[] }, deps: GroupReviewDeps): Promise<GroupCandidate> {
  const group = db.prepare("SELECT active_revision,phase FROM task_group WHERE id=?").get(input.groupId) as { active_revision: string | null; phase: string } | undefined;
  if (!group || group.active_revision !== input.revisionHash || group.phase !== "review") throw new Error("group review requires the active review revision");
  const incomplete = db.prepare("SELECT ticket,execution,blocker FROM group_member WHERE group_id=? AND revision_hash=? AND execution!='integrated' ORDER BY ticket").all(input.groupId, input.revisionHash) as unknown as { ticket: string; execution: string; blocker: string | null }[];
  if (incomplete.length) throw new Error(`group review is blocked by ${incomplete.map((row) => `${row.ticket}:${row.execution}${row.blocker ? `(${row.blocker})` : ""}`).join(", ")}`);
  const pendingTracker = db.prepare("SELECT effect_key,state FROM group_effect WHERE group_id=? AND revision_hash=? AND type='to_verify' AND state!='confirmed'").all(input.groupId, input.revisionHash) as unknown as { effect_key: string; state: string }[];
  if (pendingTracker.length) throw new Error(`group review tracker effects are pending: ${pendingTracker.map((effect) => `${effect.effect_key}:${effect.state}`).join(", ")}`);
  const repositories = db.prepare("SELECT repo,final_pr,head_sha,external_base,base_sha,ship_state FROM group_repository WHERE group_id=? AND revision_hash=? ORDER BY repo").all(input.groupId, input.revisionHash) as unknown as { repo: string; final_pr: string | null; head_sha: string | null; external_base: string; base_sha: string; ship_state: string }[];
  if (!repositories.length) throw new Error("group review has no final repositories");
  const parts = repositories.map((row): GroupCandidatePart => {
    if (!row.final_pr || !row.head_sha || !/^[0-9a-f]{40}$/.test(row.head_sha) || !/^[0-9a-f]{40}$/.test(row.base_sha) || !["ready", "pending"].includes(row.ship_state)) throw new Error(`${row.repo}: final group part is incomplete`);
    return { repo: row.repo, pr: row.final_pr, headSha: row.head_sha, baseRef: row.external_base, baseSha: row.base_sha };
  });
  for (const part of parts) {
    const verdict = await deps.verifyRepository(part);
    if (!verdict.ok) throw new Error(`${part.repo}: ${verdict.reason ?? "assembled repository verification failed"}`);
  }
  const evidenceById = new Map(input.evidence.map((evidence) => [evidence.id, evidence]));
  if (evidenceById.size !== input.evidence.length || input.evidence.length !== input.obligations.length) throw new Error("group acceptance obligation evidence is incomplete");
  for (const obligation of input.obligations) {
    const evidence = evidenceById.get(obligation.id);
    if (!evidence || !/^[a-f0-9]{64}$/.test(evidence.hash) || canonicalHash(evidence.evidence) !== evidence.hash) throw new Error(`${obligation.id}: acceptance evidence is missing or changed`);
    const verdict = await deps.verifyObligation(obligation, evidence);
    if (!verdict.ok) throw new Error(`${obligation.id}: ${verdict.reason ?? "acceptance obligation failed"}`);
  }
  const obligationEvidence = input.obligations.map((obligation) => evidenceById.get(obligation.id)!);
  const candidateHash = canonicalHash({ version: 1, groupId: input.groupId, revisionHash: input.revisionHash, parts, obligationEvidence });
  return { groupId: input.groupId, revisionHash: input.revisionHash, parts, obligationEvidence, candidateHash };
}

export function acceptGroupCandidate(db: DatabaseSync, candidate: GroupCandidate, input: { reviewSource: unknown; evidence: unknown }): void {
  const group = db.prepare("SELECT active_revision,phase FROM task_group WHERE id=?").get(candidate.groupId) as { active_revision: string | null; phase: string } | undefined;
  if (!group || group.active_revision !== candidate.revisionHash || !["review", "accepted"].includes(group.phase)) throw new Error("group acceptance candidate revision is stale");
  const repositories = db.prepare("SELECT repo,final_pr,head_sha,external_base,base_sha FROM group_repository WHERE group_id=? AND revision_hash=? ORDER BY repo").all(candidate.groupId, candidate.revisionHash) as unknown as { repo: string; final_pr: string | null; head_sha: string | null; external_base: string; base_sha: string }[];
  const currentParts = repositories.map((row) => ({ repo: row.repo, pr: row.final_pr, headSha: row.head_sha, baseRef: row.external_base, baseSha: row.base_sha }));
  if (canonicalHash({ version: 1, groupId: candidate.groupId, revisionHash: candidate.revisionHash, parts: currentParts, obligationEvidence: candidate.obligationEvidence }) !== candidate.candidateHash) throw new Error("group acceptance candidate changed before verdict");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE group_acceptance SET state='superseded' WHERE group_id=? AND revision_hash=? AND state='current' AND candidate_hash!=?").run(candidate.groupId, candidate.revisionHash, candidate.candidateHash);
    db.prepare(`INSERT INTO group_acceptance (group_id,revision_hash,candidate_hash,candidate_json,evidence_json,review_source_json,state)
      VALUES (?,?,?,?,?,?,'current') ON CONFLICT(group_id,revision_hash,candidate_hash) DO UPDATE SET evidence_json=excluded.evidence_json,review_source_json=excluded.review_source_json,state='current'`).run(candidate.groupId, candidate.revisionHash, candidate.candidateHash, canonicalJson(candidate), canonicalJson(input.evidence), canonicalJson(input.reviewSource));
    db.prepare("UPDATE task_group SET phase='accepted',blocker=NULL,resume_phase=NULL,updated_at=datetime('now') WHERE id=? AND active_revision=? AND phase IN ('review','accepted')").run(candidate.groupId, candidate.revisionHash);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function bindGroupRework(candidate: GroupCandidate, binding: PlanBinding, rootTicket: string): GroupReworkBinding {
  if (binding.ticket !== rootTicket) throw new Error("group rework plan must belong to the root ticket");
  return Object.freeze({ groupId: candidate.groupId, revisionHash: candidate.revisionHash, candidateHash: candidate.candidateHash, reworkPlanBinding: { ...binding, repositories: [...binding.repositories] } });
}

export function assertGroupRework(current: GroupCandidate, expected: GroupReworkBinding, binding: PlanBinding): void {
  if (current.groupId !== expected.groupId || current.revisionHash !== expected.revisionHash || current.candidateHash !== expected.candidateHash || canonicalJson(expected.reworkPlanBinding) !== canonicalJson(binding)) throw new Error("group rework binding is stale or foreign");
}
