import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { currentControlOrigin, requestPlanControl, resolveCoordinatorParent, type ControlReply } from "./coordinator-control.ts";
import { readRuntimeSettings } from "./guard-policy.ts";
import { openDb } from "./db.ts";
import { checkMove, type From, type MoveEnv } from "./transitions.ts";
import { assertPlanBinding, readPlanWriterSnapshot, resolvePlanWriterScope } from "./plan-binding.ts";
import { planRecordById, publicationAcceptanceById, readPublicationArtifact, type PublicationOutcome } from "./plan-publication-state.ts";
import { recordPlan } from "./plan-record.ts";
import { assertPublishable } from "./plan-publication.ts";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const fail = (message: string): never => { console.error(message); process.exit(1); };
const argv = process.argv.slice(2).filter((argument) => argument !== "--");
const usage = "usage: plan <TICKET> <absolute-path-to-plan.md> --content-hash <sha256>";
const ticket = argv[0] ?? fail(usage);
const requestedPlanPath = argv[1] ?? fail(usage);
const hashFlags = argv.flatMap((argument, index) => argument === "--content-hash" ? [index] : []);
if (hashFlags.length !== 1 || hashFlags[0] !== 2 || argv.length !== 4) fail(usage);
const contentHash = argv[3] ?? "";
if (!/^[a-f0-9]{64}$/.test(contentHash)) fail("content hash must be 64 lowercase hexadecimal characters");
if (!isAbsolute(requestedPlanPath)) fail("plan path must be absolute");
const planPath = resolve(requestedPlanPath);
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
  const recovery = (reply as ControlReply & { facts?: { recovery?: { sourceTransport?: string; candidateId?: string; incidentId?: string; acceptedInputId?: number; localRecord?: string; remotePublication?: { kind?: string; state?: string }[] } } }).facts?.recovery;
  if (recovery) console.log(`${ticket}: source transport ${recovery.sourceTransport}; recovery candidate ${recovery.candidateId}; incident ${recovery.incidentId}; accepted-input ${recovery.acceptedInputId}; local record ${recovery.localRecord}; remote ${recovery.remotePublication?.map((item) => `${item.kind}:${item.state}`).join(",") ?? "not-started"}`);
  if (reply.handoff === "refused") fail(`${ticket}: handoff refused: ${reply.reason ?? "unavailable"}`);
  if (reply.handoff === "unavailable") console.log(`${ticket}: ${reply.reason ?? "plan-only; ready for /do; automatic handoff unavailable"}`);
  else console.log(`${ticket}: ${reply.runId ? `background run ${reply.runId}` : reply.reason ?? "plan-only; ready for /do"}`);
}

if (process.env.YOKEMATE_PLAN_RUN_ID !== undefined) {
  try {
    if (!process.env.YOKEMATE_PLAN_RUN_ID) fail(`${ticket}: empty plan run id`);
    const reply = await requestPlanControl(ROOT, "record-plan", { ticket, path: requestedPlanPath, contentHash, runId: process.env.YOKEMATE_PLAN_RUN_ID }, currentControlOrigin(ROOT), resolveCoordinatorParent(ROOT));
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
    try {
      const value = readPlanWriterSnapshot(ROOT, resolvePlanWriterScope(ROOT, ticket), requestedPlanPath);
      if (value.contentHash !== contentHash) throw new Error(`${ticket}: binding_changed`);
      assertPublishable(value.bytes);
      return value;
    } catch (error) { return fail((error as Error).message); }
  })();
  const prepared = await (async () => {
    try {
      const reply = await requestPlanControl(ROOT, "prepare-plan-publication", { ticket, path: requestedPlanPath, contentHash }, currentControlOrigin(ROOT), resolveCoordinatorParent(ROOT));
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
  const scope = resolvePlanWriterScope(ROOT, ticket);
  try { assertPlanBinding(candidate, readPlanWriterSnapshot(ROOT, scope, requestedPlanPath)); }
  catch { fail(`${ticket}: binding_changed`); }
  const recorded = await recordPlan(ROOT, ticket, requestedPlanPath, process.env, { expectedBinding: candidate, expectedContentHash: contentHash, requestedPath: requestedPlanPath, scope, recordId: prepared.recordId! }).catch((error) => fail((error as Error).message));
  console.log(`${ticket} → planned${recorded.repeat ? " (repeat)" : ""}, plan: ${candidate.path}`);
  try {
    const reply = await requestPlanControl(ROOT, "plan-recorded", { ticket, path: requestedPlanPath, contentHash, recordId: prepared.recordId }, currentControlOrigin(ROOT), resolveCoordinatorParent(ROOT));
    if (reply.state !== "accepted") fail(`${ticket} locally recorded; ${reply.reason ?? "handoff unavailable"}`);
    reportReady(reply);
  } catch (error) { fail(`${ticket} locally recorded; ${(error as Error).message}`); }
}
