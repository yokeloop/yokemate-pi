import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { currentControlOrigin, requestPlanControl, resolveCoordinatorParent } from "./coordinator-control.ts";
import { readRuntimeSettings } from "./guard-policy.ts";
import { dataRoot } from "./data-root.ts";
import { openDb } from "./db.ts";
import { syncPush } from "./git-sync.ts";
import { logMove } from "./move-log.ts";
import { ticketUrl } from "./ticket-url.ts";
import { applyMove, checkMove, type From, type MoveEnv } from "./transitions.ts";
import { assertPlanBinding, readCandidatePlanSnapshot } from "./plan-binding.ts";
import { markPublicationResult, markSideEffectsStarted, markSuccessfulRecord, planRecordById, publicationById } from "./plan-publication-state.ts";
import { recordPlan } from "./plan-record.ts";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DATA = dataRoot(ROOT);
const fail = (message: string): never => { console.error(message); process.exit(1); };
const argv = process.argv.slice(2).filter((argument) => argument !== "--");
const ticket = argv[0] ?? fail("usage: plan <TICKET> <path-to-plan.md>");
const planPath = resolve(argv[1] ?? fail("usage: plan <TICKET> <path-to-plan.md>"));
if (!existsSync(planPath)) fail(`plan not found: ${planPath}`);

if (process.env.YOKEMATE_PLAN_RUN_ID) {
  try {
    const reply = await requestPlanControl(ROOT, "record-plan", { ticket, path: planPath, runId: process.env.YOKEMATE_PLAN_RUN_ID }, currentControlOrigin(ROOT), resolveCoordinatorParent(ROOT));
    if (reply.state !== "accepted") fail(reply.reason ?? "plan record refused");
    console.log(`${ticket} → planned, plan: ${planPath}`);
    console.log(`${ticket}: ${reply.runId && reply.runId !== process.env.YOKEMATE_PLAN_RUN_ID ? `background run ${reply.runId}` : reply.reason ?? "plan-only; ready for /do"}`);
  } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
} else {
  const settings = readRuntimeSettings(ROOT);
  const preflightDb = openDb(join(ROOT, "yokemate.db"));
  const preflightRow = preflightDb.prepare("SELECT stage FROM work WHERE ticket=?").get(ticket) as { stage: From } | undefined;
  preflightDb.close();
  const preflightMove = checkMove("plan", process.env as MoveEnv, ticket, preflightRow?.stage ?? "absent", { settings });
  if (!preflightMove.ok) fail(preflightMove.refuse);
  let candidate;
  try { candidate = readCandidatePlanSnapshot(ROOT, ticket, planPath); }
  catch (error) { fail((error as Error).message); }
  let prepared;
  try {
    const reply = await requestPlanControl(ROOT, "prepare-plan-publication", { ticket, path: candidate.path, contentHash: candidate.contentHash }, currentControlOrigin(ROOT), resolveCoordinatorParent(ROOT));
    if (reply.state !== "accepted" || !reply.publicationId || !reply.recordId || !reply.snapshotPath || !reply.scoutPublication || !reply.target || !reply.revision) fail(reply.reason ?? `${ticket}: plan publication preparation refused`);
    prepared = { publicationId: reply.publicationId, recordId: reply.recordId, snapshotPath: reply.snapshotPath, scoutPublication: reply.scoutPublication, target: reply.target, revision: reply.revision };
  } catch (error) { fail(`${ticket}: publication pending: ${(error as Error).message}`); }

  let afterNetwork;
  try { afterNetwork = readCandidatePlanSnapshot(ROOT, ticket, candidate.path); assertPlanBinding(candidate, afterNetwork); }
  catch { fail(`${ticket}: publication pending in ${prepared.target}: binding_changed`); }

  const db = openDb(join(ROOT, "yokemate.db"));
  const publication = publicationById(db, prepared.publicationId);
  const record = planRecordById(db, prepared.recordId);
  if (!publication || publication.content_hash !== candidate.contentHash || !record || record.ticket !== ticket || record.publication_id !== publication.id || record.plan_path !== candidate.path || record.content_hash !== candidate.contentHash || record.scope_hash !== candidate.scopeHash || record.scout_publication !== prepared.scoutPublication) fail(`${ticket}: publication pending in ${prepared.target}: binding_changed`);
  const out = applyMove(db, "plan", process.env as MoveEnv, ticket, () => {
    db.prepare(`INSERT INTO work (ticket, url, stage, plan, next) VALUES (?, ?, 'planned', ?, ?) ON CONFLICT (ticket) DO UPDATE SET stage = 'planned', plan = excluded.plan, next = excluded.next, updated_at = datetime('now')`).run(ticket, ticketUrl(db, ticket), candidate.path, `plan publication pending: ${publication.target} plan unavailable`);
    markSuccessfulRecord(db, record.id);
  }, { settings });
  if (!out.ok) { db.close(); fail(out.refuse); }
  const sideEffects = markSideEffectsStarted(db, record.id);
  db.close();

  if (sideEffects) {
    logMove(DATA, ticket, "запланировано", `план ${basename(candidate.path, ".md")}`);
    syncPush(DATA, `${ticket} план`);
  }

  try {
    const current = readCandidatePlanSnapshot(ROOT, ticket, candidate.path);
    assertPlanBinding(candidate, current);
  } catch {
    const changed = openDb(join(ROOT, "yokemate.db"));
    try { markPublicationResult(changed, publication.id, { complete: false, error: "binding_changed" }); }
    finally { changed.close(); }
    fail(`${ticket} locally planned; publication pending in ${prepared.target}: binding_changed`);
  }

  console.log(`${ticket} → locally planned${out.repeat ? " (repeat)" : ""}, plan: ${candidate.path}`);
  try {
    const reply = await requestPlanControl(ROOT, "plan-recorded", { ticket, path: candidate.path, recordId: record.id }, currentControlOrigin(ROOT), resolveCoordinatorParent(ROOT));
    if (reply.state !== "accepted") fail(`${ticket} locally planned; publication pending in ${prepared.target}: ${reply.reason ?? "unavailable"}`);
    if (reply.publication !== "complete") fail(`${ticket} locally planned; publication pending in ${reply.target ?? prepared.target}: ${reply.reason ?? "unavailable"}`);
    if (reply.handoff === "refused") fail(`${ticket} locally planned; publication complete in ${reply.target ?? prepared.target}; handoff refused: ${reply.reason ?? "unavailable"}`);
    console.log(`${ticket}: scout and plan published to ${reply.target ?? prepared.target}; revision ${reply.revision ?? prepared.revision}; ${reply.runId ? `background run ${reply.runId}` : reply.reason ?? "plan-only; ready for /do"}`);
  } catch (error) {
    fail(`${ticket} locally planned; publication pending in ${prepared.target}: ${(error as Error).message}`);
  }
}
