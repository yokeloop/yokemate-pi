import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { GroupExecutionManifest } from "./group-plan.ts";
import { applyGroupMove } from "./group-state.ts";

export interface GroupMemberLaunch { runId: string; cancel(): Promise<void> | void }
export interface GroupDelegateRequest { groupId: string; revisionHash: string; root: string; member: string }
export interface GroupRuntimeDeps {
  capacity(): number;
  delegate(request: GroupDelegateRequest): Promise<GroupMemberLaunch>;
  onChange?(): void;
}
export interface GroupRuntimeSnapshot {
  cycleId: string;
  state: "active" | "stopping" | "blocked" | "complete";
  active: { member: string; runId: string }[];
  queued: string[];
  blocked: string[];
}

interface ActiveMember { launch?: GroupMemberLaunch; generation: number }

export class GroupRuntime {
  readonly cycleId = randomUUID();
  readonly groupId: string;
  readonly revisionHash: string;
  readonly root: string;
  private readonly db: DatabaseSync;
  private readonly manifest: GroupExecutionManifest;
  private readonly deps: GroupRuntimeDeps;
  private readonly active = new Map<string, ActiveMember>();
  private readonly approvedContracts = new Set<string>();
  private generation = 0;
  private state: GroupRuntimeSnapshot["state"] = "active";
  private pumping = false;
  private pumpAgain = false;

  constructor(db: DatabaseSync, groupId: string, revisionHash: string, manifest: GroupExecutionManifest, deps: GroupRuntimeDeps) {
    this.db = db;
    this.groupId = groupId;
    this.revisionHash = revisionHash;
    this.root = manifest.root;
    this.manifest = manifest;
    this.deps = deps;
  }

  start(): void {
    const group = this.db.prepare("SELECT active_revision,phase FROM task_group WHERE id=?").get(this.groupId) as { active_revision: string; phase: string } | undefined;
    if (!group || group.active_revision !== this.revisionHash || !["planned", "running", "blocked"].includes(group.phase)) throw new Error("group runtime requires an active executable revision");
    const uncertain = this.db.prepare("SELECT COUNT(*) count FROM group_effect WHERE group_id=? AND revision_hash=? AND state IN ('intent','unknown')").get(this.groupId, this.revisionHash) as { count: number };
    if (uncertain.count) throw new Error("group runtime cannot resume with unreconciled external effects");
    const members = this.db.prepare("SELECT ticket,execution FROM group_member WHERE group_id=? AND revision_hash=?").all(this.groupId, this.revisionHash) as unknown as { ticket: string; execution: string }[];
    if (members.length !== this.manifest.members.length || this.manifest.members.some((member) => !members.some((row) => row.ticket === member.ticket))) throw new Error("group runtime membership does not match the manifest");
    if (group.phase === "planned") {
      const moved = applyGroupMove(this.db, { groupId: this.groupId, revisionHash: this.revisionHash, expectedPhase: "planned", toPhase: "running", idempotencyKey: `group-do:${this.cycleId}` }, () => {
        this.db.prepare("UPDATE group_member SET execution='queued',blocker=NULL,updated_at=datetime('now') WHERE group_id=? AND revision_hash=? AND execution='not_started'").run(this.groupId, this.revisionHash);
      });
      if (!moved.ok) throw new Error(moved.refuse);
    } else {
      if (group.phase === "blocked") {
        const moved = applyGroupMove(this.db, { groupId: this.groupId, revisionHash: this.revisionHash, expectedPhase: "blocked", toPhase: "running", idempotencyKey: `group-resume:${this.cycleId}` });
        if (!moved.ok) throw new Error(moved.refuse);
      }
      this.db.prepare("UPDATE group_member SET execution='queued',blocker=NULL,updated_at=datetime('now') WHERE group_id=? AND revision_hash=? AND execution IN ('running','blocked')").run(this.groupId, this.revisionHash);
      this.db.prepare("UPDATE member_claim SET state='active',updated_at=datetime('now') WHERE group_id=? AND revision_hash=?").run(this.groupId, this.revisionHash);
    }
    const integrated = this.db.prepare("SELECT COUNT(*) count FROM group_member WHERE group_id=? AND revision_hash=? AND execution!='integrated'").get(this.groupId, this.revisionHash) as { count: number };
    const trackerPending = this.db.prepare(`SELECT COUNT(*) count FROM group_member m WHERE m.group_id=? AND m.revision_hash=? AND m.execution='integrated' AND NOT EXISTS (
      SELECT 1 FROM group_effect e WHERE e.effect_key='to-verify:' || m.group_id || ':' || m.revision_hash || ':' || m.ticket AND e.state='confirmed'
    )`).get(this.groupId, this.revisionHash) as { count: number };
    if (integrated.count === 0 && trackerPending.count === 0) {
      const moved = applyGroupMove(this.db, { groupId: this.groupId, revisionHash: this.revisionHash, expectedPhase: "running", toPhase: "review", idempotencyKey: `group-review:${this.cycleId}` });
      if (!moved.ok) throw new Error(moved.refuse);
      this.state = "complete";
      this.deps.onChange?.();
      return;
    }
    this.pump();
  }

