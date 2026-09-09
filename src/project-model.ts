// The model every launch runs on comes from the project passports and nowhere
// else: an explicit --model in the engineer's command overrides it, and the
// machine's own default never leaks in (YM-84). A ticket resolves through its
// key prefix, worklog through the org column; both refuse loudly when the
// passports cannot answer.
//
// The model is resolved per panel mode: a passport carries one default for the
// project and, over it, a map of per-mode overrides (YM-159). The resolution
// happens on every passport row before the rows are deduplicated — otherwise
// two passports of one key with the same default and different overrides would
// wrongly "agree".
import type { DatabaseSync } from "node:sqlite";
import { MODES, type Mode } from "./mode-guard.ts";

export type ModeModels = Partial<Record<Mode, string>>;

type PassportRow = { model: string | null; mode_models: string | null };

/** Колонка `mode_models` → карта. Нечитаемое значение — пустая карта: запуск
 *  не должен умирать на правленной руками строке, он уезжает на умолчание. */
export function parseModeModels(raw: string | null | undefined): ModeModels {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: ModeModels = {};
  for (const mode of MODES) {
    const v = (parsed as Record<string, unknown>)[mode];
    if (typeof v === "string" && v !== "") out[mode] = v;
  }
  return out;
}

/** Каноническая запись для колонки и для манифеста: ключи в порядке MODES,
 *  поэтому две записи одной карты байт в байт совпадают. Пустая → null. */
export function serializeModeModels(m: ModeModels): string | null {
  const out: Record<string, string> = {};
  for (const mode of MODES) if (m[mode]) out[mode] = m[mode]!;
  return Object.keys(out).length === 0 ? null : JSON.stringify(out);
}

/** `review=openai-codex/gpt-5.6-luna` → пара; токен без `=` — умолчание
 *  проекта и приходит с `mode === null`. Кидает на незнакомом моде и на
 *  пустом значении. Одно правило разбора на add-project и set-model. */
export function parseModelToken(token: string): { mode: Mode | null; model: string } {
  const i = token.indexOf("=");
  if (i === -1) return { mode: null, model: token };
  const mode = token.slice(0, i);
  const model = token.slice(i + 1);
  if (!(MODES as readonly string[]).includes(mode))
    throw new Error(
      `unknown mode "${mode}" in "${token}" — the panel modes are: ${MODES.join(", ")}`,
    );
  if (model === "")
    throw new Error(
      `"${token}" has no model — write <mode>=<pattern>, e.g. review=openai-codex/gpt-5.6-luna`,
    );
  return { mode: mode as Mode, model };
}

/** Ответ одной строки паспорта на один мод: переопределение, иначе умолчание. */
export function rowModel(row: PassportRow, mode: Mode): string | null {
  return parseModeModels(row.mode_models)[mode] ?? row.model;
}

/** ACME-347 + этап → модель, на которой сходятся все паспорта ключа ACME. */
export function modelForTicket(db: DatabaseSync, ticket: string, mode: Mode): string {
  const key = ticket.split("-")[0];
  const rows = db
    .prepare("SELECT model, mode_models FROM project WHERE tracker_key = ?")
    .all(key) as unknown as PassportRow[];
  if (rows.length === 0) throw new Error(`no passport with key ${key} — pnpm add-project first`);
  const models = [...new Set(rows.map((r) => rowModel(r, mode)))];
  if (models.length > 1 || models[0] === null)
    throw new Error(
      `passports of ${key} disagree on the ${mode} model ` +
        `(${models.map((m) => m ?? "NULL").join(", ")}) — pnpm set-model ${key} ${mode}=<m>`,
    );
  return models[0];
}

/** acme + этап → модель, на которой сходятся все паспорта организации. */
export function modelForOrg(db: DatabaseSync, org: string, mode: Mode): string {
  const rows = db
    .prepare("SELECT model, mode_models FROM project WHERE org = ?")
    .all(org) as unknown as PassportRow[];
  if (rows.length === 0)
    throw new Error(`no passports of org ${org} — pass --model in the command, or pnpm add-project first`);
  const models = [...new Set(rows.map((r) => rowModel(r, mode)))];
  if (models.length > 1 || models[0] === null)
    throw new Error(
      `passports of ${org} disagree on the ${mode} model ` +
        `(${models.map((m) => m ?? "NULL").join(", ")}) — pass --model in the command, ` +
        `or pnpm set-model <KEY> ${mode}=<m> per the org's tracker keys`,
    );
  return models[0];
}
