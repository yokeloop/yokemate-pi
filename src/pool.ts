// The model of a launch that has no ticket. `/plan <проблема>` and `/note
// <тема>` carry no key, so no passport can be asked — and the machine's own
// default is never inherited (YM-84). The answer lives in home/pool.json, in
// the engineer's own repository next to projects.json, so it reaches a new
// machine by the same git clone the passports do.
//
// No branch here falls back to a literal: a missing file or a missing mode is
// a loud refusal naming what to write (YM-159).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MODES, type Mode } from "./mode-guard.ts";

export function poolPath(dataRoot: string): string {
  return join(dataRoot, "pool.json");
}

/** Карта пула, мод → pi-паттерн. Отсутствующий или кривой файл — отказ,
 *  называющий путь и форму: подставить литерал вместо ответа нечем. */
export function readPool(dataRoot: string): Partial<Record<Mode, string>> {
  const path = poolPath(dataRoot);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `no pool.json in ${dataRoot} — a launch without a ticket takes its model from there: ` +
        `create it as {"plan": "<pattern>", "note": "<pattern>", "research": "<pattern>"}, or pass --model in the command`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path}: not valid JSON — expected {"<mode>": "<model>", …}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${path}: expected an object of "<mode>": "<model>" pairs`);
  const out: Partial<Record<Mode, string>> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(MODES as readonly string[]).includes(k))
      throw new Error(`${path}: unknown mode "${k}" — the panel modes are: ${MODES.join(", ")}`);
    if (typeof v !== "string" || v === "")
      throw new Error(`${path}: "${k}" must be a model pattern string`);
    out[k as Mode] = v;
  }
  return out;
}

/** Модель безтикетного запуска этого мода. Кидает, называя, что дописать. */
export function poolModel(dataRoot: string, mode: Mode): string {
  const model = readPool(dataRoot)[mode];
  if (!model)
    throw new Error(
      `no ${mode} model in ${poolPath(dataRoot)} — add "${mode}": "<pattern>", ` +
        `or pass --model in the command`,
    );
  return model;
}