  pump(): void {
    if (this.state !== "active") return;
    if (this.pumping) { this.pumpAgain = true; return; }
    this.pumping = true;
    const run = async (): Promise<void> => {
      do {
        this.pumpAgain = false;
        const capacity = Math.max(0, this.deps.capacity() - this.active.size);
        if (capacity === 0) continue;
        const ready = this.manifest.members.filter((member) => this.execution(member.ticket) === "queued" && this.dependenciesSatisfied(member.ticket)).slice(0, capacity);
        for (const member of ready) this.delegateMember(member.ticket);
      } while (this.pumpAgain && this.state === "active");
    };
    void run().finally(() => { this.pumping = false; if (this.pumpAgain && this.state === "active") this.pump(); });
  }

  delegateMember(member: string): void {
    if (this.state !== "active" || this.active.has(member) || this.execution(member) !== "queued" || !this.dependenciesSatisfied(member)) return;
    const generation = this.generation;
    this.active.set(member, { generation });
    this.db.prepare("UPDATE group_member SET execution='running',stage='running',updated_at=datetime('now') WHERE group_id=? AND revision_hash=? AND ticket=? AND execution='queued'").run(this.groupId, this.revisionHash, member);
    void this.deps.delegate({ groupId: this.groupId, revisionHash: this.revisionHash, root: this.root, member }).then((launch) => {
      const active = this.active.get(member);
      if (!active || active.generation !== generation || this.state !== "active") { void launch.cancel(); return; }
      active.launch = launch;
      this.deps.onChange?.();
    }, (error) => {
      const reason = error instanceof Error ? error.message : String(error);
      if (/capacity|concurrent/i.test(reason)) this.memberDeferred(member, generation);
      else this.memberBlocked(member, reason, generation);
    });
  }

  memberReady(member: string, result: unknown): void {
    if (this.state !== "active" || !this.active.has(member)) throw new Error("group member result is not owned by the active cycle");
    this.active.delete(member);
    this.db.prepare("UPDATE group_member SET execution='ready',stage='review',result_json=?,blocker=NULL,updated_at=datetime('now') WHERE group_id=? AND revision_hash=? AND ticket=? AND execution='running'").run(JSON.stringify(result), this.groupId, this.revisionHash, member);
    this.deps.onChange?.();
    this.pump();
  }

  memberIntegrated(member: string): void {
    if (this.state !== "active" || this.execution(member) !== "ready") throw new Error("group member is not ready for integration");
    this.db.prepare("UPDATE group_member SET execution='integrated',stage='integrated',blocker=NULL,updated_at=datetime('now') WHERE group_id=? AND revision_hash=? AND ticket=?").run(this.groupId, this.revisionHash, member);
    this.integrationObserved(member);
  }

  integrationObserved(member: string): void {
    if (this.state !== "active" || this.execution(member) !== "integrated") throw new Error("group member has no confirmed integration result");
    this.deps.onChange?.();
    if (this.manifest.members.every((candidate) => this.execution(candidate.ticket) === "integrated")) {
      const moved = applyGroupMove(this.db, { groupId: this.groupId, revisionHash: this.revisionHash, expectedPhase: "running", toPhase: "review", idempotencyKey: `group-review:${this.cycleId}` });
      if (!moved.ok) throw new Error(moved.refuse);
      this.state = "complete";
    } else this.pump();
  }

  contractApproved(contractId: string): void {
    if (!this.manifest.contracts.some((contract) => contract.id === contractId)) throw new Error("unknown group contract");
    this.approvedContracts.add(contractId);
    this.pump();
  }

