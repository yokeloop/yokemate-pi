import { randomUUID } from "node:crypto";
import { subagentConcurrency, type RuntimeSettings } from "./guard-policy.ts";

export type ListMode = "plan" | "do" | "ship";
export type KeyRunState = "reserved" | "starting" | "active" | "refused" | "recorded" | "done" | "blocked" | "cancelled";
export interface ListRunIdentity { readonly listRunId: string; readonly parentSessionId: string; readonly parentRuntimeId: string; readonly mode: ListMode; readonly keys: readonly string[] }
export interface ListImmediate { state: "accepted" | "refused"; reservation?: "queued" | "ready"; reason?: string; facts?: Record<string, unknown> }
export interface ListTerminal { outcome: "recorded" | "done" | "blocked" | "cancelled"; reason?: string; facts?: Record<string, unknown> }
export interface KeyRunEntry { readonly keyRunId: string; readonly key: string; readonly index: number; state: KeyRunState; immediate?: ListImmediate; terminal?: ListTerminal }
export interface ListRun { readonly identity: ListRunIdentity; readonly settings: RuntimeSettings; readonly entries: KeyRunEntry[]; immediatePublished: boolean; aggregatePublished: boolean }
export interface ListAggregate { listRunId: string; mode: ListMode; results: readonly { keyRunId: string; key: string; index: number; immediate: ListImmediate; terminal?: ListTerminal }[] }
export interface ListAdmission {
  mode: ListMode;
  keys: string[];
  parentSessionId: string;
  parentRuntimeId: string;
  settings: RuntimeSettings;
  externalActiveUnits?: number;
  rejectKey?(key: string, index: number): string | undefined;
  rejectDuplicate?: boolean;
}
export interface KeyRunContext { listRunId: string; keyRunId: string; parentRunId: string; key: string; index: number; mode: ListMode; settings: RuntimeSettings; signal: AbortSignal; active(facts?: Record<string, unknown>): boolean; terminal(value: ListTerminal): boolean }

type Listener = (run: ListRun, entry: KeyRunEntry) => void;

const terminalState = (state: KeyRunState): boolean => ["refused", "recorded", "done", "blocked", "cancelled"].includes(state);
const terminalToState = (outcome: ListTerminal["outcome"]): KeyRunState => outcome;

export class ListRunRegistry {
  private readonly lists = new Map<string, ListRun>();
  private readonly keys = new Map<string, Set<string>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly starts = new Map<string, (context: KeyRunContext) => Promise<ListTerminal | void>>();
  private readonly buffered = new Map<string, ListTerminal>();
  private readonly immediateListeners = new Set<Listener>();
  private readonly terminalListeners = new Set<Listener>();
  private readonly aggregateListeners = new Set<(aggregate: ListAggregate) => void>();
  private running = 0;

  onImmediate(listener: Listener): () => void { this.immediateListeners.add(listener); return () => this.immediateListeners.delete(listener); }
  onTerminal(listener: Listener): () => void { this.terminalListeners.add(listener); return () => this.terminalListeners.delete(listener); }
  onAggregate(listener: (aggregate: ListAggregate) => void): () => void { this.aggregateListeners.add(listener); return () => this.aggregateListeners.delete(listener); }

