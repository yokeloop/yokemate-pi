import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Stage } from "./db.ts";

export const GROUP_PHASES = ["planning", "planned", "running", "review", "accepted", "shipping", "done", "blocked"] as const;
export type GroupPhase = (typeof GROUP_PHASES)[number];
export const GROUP_MEMBER_STAGES = ["new", "scouted", "planned", "running", "review", "accepted", "integrated"] as const;
export type GroupMemberStage = (typeof GROUP_MEMBER_STAGES)[number];
export const GROUP_EXECUTIONS = ["not_started", "queued", "running", "ready", "integrated", "blocked"] as const;
export type GroupExecution = (typeof GROUP_EXECUTIONS)[number];
export type ClaimState = "reserved" | "active" | "suspended";

export interface GroupMemberSeed {
  identity: string;
  ticket: string;
  parentIdentity: string | null;
  planRecordId?: number | null;
  priorState?: unknown;
  stage?: GroupMemberStage;
  execution?: GroupExecution;
  trackerState?: string | null;
}

export interface GroupRevisionInput {
  groupId: string;
  revisionHash: string;
  treeHash: string;
  manifest: unknown;
  bindings: unknown;
  compatibility: unknown;
  approachReceiptId: string;
  members: GroupMemberSeed[];
}

export interface GroupMoveRequest {
  groupId: string;
  revisionHash?: string | null;
  expectedPhase: GroupPhase;
  toPhase: GroupPhase;
  idempotencyKey: string;
  blocker?: string | null;
  resumePhase?: Exclude<GroupPhase, "blocked" | "done"> | null;
}

export type GroupMoveOutcome =
  | { ok: true; repeat: boolean; from: GroupPhase; to: GroupPhase }
  | { ok: false; refuse: string };

export interface GroupClaimOwner {
  runtimeId: string;
  runId: string;
  sessionId: string;
  process?: { pid: number; starttime: string };
}

export interface ExistingMemberClassification {
  kind: "fresh" | "planned_material" | "active_blocker" | "result_candidate" | "reuse_candidate" | "evidence_blocker";
  priorState: Record<string, unknown>;
  blocker?: string;
}

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]));
};

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stable(value));
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function createPlanningGroup(db: DatabaseSync, input: { id?: string; rootIdentity: string; rootTicket: string; ownerProject: string }): string {
  const id = input.id ?? randomUUID();
  db.prepare(`INSERT INTO task_group (id,root_identity,root_ticket,owner_project,phase)
    VALUES (?,?,?,?, 'planning')
    ON CONFLICT(root_identity) DO NOTHING`).run(id, input.rootIdentity, input.rootTicket, input.ownerProject);
  const row = db.prepare("SELECT id,root_ticket,owner_project FROM task_group WHERE root_identity = ?").get(input.rootIdentity) as { id: string; root_ticket: string; owner_project: string };
  if (row.root_ticket !== input.rootTicket || row.owner_project !== input.ownerProject) throw new Error("group root identity is already bound to another target");
  return row.id;
}