  memberDeferred(member: string, generation = this.generation): void {
    const active = this.active.get(member);
    if (!active || active.generation !== generation) return;
    this.active.delete(member);
    this.db.prepare("UPDATE group_member SET execution='queued',stage='planned',blocker=NULL,updated_at=datetime('now') WHERE group_id=? AND revision_hash=? AND ticket=? AND execution='running'").run(this.groupId, this.revisionHash, member);
    this.deps.onChange?.();
  }

  memberBlocked(member: string, reason: string, generation = this.generation): void {
    const active = this.active.get(member);
    if (active && active.generation !== generation) return;
    this.active.delete(member);
    this.db.prepare("UPDATE group_member SET execution='blocked',blocker=?,updated_at=datetime('now') WHERE group_id=? AND revision_hash=? AND ticket=?").run(reason, this.groupId, this.revisionHash, member);
    for (const dependent of this.transitiveDependents(member)) if (this.execution(dependent) === "queued") this.db.prepare("UPDATE group_member SET blocker=?,updated_at=datetime('now') WHERE group_id=? AND revision_hash=? AND ticket=?").run(`waiting on blocked ${member}`, this.groupId, this.revisionHash, dependent);
    this.deps.onChange?.();
    this.pump();
  }

  async stop(reason: string): Promise<void> {
    if (this.state !== "active") return;
    this.state = "stopping";
    this.generation++;
    const launches = [...this.active.values()].map((value) => value.launch).filter((value): value is GroupMemberLaunch => Boolean(value));
    this.active.clear();
    this.db.prepare("UPDATE group_member SET execution='blocked',blocker=?,updated_at=datetime('now') WHERE group_id=? AND revision_hash=? AND execution='running'").run(reason, this.groupId, this.revisionHash);
    const moved = applyGroupMove(this.db, { groupId: this.groupId, revisionHash: this.revisionHash, expectedPhase: "running", toPhase: "blocked", resumePhase: "running", blocker: reason, idempotencyKey: `group-stop:${this.cycleId}` });
    if (!moved.ok) throw new Error(moved.refuse);
    await Promise.allSettled(launches.map((launch) => launch.cancel()));
    this.state = "blocked";
    this.deps.onChange?.();
  }

  snapshot(): GroupRuntimeSnapshot {
    const rows = this.db.prepare("SELECT ticket,execution FROM group_member WHERE group_id=? AND revision_hash=? ORDER BY rowid").all(this.groupId, this.revisionHash) as unknown as { ticket: string; execution: string }[];
    return { cycleId: this.cycleId, state: this.state, active: [...this.active].flatMap(([member, value]) => value.launch ? [{ member, runId: value.launch.runId }] : []), queued: rows.filter((row) => row.execution === "queued").map((row) => row.ticket), blocked: rows.filter((row) => row.execution === "blocked").map((row) => row.ticket) };
  }

  private execution(member: string): string {
    const row = this.db.prepare("SELECT execution FROM group_member WHERE group_id=? AND revision_hash=? AND ticket=?").get(this.groupId, this.revisionHash, member) as { execution: string } | undefined;
    if (!row) throw new Error(`${member}: group member is not registered`);
    return row.execution;
  }

  private dependenciesSatisfied(member: string): boolean {
    return this.manifest.startDependencies.filter((dependency) => dependency.after === member).every((dependency) => dependency.when === "integrated" ? this.execution(dependency.before) === "integrated" : Boolean(dependency.contractId && this.approvedContracts.has(dependency.contractId)));
  }

  private transitiveDependents(member: string): string[] {
    const out = new Set<string>();
    const queue = [member];
    while (queue.length) {
      const current = queue.shift()!;
      for (const edge of this.manifest.startDependencies.filter((dependency) => dependency.before === current)) if (!out.has(edge.after)) { out.add(edge.after); queue.push(edge.after); }
    }
    return [...out];
  }
}

export function startGroupDo(db: DatabaseSync, groupId: string, revisionHash: string, manifest: GroupExecutionManifest, deps: GroupRuntimeDeps): GroupRuntime {
  const runtime = new GroupRuntime(db, groupId, revisionHash, manifest, deps);
  runtime.start();
  return runtime;
}

export const pumpGroup = (runtime: GroupRuntime): void => runtime.pump();
export const delegateMember = (runtime: GroupRuntime, member: string): void => runtime.delegateMember(member);
export const stopGroup = (runtime: GroupRuntime, reason: string): Promise<void> => runtime.stop(reason);
