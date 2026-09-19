import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { currentControlOrigin, requestPlanControl, resolveCoordinatorParent, type ControlReply } from "./coordinator-control.ts";
import { readRuntimeSettings } from "./guard-policy.ts";
import { openDb } from "./db.ts";
import { checkMove, type From, type MoveEnv } from "./transitions.ts";
import { assertPlanBinding, readCandidatePlanSnapshot } from "./plan-binding.ts";
import { planRecordById, publicationAcceptanceById, readPublicationArtifact, type PublicationOutcome } from "./plan-publication-state.ts";
import { recordPlan } from "./plan-record.ts";
import { assertPublishable } from "./plan-publication.ts";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const fail = (message: string): never => { console.error(message); process.exit(1); };
const argv = process.argv.slice(2).filter((argument) => argument !== "--");
const ticket = argv[0] ?? fail("usage: plan <TICKET> <path-to-plan.md>");
const planPath = resolve(argv[1] ?? fail("usage: plan <TICKET> <path-to-plan.md>"));
if (!existsSync(planPath)) fail(`plan not found: ${planPath}`);

function reportPublications(publications: PublicationOutcome[] | undefined): void {
  for (const outcome of publications ?? []) {
    if (outcome.state === "pending") console.error(`warning: ${outcome.kind} publication → ${outcome.target}: ${outcome.error ?? "unavailable"}`);
    else console.log(`${ticket}: ${outcome.kind} published to ${outcome.target}; revision ${outcome.revision}`);
  }
  if (publications?.length === 2 && publications.every((outcome) => outcome.state === "complete")) console.log(`${ticket}: scout and plan published`);
}

function reportReady(reply: ControlReply): void {
  reportPublications(reply.publications);
  if (reply.handoff === "refused") fail(`${ticket}: handoff refused: ${reply.reason ?? "unavailable"}`);
  console.log(`${ticket}: ${reply.runId ? `background run ${reply.runId}` : reply.reason ?? "plan-only; ready for /do"}`);
}

if (process.env.YOKEMATE_PLAN_RUN_ID) {
  try {
    const reply = await requestPlanControl(ROOT, "record-plan", { ticket, path: planPath, runId: process.env.YOKEMATE_PLAN_RUN_ID }, currentControlOrigin(ROOT), resolveCoordinatorParent(ROOT));
    if (reply.state !== "accepted") fail(reply.reason ?? "plan record refused");
    console.log(`${ticket} → planned, plan: ${planPath}`);
    reportReady(reply);
  } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
} else {
  const settings = readRuntimeSettings(ROOT);
  const preflightDb = openDb(join(ROOT, "yokemate.db"));
  const preflightRow = preflightDb.prepare("SELECT stage FROM work WHERE ticket=?").get(ticket) as { stage: From } | undefined;
  preflightDb.close();
  const preflightMove = checkMove("plan", process.env as MoveEnv, ticket, preflightRow?.stage ?? "absent", { settings });
  if (!preflightMove.ok) fail(preflightMove.refuse);
  const candidate = (() => {
    try { const value = readCandidatePlanSnapshot(ROOT, ticket, planPath); assertPublishable(value.bytes); return value; }
    catch (error) { return fail((error as Error).message); }
  })();
  const prepared = await (async () => {
    try {
      const reply = await requestPlanControl(ROOT, "prepare-plan-publication", { ticket, path: candidate.path, contentHash: candidate.contentHash }, currentControlOrigin(ROOT), resolveCoordinatorParent(ROOT));
      if (reply.state !== "accepted" || !reply.recordId || !reply.snapshotPath || !reply.scoutAcceptance || !reply.revision) return fail(reply.reason ?? `${ticket}: local plan preparation refused`);
      return reply;
    } catch (error) { return fail(`${ticket}: local plan preparation refused: ${(error as Error).message}`); }
  })();
  const state = openDb(join(ROOT, "yokemate.db"));
  try {
    const record = planRecordById(state, prepared.recordId!);
    const scout = publicationAcceptanceById(state, prepared.scoutAcceptance!);
    if (!record || !scout || record.ticket !== ticket || record.plan_path !== candidate.path || record.content_hash !== candidate.contentHash || record.scope_hash !== candidate.scopeHash || record.scout_acceptance !== prepared.scoutAcceptance || record.artifact_path !== prepared.snapshotPath) throw new Error(`${ticket}: binding_changed`);
    assertPublishable(readPublicationArtifact(ROOT, record));
    assertPublishable(readPublicationArtifact(ROOT, scout));
  } finally { state.close(); }
  try { assertPlanBinding(candidate, readCandidatePlanSnapshot(ROOT, ticket, candidate.path)); }
  catch { fail(`${ticket}: binding_changed`); }
  const recorded = await recordPlan(ROOT, ticket, candidate.path, process.env, { expectedBinding: candidate, recordId: prepared.recordId! }).catch((error) => fail((error as Error).message));
  console.log(`${ticket} → planned${recorded.repeat ? " (repeat)" : ""}, plan: ${candidate.path}`);
  try {
    const reply = await requestPlanControl(ROOT, "plan-recorded", { ticket, path: candidate.path, recordId: prepared.recordId }, currentControlOrigin(ROOT), resolveCoordinatorParent(ROOT));
    if (reply.state !== "accepted") fail(`${ticket} locally recorded; ${reply.reason ?? "handoff unavailable"}`);
    reportReady(reply);
  } catch (error) { fail(`${ticket} locally recorded; ${(error as Error).message}`); }
}
