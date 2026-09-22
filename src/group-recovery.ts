import type { DatabaseSync } from "node:sqlite";
import { confirmGroupEffect } from "./group-state.ts";

interface EffectRow { effect_key: string; type: string; scope_json: string; input_json: string }
export interface IntegrationObservation { state: string; headRefOid: string; baseRefName: string; mergeCommit?: { oid?: string } }
export interface GroupRecoveryDeps {
  observeIntegration(input: { member: string; repo: string; pr: string }): Promise<IntegrationObservation>;
  trackerToVerify(ticket: string): Promise<void>;
}

export async function reconcileGroupEffects(db: DatabaseSync, input: { groupId: string; revisionHash: string }, deps: GroupRecoveryDeps): Promise<void> {
  const effects = db.prepare("SELECT effect_key,type,scope_json,input_json FROM group_effect WHERE group_id=? AND revision_hash=? AND state IN ('intent','unknown') ORDER BY effect_key").all(input.groupId, input.revisionHash) as unknown as EffectRow[];
  for (const effect of effects) {
    if (effect.type === "to_verify") {
      const scope = JSON.parse(effect.scope_json) as { ticket?: string };
      if (!scope.ticket) throw new Error(`${effect.effect_key}: tracker effect scope is incomplete`);
      await deps.trackerToVerify(scope.ticket);
      confirmGroupEffect(db, effect.effect_key, "confirmed", { state: "To Verify" });
      continue;
    }
    if (effect.type !== "integrate") throw new Error(`${effect.effect_key}: group execution effect ${effect.type} requires its owning mode`);
    const scope = JSON.parse(effect.scope_json) as { member?: string; repo?: string; pr?: string };
    const expected = JSON.parse(effect.input_json) as { head?: string; target?: string };
    if (!scope.member || !scope.repo || !scope.pr || !expected.head || !expected.target) throw new Error(`${effect.effect_key}: integration effect facts are incomplete`);
    const observed = await deps.observeIntegration({ member: scope.member, repo: scope.repo, pr: scope.pr });
    if (observed.headRefOid !== expected.head || observed.baseRefName !== expected.target) throw new Error(`${effect.effect_key}: integration identity changed during recovery`);
    if (observed.state === "OPEN") {
      confirmGroupEffect(db, effect.effect_key, "failed", { state: "OPEN", head: observed.headRefOid, target: observed.baseRefName });
      continue;
    }
    const mergeCommit = observed.mergeCommit?.oid;
    if (observed.state !== "MERGED" || !mergeCommit || !/^[0-9a-f]{40}$/.test(mergeCommit)) throw new Error(`${effect.effect_key}: integration outcome remains uncertain`);
    db.exec("BEGIN IMMEDIATE");
    try {
      confirmGroupEffect(db, effect.effect_key, "confirmed", { pr: scope.pr, head: expected.head, target: expected.target, mergeCommit });
      db.prepare("UPDATE group_part SET merge_commit=?,outcome='merged' WHERE group_id=? AND revision_hash=? AND member_identity=? AND repo=?").run(mergeCommit, input.groupId, input.revisionHash, scope.member, scope.repo);
      const remaining = db.prepare("SELECT COUNT(*) count FROM group_part WHERE group_id=? AND revision_hash=? AND member_identity=? AND COALESCE(outcome,'')!='merged'").get(input.groupId, input.revisionHash, scope.member) as { count: number };
      if (remaining.count === 0) db.prepare("UPDATE group_member SET execution='integrated',stage='integrated',updated_at=datetime('now') WHERE group_id=? AND revision_hash=? AND member_identity=?").run(input.groupId, input.revisionHash, scope.member);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
}
