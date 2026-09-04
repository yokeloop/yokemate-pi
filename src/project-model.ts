// The model every launch runs on comes from the project passports and nowhere
// else: an explicit --model in the engineer's command overrides it, and the
// machine's own default never leaks in (YM-84). A ticket resolves through its
// key prefix, worklog through the org column; both refuse loudly when the
// passports cannot answer.
import type { DatabaseSync } from "node:sqlite";

/** ACME-347 → the single model every passport with tracker_key ACME agrees on. */
export function modelForTicket(db: DatabaseSync, ticket: string): string {
  const key = ticket.split("-")[0];
  const models = (
    db.prepare("SELECT DISTINCT model FROM project WHERE tracker_key = ?").all(key) as unknown as
      { model: string | null }[]
  ).map((r) => r.model);
  if (models.length === 0) throw new Error(`no passport with key ${key} — pnpm add-project first`);
  if (models.length > 1 || models[0] === null)
    throw new Error(
      `passports of ${key} disagree on the model ` +
        `(${models.map((m) => m ?? "NULL").join(", ")}) — pnpm set-model ${key} <m>`,
    );
  return models[0];
}

/** acme → the single model every passport of the org agrees on. */
export function modelForOrg(db: DatabaseSync, org: string): string {
  const models = (
    db.prepare("SELECT DISTINCT model FROM project WHERE org = ?").all(org) as unknown as
      { model: string | null }[]
  ).map((r) => r.model);
  if (models.length === 0)
    throw new Error(`no passports of org ${org} — pass --model in the command, or pnpm add-project first`);
  if (models.length > 1 || models[0] === null)
    throw new Error(
      `passports of ${org} disagree on the model ` +
        `(${models.map((m) => m ?? "NULL").join(", ")}) — pass --model in the command, ` +
        `or pnpm set-model <KEY> <m> per the org's tracker keys`,
    );
  return models[0];
}
