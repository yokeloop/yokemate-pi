import { join } from "node:path";
import { openDb } from "./db.ts";
import { readPlanWriterSnapshot, resolvePlanWriterScope, toPlanBinding } from "./plan-binding.ts";
import { assertPublishable } from "./plan-publication.ts";
import { acceptPlanRecord, publicationAcceptanceById, readPublicationArtifact, writePublicationArtifact } from "./plan-publication-state.ts";
import { writerDraftFor } from "./workflow-incident-state.ts";

export interface VerifiedGroupWriter { runId: string; taskHash: string; actualTaskHash: string; acceptedInputId: number }

export function prepareGroupMemberPlanRecord(root: string, input: { groupId: string; treeHash: string; ticket: string; path: string; contentHash: string; acceptanceId: number; ownerSessionId: string; writer: VerifiedGroupWriter }) {
  if (!/^[a-f0-9]{64}$/.test(input.contentHash)) throw new Error("binding_changed");
  const scope = resolvePlanWriterScope(root, input.ticket);
  const snapshot = readPlanWriterSnapshot(root, scope, input.path);
  if (snapshot.contentHash !== input.contentHash) throw new Error("binding_changed");
  assertPublishable(snapshot.bytes);
  const db = openDb(join(root, "yokemate.db"));
  try {
    const claim = db.prepare("SELECT group_id,tree_hash,state FROM member_claim WHERE kind='group' AND ticket=?").get(input.ticket) as { group_id: string; tree_hash: string; state: string } | undefined;
    if (!claim || claim.group_id !== input.groupId || claim.tree_hash !== input.treeHash || !["reserved", "active"].includes(claim.state)) throw new Error(`${input.ticket}: group plan claim is missing or stale`);
    const scout = publicationAcceptanceById(db, input.acceptanceId);
    if (!scout || scout.ticket !== input.ticket || scout.owner_session_id !== input.ownerSessionId) throw new Error("group plan preparation requires its current accepted scout");
    assertPublishable(readPublicationArtifact(root, scout));
    if (input.writer.acceptedInputId !== scout.id || !input.writer.runId || !/^[a-f0-9]{64}$/.test(input.writer.taskHash) || input.writer.actualTaskHash !== input.writer.taskHash) throw new Error("group plan is not correlated to a verified writer result");
    let writer = { runId: input.writer.runId, taskHash: input.writer.taskHash, actualTaskHash: input.writer.actualTaskHash };
    if (scout.source_kind === "engineer-accepted-input") {
      const draft = writerDraftFor(db, snapshot.contentHash);
      if (!draft || draft.accepted_input_id !== scout.id || draft.planning_identity !== scout.continuation_id || draft.plan_path !== snapshot.path || draft.bytes !== snapshot.bytes.length) throw new Error("recovery plan is not the correlated writer draft");
      const markers = ["BREAK-GLASS: engineer-accepted-input", `incident: ${scout.incident_id}`, `source-run: ${scout.source_run_id}`, `source-hash: ${scout.content_hash}`, `reason: ${scout.incident_reason}`, "skipped: failed-transport-envelope"];
      if (markers.some((marker) => !snapshot.text.includes(marker))) throw new Error("recovery plan assumptions do not match incident provenance");
      const recovered = { runId: draft.writer_run_id, taskHash: draft.writer_task_hash, actualTaskHash: draft.writer_actual_task_hash };
      if (JSON.stringify(recovered) !== JSON.stringify(writer)) throw new Error("recovery writer identity differs from the verified terminal result");
    }
    const snapshotPath = writePublicationArtifact(root, input.ticket, "plan", snapshot.contentHash, snapshot.bytes);
    const record = acceptPlanRecord(db, { ticket: input.ticket, planPath: snapshot.path, contentHash: snapshot.contentHash, scopeHash: snapshot.scopeHash, artifactPath: snapshotPath, bytes: snapshot.bytes.length, scoutAcceptance: scout.id, ...(scout.publication_id ? { scoutPublication: scout.publication_id } : {}), writer });
    return { binding: toPlanBinding(snapshot), record, requestedPath: input.path, scope };
  } finally { db.close(); }
}