export function reserveMemberClaims(db: DatabaseSync, input: { groupId: string; treeHash: string; members: string[]; owners: GroupClaimOwner[]; tickets?: Record<string, string> }): void {
  const members = [...new Set(input.members)].sort();
  if (!members.length || members.some((member) => !member)) throw new Error("group claims require a complete nonempty member set");
  db.exec("BEGIN IMMEDIATE");
  try {
    const owners = canonicalJson(input.owners);
    for (const member of members) {
      const existing = db.prepare("SELECT kind,group_id,state,owners_json FROM member_claim WHERE member_identity = ?").get(member) as { kind: string; group_id: string | null; state: string; owners_json: string } | undefined;
      if (existing && (existing.kind !== "group" || existing.group_id !== input.groupId)) throw new Error(`${member} is claimed by ${existing.kind === "group" ? existing.group_id : "a single run"}`);
      if (existing && existing.owners_json !== owners) throw new Error(`${member} still belongs to another live owner of group ${input.groupId}`);
    }
    for (const member of members) db.prepare(`INSERT INTO member_claim (member_identity,ticket,kind,group_id,tree_hash,owners_json,state)
      VALUES (?, ?, 'group', ?, ?, ?, 'reserved')
      ON CONFLICT(member_identity) DO UPDATE SET ticket=excluded.ticket,tree_hash=excluded.tree_hash,owners_json=excluded.owners_json,state='reserved',updated_at=datetime('now')`).run(member, input.tickets?.[member] ?? member.slice(Math.max(member.lastIndexOf(":"), member.lastIndexOf("#")) + 1), input.groupId, input.treeHash, owners);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function activateGroupRevision(db: DatabaseSync, input: GroupRevisionInput, write?: () => void): void {
  if (!/^[a-f0-9]{64}$/.test(input.revisionHash) || !/^[a-f0-9]{64}$/.test(input.treeHash)) throw new Error("group revision hashes must be SHA-256 values");
  const identities = new Set(input.members.map((member) => member.identity));
  if (identities.size !== input.members.length || input.members.length === 0) throw new Error("group revision members must be unique and nonempty");
  db.exec("BEGIN IMMEDIATE");
  try {
    const group = db.prepare("SELECT phase FROM task_group WHERE id = ?").get(input.groupId) as { phase: GroupPhase } | undefined;
    if (!group) throw new Error("group does not exist");
    if (!["planning", "blocked", "planned"].includes(group.phase)) throw new Error(`group cannot activate from ${group.phase}`);
    for (const member of input.members) {
      const claim = db.prepare("SELECT kind,group_id,tree_hash FROM member_claim WHERE member_identity = ?").get(member.identity) as { kind: string; group_id: string | null; tree_hash: string | null } | undefined;
      if (!claim || claim.kind !== "group" || claim.group_id !== input.groupId || claim.tree_hash !== input.treeHash) throw new Error(`${member.ticket}: group claim is missing or stale`);
    }
    db.prepare(`INSERT INTO group_revision (group_id,revision_hash,tree_hash,manifest_json,bindings_json,compatibility_json,approach_receipt_id)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(group_id,revision_hash) DO NOTHING`).run(input.groupId, input.revisionHash, input.treeHash, canonicalJson(input.manifest), canonicalJson(input.bindings), canonicalJson(input.compatibility), input.approachReceiptId);
    for (const member of input.members) db.prepare(`INSERT INTO group_member
      (group_id,revision_hash,member_identity,ticket,parent_identity,plan_record_id,prior_state_json,stage,execution,tracker_state)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(group_id,revision_hash,member_identity) DO NOTHING`).run(input.groupId, input.revisionHash, member.identity, member.ticket, member.parentIdentity, member.planRecordId ?? null, canonicalJson(member.priorState ?? {}), member.stage ?? "planned", member.execution ?? "not_started", member.trackerState ?? null);
    for (const member of input.members) db.prepare("UPDATE member_claim SET ticket=? WHERE member_identity=? AND group_id=?").run(member.ticket, member.identity, input.groupId);
    db.prepare("UPDATE member_claim SET revision_hash=?,state='active',updated_at=datetime('now') WHERE group_id=? AND tree_hash=?").run(input.revisionHash, input.groupId, input.treeHash);
    db.prepare("UPDATE task_group SET active_revision=?,phase='planned',resume_phase=NULL,blocker=NULL,updated_at=datetime('now') WHERE id=?").run(input.revisionHash, input.groupId);
    write?.();
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function applyGroupMove(db: DatabaseSync, request: GroupMoveRequest, write?: () => void): GroupMoveOutcome {
  if (!request.idempotencyKey) throw new Error("group move idempotency key is required");
  db.exec("BEGIN IMMEDIATE");
  try {
    const prior = db.prepare("SELECT outcome_json FROM group_move WHERE idempotency_key = ?").get(request.idempotencyKey) as { outcome_json: string } | undefined;
    if (prior) {
      const outcome = JSON.parse(prior.outcome_json) as { groupId: string; revisionHash: string | null; from: GroupPhase; to: GroupPhase };
      if (outcome.groupId !== request.groupId || outcome.revisionHash !== (request.revisionHash ?? null) || outcome.to !== request.toPhase) throw new Error("group move idempotency key was reused with different inputs");
      db.exec("ROLLBACK");
      return { ok: true, repeat: true, from: outcome.from, to: outcome.to };
    }
    const row = db.prepare("SELECT active_revision,phase FROM task_group WHERE id = ?").get(request.groupId) as { active_revision: string | null; phase: GroupPhase } | undefined;
    if (!row) { db.exec("ROLLBACK"); return { ok: false, refuse: "group does not exist" }; }
    if (row.phase !== request.expectedPhase) { db.exec("ROLLBACK"); return { ok: false, refuse: `group changed from ${request.expectedPhase} to ${row.phase}` }; }
    if (request.revisionHash !== undefined && row.active_revision !== request.revisionHash) { db.exec("ROLLBACK"); return { ok: false, refuse: `group revision changed from ${request.revisionHash ?? "none"} to ${row.active_revision ?? "none"}` }; }
    write?.();
    const resume = request.toPhase === "blocked" ? request.resumePhase ?? request.expectedPhase : null;
    db.prepare("UPDATE task_group SET phase=?,resume_phase=?,blocker=?,updated_at=datetime('now') WHERE id=?").run(request.toPhase, resume, request.blocker ?? null, request.groupId);
    const outcome = { groupId: request.groupId, revisionHash: request.revisionHash ?? null, from: row.phase, to: request.toPhase };
    db.prepare("INSERT INTO group_move (idempotency_key,group_id,revision_hash,from_phase,to_phase,outcome_json) VALUES (?,?,?,?,?,?)").run(request.idempotencyKey, request.groupId, request.revisionHash ?? null, row.phase, request.toPhase, canonicalJson(outcome));
    if (request.toPhase === "done") db.prepare("DELETE FROM member_claim WHERE group_id=? AND revision_hash=?").run(request.groupId, row.active_revision);
    if (request.toPhase === "blocked") db.prepare("UPDATE member_claim SET state='suspended',updated_at=datetime('now') WHERE group_id=? AND revision_hash=?").run(request.groupId, row.active_revision);
    db.exec("COMMIT");
    return { ok: true, repeat: false, from: row.phase, to: request.toPhase };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function recordGroupEffect(db: DatabaseSync, effect: { key: string; groupId: string; revisionHash: string; type: "integrate" | "ship" | "to_verify" | "done" | "cleanup"; scope: unknown; input: unknown; state: "intent" | "unknown" | "confirmed" | "failed"; outcome?: unknown }): { repeat: boolean; state: string } {
  const existing = db.prepare("SELECT group_id,revision_hash,type,input_json,state FROM group_effect WHERE effect_key=?").get(effect.key) as { group_id: string; revision_hash: string; type: string; input_json: string; state: string } | undefined;
  const inputJson = canonicalJson(effect.input);
  if (existing) {
    if (existing.group_id !== effect.groupId || existing.revision_hash !== effect.revisionHash || existing.type !== effect.type || existing.input_json !== inputJson) throw new Error("group effect key was reused with different inputs");
    return { repeat: true, state: existing.state };
  }
  db.prepare(`INSERT INTO group_effect (effect_key,group_id,revision_hash,scope_json,type,input_json,state,outcome_json)
    VALUES (?,?,?,?,?,?,?,?)`).run(effect.key, effect.groupId, effect.revisionHash, canonicalJson(effect.scope), effect.type, inputJson, effect.state, effect.outcome === undefined ? null : canonicalJson(effect.outcome));
  return { repeat: false, state: effect.state };
}

export function confirmGroupEffect(db: DatabaseSync, key: string, state: "unknown" | "confirmed" | "failed", outcome: unknown): void {
  const changed = db.prepare("UPDATE group_effect SET state=?,outcome_json=?,updated_at=datetime('now') WHERE effect_key=? AND state!='confirmed'").run(state, canonicalJson(outcome), key);
  if (changed.changes === 0) {
    const row = db.prepare("SELECT state,outcome_json FROM group_effect WHERE effect_key=?").get(key) as { state: string; outcome_json: string | null } | undefined;
    if (!row) throw new Error("group effect does not exist");
    if (row.state !== "confirmed" || row.outcome_json !== canonicalJson(outcome)) throw new Error("confirmed group effect is immutable");
  }
}

export function classifyExistingMember(db: DatabaseSync, ticket: string, trackerState = "open"): ExistingMemberClassification {
  const row = db.prepare("SELECT id,stage,plan,pr FROM work WHERE ticket=?").get(ticket) as { id: number; stage: Stage; plan: string | null; pr: string | null } | undefined;
  const claim = db.prepare("SELECT kind,group_id,revision_hash,state FROM member_claim WHERE ticket=? LIMIT 1").get(ticket) as { kind: string; group_id: string | null; revision_hash: string | null; state: string } | undefined;
  const closed = ["closed", "resolved", "done", "merged"].includes(trackerState.toLowerCase());
  const priorState = { ...(row ?? {}), trackerState, ...(claim ? { claim } : {}) };
  if (["reserved", "active", "suspended"].includes(claim?.state ?? "")) return { kind: "active_blocker", priorState, blocker: `${ticket} has an active ${claim!.kind} owner` };
  if (!row) return closed ? { kind: "evidence_blocker", priorState, blocker: `${ticket} is closed without preserved merge evidence` } : { kind: "fresh", priorState };
  if (row.stage === "planned") return closed ? { kind: "evidence_blocker", priorState, blocker: `${ticket} is closed but only planned material is preserved` } : { kind: "planned_material", priorState };
  if (row.stage === "running") return { kind: "active_blocker", priorState, blocker: `${ticket} has an active single run` };
  if ((row.stage === "review" || row.stage === "accepted") && row.pr) return { kind: closed ? "reuse_candidate" : "result_candidate", priorState };
  if (row.stage === "accepted" || closed) return { kind: "evidence_blocker", priorState, blocker: `${ticket} has no preserved PR evidence for reuse` };
  return { kind: "fresh", priorState };
}

export function groupClaimForTicket(db: DatabaseSync, ticket: string): { groupId: string; revisionHash: string | null; memberIdentity: string; state: ClaimState } | null {
  const row = db.prepare(`SELECT group_id,revision_hash,member_identity,state FROM member_claim
    WHERE kind='group' AND ticket=? AND state IN ('reserved','active','suspended') LIMIT 1`).get(ticket) as { group_id: string; revision_hash: string | null; member_identity: string; state: ClaimState } | undefined;
  return row ? { groupId: row.group_id, revisionHash: row.revision_hash, memberIdentity: row.member_identity, state: row.state } : null;
}

export interface GroupFactsSnapshot {
  version: 1;
  groupId: string;
  revisionHash: string;
  sequence: number;
  group: Record<string, unknown>;
  members: Record<string, unknown>[];
  repositories: Record<string, unknown>[];
  parts: Record<string, unknown>[];
  acceptances: Record<string, unknown>[];
  reworks: Record<string, unknown>[];
  confirmedEffects: Record<string, unknown>[];
  hash: string;
}

export function readGroupFactsSnapshot(path: string): GroupFactsSnapshot {
  const value = JSON.parse(readFileSync(path, "utf8")) as GroupFactsSnapshot;
  if (value.version !== 1 || !value.groupId || !/^[a-f0-9]{64}$/.test(value.revisionHash) || !Number.isInteger(value.sequence) || value.sequence < 1 || !Array.isArray(value.members) || !Array.isArray(value.repositories) || !Array.isArray(value.parts) || !Array.isArray(value.acceptances) || !Array.isArray(value.reworks) || !Array.isArray(value.confirmedEffects) || !/^[a-f0-9]{64}$/.test(value.hash)) throw new Error("group facts snapshot is invalid");
  const { hash, ...payload } = value;
  if (canonicalHash(payload) !== hash) throw new Error("group facts snapshot hash mismatch");
  return value;
}

export function restoreGroupFacts(db: DatabaseSync, path: string, verify: (facts: GroupFactsSnapshot) => boolean): { restored: boolean; blocker?: string } {
  const facts = readGroupFactsSnapshot(path);
  if (!verify(facts)) throw new Error("group facts snapshot external facts are not verified");
  const group = db.prepare("SELECT active_revision,phase FROM task_group WHERE id=?").get(facts.groupId) as { active_revision: string | null; phase: string } | undefined;
  if (!group) throw new Error("group manifest and revision must be restored before facts");
  if (group.active_revision !== facts.revisionHash) {
    const blocker = `facts revision ${facts.revisionHash} conflicts with durable revision ${group.active_revision ?? "none"}`;
    db.prepare("UPDATE task_group SET phase='blocked',resume_phase=CASE WHEN phase='blocked' THEN resume_phase ELSE phase END,blocker=?,updated_at=datetime('now') WHERE id=?").run(blocker, facts.groupId);
    return { restored: false, blocker };
  }
  const required = (record: Record<string, unknown>, key: string): string => {
    const value = record[key];
    if (typeof value !== "string") throw new Error(`group facts field ${key} is invalid`);
    return value;
  };
  const nullable = (record: Record<string, unknown>, key: string): string | null => record[key] === null || record[key] === undefined ? null : required(record, key);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const member of facts.members) db.prepare(`UPDATE group_member SET stage=?,execution=?,blocker=?,result_json=?,tracker_state=?,updated_at=datetime('now')
      WHERE group_id=? AND revision_hash=? AND member_identity=?`).run(required(member, "stage"), required(member, "execution"), nullable(member, "blocker"), nullable(member, "result_json"), nullable(member, "tracker_state"), facts.groupId, facts.revisionHash, required(member, "member_identity"));
    for (const repository of facts.repositories) db.prepare(`UPDATE group_repository SET final_pr=?,head_sha=?,merge_commit=?,ship_state=?
      WHERE group_id=? AND revision_hash=? AND repo=?`).run(nullable(repository, "final_pr"), nullable(repository, "head_sha"), nullable(repository, "merge_commit"), required(repository, "ship_state"), facts.groupId, facts.revisionHash, required(repository, "repo"));
    for (const part of facts.parts) db.prepare(`UPDATE group_part SET pr_identity=?,head_sha=?,base_sha=?,readiness_json=?,reviewer_json=?,merge_commit=?,outcome=?
      WHERE group_id=? AND revision_hash=? AND member_identity=? AND repo=?`).run(nullable(part, "pr_identity"), nullable(part, "head_sha"), nullable(part, "base_sha"), nullable(part, "readiness_json"), nullable(part, "reviewer_json"), nullable(part, "merge_commit"), nullable(part, "outcome"), facts.groupId, facts.revisionHash, required(part, "member_identity"), required(part, "repo"));
    for (const acceptance of facts.acceptances) db.prepare(`INSERT INTO group_acceptance (group_id,revision_hash,candidate_hash,candidate_json,evidence_json,review_source_json,state,created_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(group_id,revision_hash,candidate_hash) DO NOTHING`).run(facts.groupId, facts.revisionHash, required(acceptance, "candidate_hash"), required(acceptance, "candidate_json"), required(acceptance, "evidence_json"), required(acceptance, "review_source_json"), required(acceptance, "state"), required(acceptance, "created_at"));
    for (const rework of facts.reworks) db.prepare(`INSERT INTO group_rework (group_id,revision_hash,candidate_hash,plan_binding_json,reviewer_json,state,review_source_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(group_id,revision_hash,candidate_hash) DO NOTHING`).run(facts.groupId, facts.revisionHash, required(rework, "candidate_hash"), required(rework, "plan_binding_json"), nullable(rework, "reviewer_json"), required(rework, "state"), required(rework, "review_source_json"), required(rework, "created_at"), required(rework, "updated_at"));
    for (const effect of facts.confirmedEffects) {
      if (effect.state !== "confirmed") throw new Error("portable facts may contain only confirmed effects");
      db.prepare(`INSERT INTO group_effect (effect_key,group_id,revision_hash,scope_json,type,input_json,state,outcome_json,updated_at)
        VALUES (?,?,?,?,?,?,'confirmed',?,?) ON CONFLICT(effect_key) DO NOTHING`).run(required(effect, "effect_key"), facts.groupId, facts.revisionHash, required(effect, "scope_json"), required(effect, "type"), required(effect, "input_json"), nullable(effect, "outcome_json"), required(effect, "updated_at"));
    }
    const phase = required(facts.group, "phase");
    if (!GROUP_PHASES.includes(phase as GroupPhase)) throw new Error("group facts phase is invalid");
    db.prepare("UPDATE task_group SET phase=?,resume_phase=?,blocker=?,updated_at=datetime('now') WHERE id=? AND active_revision=?").run(phase, nullable(facts.group, "resume_phase"), nullable(facts.group, "blocker"), facts.groupId, facts.revisionHash);
    db.exec("COMMIT");
    return { restored: true };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function snapshotGroupFacts(db: DatabaseSync, groupId: string, path: string): { hash: string; sequence: number } {
  const group = db.prepare("SELECT * FROM task_group WHERE id=?").get(groupId) as Record<string, unknown> | undefined;
  if (!group || typeof group.active_revision !== "string") throw new Error("active group revision is required for a facts snapshot");
  const revisionHash = group.active_revision;
  const members = db.prepare("SELECT * FROM group_member WHERE group_id=? AND revision_hash=? ORDER BY member_identity").all(groupId, revisionHash);
  const repositories = db.prepare("SELECT * FROM group_repository WHERE group_id=? AND revision_hash=? ORDER BY repo").all(groupId, revisionHash);
  const parts = db.prepare("SELECT * FROM group_part WHERE group_id=? AND revision_hash=? ORDER BY member_identity,repo").all(groupId, revisionHash);
  const acceptances = db.prepare("SELECT * FROM group_acceptance WHERE group_id=? AND revision_hash=? ORDER BY candidate_hash").all(groupId, revisionHash);
  const reworks = db.prepare("SELECT * FROM group_rework WHERE group_id=? AND revision_hash=? ORDER BY candidate_hash").all(groupId, revisionHash);
  const effects = db.prepare("SELECT * FROM group_effect WHERE group_id=? AND revision_hash=? AND state='confirmed' ORDER BY effect_key").all(groupId, revisionHash);
  let sequence = 1;
  try { sequence = Number((JSON.parse(readFileSync(path, "utf8")) as { sequence?: number }).sequence ?? 0) + 1; } catch {}
  const payload = { version: 1, groupId, revisionHash, sequence, group, members, repositories, parts, acceptances, reworks, confirmedEffects: effects };
  const hash = canonicalHash(payload);
  const document = `${JSON.stringify({ ...payload, hash }, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(temporary, document, { mode: 0o600 });
  renameSync(temporary, path);
  return { hash, sequence };
}

export function groupFactsPath(root: string, db: DatabaseSync, groupId: string): string {
  const group = db.prepare("SELECT root_ticket,owner_project FROM task_group WHERE id=?").get(groupId) as { root_ticket: string; owner_project: string } | undefined;
  if (!group || !/^[A-Z][A-Z0-9]*-\d+$/.test(group.root_ticket) || !/^[^/]+\/[^/]+$/.test(group.owner_project)) throw new Error("group facts owner is invalid");
  const [org, repo] = group.owner_project.split("/");
  return join(root, "home", "knowledge", org!, repo!, "ai", `${group.root_ticket.toLowerCase()}-group`, `${group.root_ticket}-group-facts.json`);
}

export function persistGroupFacts(root: string, db: DatabaseSync, groupId: string): { path: string; hash: string; sequence: number } {
  const path = groupFactsPath(root, db, groupId);
  return { path, ...snapshotGroupFacts(db, groupId, path) };
}

export function restorePersistedGroupFacts(root: string, db: DatabaseSync, groupId: string, verify: (facts: GroupFactsSnapshot) => boolean): { restored: boolean; blocker?: string } | null {
  const path = groupFactsPath(root, db, groupId);
  return existsSync(path) ? restoreGroupFacts(db, path, verify) : null;
}