  admit(input: ListAdmission): ListRun {
    if (!input.keys.length) throw new Error(`${input.mode} list needs at least one key`);
    const identities = input.keys.map((key, index) => ({ keyRunId: randomUUID(), key, index }));
    const identity: ListRunIdentity = Object.freeze({ listRunId: randomUUID(), parentSessionId: input.parentSessionId, parentRuntimeId: input.parentRuntimeId, mode: input.mode, keys: Object.freeze([...input.keys]) });
    const run: ListRun = { identity, settings: input.settings, entries: identities.map((entry) => ({ ...entry, state: "reserved" })), immediatePublished: false, aggregatePublished: false };
    this.lists.set(identity.listRunId, run);
    const duplicateInput = new Set(input.keys).size !== input.keys.length;
    const taskLimit = input.settings.policy.guards.parallelTaskLimit ? input.settings.limits.maxParallelTasks : Number.POSITIVE_INFINITY;
    const detachedAvailable = input.settings.policy.guards.detachedLimit
      ? Math.max(0, input.settings.limits.maxDetached - (input.externalActiveUnits ?? 0) - this.reservedCount(identity.listRunId))
      : Number.POSITIVE_INFINITY;
    let accepted = 0;
    for (const entry of run.entries) {
      let reason: string | undefined;
      if (duplicateInput) reason = "ticket list contains duplicates";
      else reason = input.rejectKey?.(entry.key, entry.index);
      if (!reason && input.rejectDuplicate) {
        const active = [...(this.keys.get(`${input.mode}:${entry.key}`) ?? [])].map((id) => this.entry(id)).find((candidate) => candidate && !terminalState(candidate.state));
        if (active) reason = `${entry.key} already runs as ${active.keyRunId}`;
      }
      if (!reason && accepted >= taskLimit) reason = `Too many parallel tasks (${input.keys.length}). Max is ${input.settings.limits.maxParallelTasks}.`;
      if (!reason && accepted >= detachedAvailable) reason = `Too many detached agents already running (${(input.externalActiveUnits ?? 0) + accepted}/${input.settings.limits.maxDetached}).`;
      if (reason) {
        entry.state = "refused";
        entry.immediate = { state: "refused", reason };
        entry.terminal = { outcome: "blocked", reason };
      } else {
        entry.immediate = { state: "accepted", reservation: accepted < subagentConcurrency(input.settings, input.keys.length) ? "ready" : "queued" };
        (this.keys.get(`${input.mode}:${entry.key}`) ?? this.keys.set(`${input.mode}:${entry.key}`, new Set()).get(`${input.mode}:${entry.key}`)!).add(entry.keyRunId);
        accepted++;
      }
    }
    return run;
  }

  publishImmediate(listRunId: string): ListRun {
    const run = this.requiredList(listRunId);
    if (run.immediatePublished) return run;
    run.immediatePublished = true;
    for (const entry of run.entries) for (const listener of this.immediateListeners) listener(run, entry);
    for (const entry of run.entries) {
      const terminal = this.buffered.get(entry.keyRunId);
      if (terminal) { this.buffered.delete(entry.keyRunId); this.applyTerminal(run, entry, terminal); }
    }
    this.publishAggregate(run);
    this.pump();
    return run;
  }

  start(listRunId: string, start: (context: KeyRunContext) => Promise<ListTerminal | void>): void {
    const run = this.requiredList(listRunId);
    for (const entry of run.entries) if (entry.immediate?.state === "accepted" && !terminalState(entry.state)) this.starts.set(entry.keyRunId, start);
    this.pump();
  }

  markActive(keyRunId: string, facts?: Record<string, unknown>): boolean {
    const found = this.find(keyRunId);
    if (!found || found.entry.state !== "starting") return false;
    found.entry.state = "active";
    found.entry.immediate = { ...found.entry.immediate!, facts: { ...found.entry.immediate?.facts, ...facts } };
    return true;
  }

  settle(listRunId: string, keyRunId: string, terminal: ListTerminal): boolean {
    const run = this.lists.get(listRunId);
    const entry = run?.entries.find((candidate) => candidate.keyRunId === keyRunId);
    if (!run || !entry || terminalState(entry.state)) return false;
    if (!run.immediatePublished) { this.buffered.set(keyRunId, terminal); return true; }
    return this.applyTerminal(run, entry, terminal);
  }

  cancel(id: string, reason = "cancelled"): boolean {
    const list = this.lists.get(id);
    if (list) {
      let changed = false;
      for (const entry of list.entries) changed = this.cancelEntry(list, entry, reason) || changed;
      return changed;
    }
    const found = this.find(id);
    return found ? this.cancelEntry(found.run, found.entry, reason) : false;
  }

