// A model pattern is checked against pi's own catalogue before it is written
// into a passport: `add-project` and `set-model` used to take any string, and a
// wrong id under a provider pi knows is not caught at launch either — pi
// synthesizes the model and the refusal arrives from the API call.
//
// What the parsing stands on, measured on pi 0.85.1:
//   - `pi --list-models <pattern>` always exits 0, on a hit and on a miss
//     alike. The exit code says nothing.
//   - the matching is fuzzy (over the string "<provider> <id>"), so a row in
//     the table does not mean the pattern names that model. An exact
//     `provider/id`, or a bare `id`, is required.
//   - a `:<thinking>` suffix breaks the search — `openai-codex/gpt-6-astra`
//     finds a row, `openai-codex/gpt-6-astra:high` prints `No models
//     matching`. The suffix is cut off before the call and checked separately.
//   - stdout carries the table alone (header `provider  model  context
//     max-out  thinking  images` and its rows) or the single line `No models
//     matching "…"`; provider chatter (`LiteLLM: …`) goes to stderr. The
//     parsing still looks for the header instead of reading from line one.
//
// The parsing is pure functions and the pi call a thin injectable wrapper, so
// the set is tested without a subprocess.

import { execFileSync } from "node:child_process";

export const THINKING_LEVELS = [
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
] as const;

export interface CatalogRow { provider: string; id: string; }

export type Check = { ok: true; skipped?: boolean } | { ok: false; reason: string };

/** Cut off the optional `:<thinking>` — at the last colon. */
export function splitThinking(pattern: string): { model: string; level?: string } {
  const i = pattern.lastIndexOf(":");
  return i === -1 ? { model: pattern } : { model: pattern.slice(0, i), level: pattern.slice(i + 1) };
}

/** Rows of the `pi --list-models` table: the header is found by its first
 *  column, then the first two fields of every line are taken. No header — no
 *  matches. */
export function parseModels(stdout: string): CatalogRow[] {
  const lines = stdout.split("\n");
  const head = lines.findIndex((l) => /^provider\s+model\s/.test(l));
  if (head === -1) return [];
  const rows: CatalogRow[] = [];
  for (const l of lines.slice(head + 1)) {
    const f = l.trim().split(/\s+/);
    if (f.length < 2) continue;
    rows.push({ provider: f[0], id: f[1] });
  }
  return rows;
}

/** An exact hit: the whole `provider/id`, or the bare `id`. */
export function exactMatch(model: string, rows: CatalogRow[]): CatalogRow | undefined {
  return rows.find((r) => `${r.provider}/${r.id}` === model || r.id === model);
}

export function checkModel(pattern: string, list: (p: string) => string | null): Check {
  const { model, level } = splitThinking(pattern);
  if (level !== undefined && !(THINKING_LEVELS as readonly string[]).includes(level))
    return {
      ok: false,
      reason:
        `уровень мышления "${level}" в паттерне "${pattern}" не существует — ` +
        `есть только: ${THINKING_LEVELS.join(", ")}`,
    };

  const stdout = list(model);
  if (stdout === null) return { ok: true, skipped: true };

  const rows = parseModels(stdout);
  if (exactMatch(model, rows)) return { ok: true };
  if (rows.length === 0)
    return {
      ok: false,
      reason: `модель "${pattern}" не найдена в каталоге pi — каталог не вернул ни одной строки`,
    };
  const near = rows.slice(0, 8).map((r) => `${r.provider}/${r.id}`).join(", ");
  return {
    ok: false,
    reason: `модель "${pattern}" не найдена в каталоге pi — ближайшие: ${near}`,
  };
}

/** stdout of `pi --offline --list-models <pattern>`, or null when pi is not
 *  reachable. `--offline` is not optional: without it the step goes to the
 *  network, with it the answer comes from the catalogue cache. */
export function piList(pattern: string): string | null {
  try {
    return execFileSync("pi", ["--offline", "--list-models", pattern], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** The call from a CLI: a refusal prints its reason and exits. An unreachable
 *  pi only warns — bootstrap.sh runs `import-projects` before the machine has
 *  a pi session, and a refusal there costs more than a skipped check. */
export function assertModel(pattern: string, list: (p: string) => string | null = piList): void {
  const verdict = checkModel(pattern, list);
  if (verdict.ok) {
    if (verdict.skipped)
      console.error(
        `note: pi не ответил на --list-models — модель "${pattern}" записана без проверки`,
      );
    return;
  }
  console.error(verdict.reason);
  process.exit(1);
}