  get(id: string): ListRun | { run: ListRun; entry: KeyRunEntry } | undefined { return this.lists.get(id) ?? this.find(id); }
  activeEntries(): KeyRunEntry[] { return [...this.lists.values()].flatMap((run) => run.entries.filter((entry) => !terminalState(entry.state))); }

  aggregate(listRunId: string): ListAggregate | undefined {
    const run = this.lists.get(listRunId);
    if (!run || run.entries.some((entry) => !terminalState(entry.state))) return;
    return { listRunId, mode: run.identity.mode, results: run.entries.map((entry) => ({ keyRunId: entry.keyRunId, key: entry.key, index: entry.index, immediate: entry.immediate!, terminal: entry.terminal })) };
  }

  private pump(): void {
    for (const run of this.lists.values()) {
      if (!run.immediatePublished) continue;
      const limit = subagentConcurrency(run.settings, run.entries.length);
      while (this.running < limit) {
        const entry = run.entries.find((candidate) => candidate.state === "reserved" && this.starts.has(candidate.keyRunId));
        if (!entry) break;
        const start = this.starts.get(entry.keyRunId)!;
        this.starts.delete(entry.keyRunId);
        const controller = new AbortController();
        this.controllers.set(entry.keyRunId, controller);
        entry.state = "starting";
        this.running++;
        const context: KeyRunContext = { listRunId: run.identity.listRunId, keyRunId: entry.keyRunId, parentRunId: run.identity.listRunId, key: entry.key, index: entry.index, mode: run.identity.mode, settings: run.settings, signal: controller.signal, active: (facts) => this.markActive(entry.keyRunId, facts), terminal: (terminal) => this.settle(run.identity.listRunId, entry.keyRunId, terminal) };
        void start(context).then((terminal) => { if (terminal) this.settle(run.identity.listRunId, entry.keyRunId, terminal); }).catch((error) => this.settle(run.identity.listRunId, entry.keyRunId, { outcome: "blocked", reason: error instanceof Error ? error.message : String(error) }));
      }
    }
  }

  private applyTerminal(run: ListRun, entry: KeyRunEntry, terminal: ListTerminal): boolean {
    if (terminalState(entry.state)) return false;
    const occupied = entry.state === "starting" || entry.state === "active";
    entry.state = terminalToState(terminal.outcome);
    entry.terminal = { ...terminal, facts: terminal.facts && { ...terminal.facts } };
    this.controllers.delete(entry.keyRunId);
    if (occupied) this.running = Math.max(0, this.running - 1);
    for (const listener of this.terminalListeners) listener(run, entry);
    this.publishAggregate(run);
    this.pump();
    return true;
  }

  private cancelEntry(run: ListRun, entry: KeyRunEntry, reason: string): boolean {
    if (terminalState(entry.state)) return false;
    this.controllers.get(entry.keyRunId)?.abort(reason);
    this.starts.delete(entry.keyRunId);
    return this.settle(run.identity.listRunId, entry.keyRunId, { outcome: "cancelled", reason });
  }

  private publishAggregate(run: ListRun): void {
    if (!run.immediatePublished || run.aggregatePublished) return;
    const aggregate = this.aggregate(run.identity.listRunId);
    if (!aggregate) return;
    run.aggregatePublished = true;
    for (const listener of this.aggregateListeners) listener(aggregate);
  }

  private reservedCount(exceptListRunId?: string): number { return [...this.lists.values()].filter((run) => run.identity.listRunId !== exceptListRunId).flatMap((run) => run.entries).filter((entry) => entry.immediate?.state === "accepted" && !terminalState(entry.state)).length; }
  private entry(keyRunId: string): KeyRunEntry | undefined { return this.find(keyRunId)?.entry; }
  private find(keyRunId: string): { run: ListRun; entry: KeyRunEntry } | undefined { for (const run of this.lists.values()) { const entry = run.entries.find((candidate) => candidate.keyRunId === keyRunId); if (entry) return { run, entry }; } }
  private requiredList(listRunId: string): ListRun { const run = this.lists.get(listRunId); if (!run) throw new Error(`unknown list run ${listRunId}`); return run; }
}
