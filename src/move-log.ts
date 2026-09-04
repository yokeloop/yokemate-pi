// Outcome lines in the pool journal, written by the commands that record the
// outcome — not by prompt discipline. One line per result: «дата тикет
// запланировано: план …». /worklog reads them when the engineer logs hours.
// A failed append must never fail the command that did the real work.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function logMove(root: string, ticket: string, outcome: string, detail = ""): string | null {
  try {
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const day = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
    const dir = join(root, "journal");
    mkdirSync(dir, { recursive: true });
    const line = `- ${day} ${p(now.getHours())}:${p(now.getMinutes())} ${ticket} ${outcome}${detail ? `: ${detail}` : ""}`;
    appendFileSync(join(dir, `${day.slice(0, 7)}.md`), line + "\n");
    return line;
  } catch (e) {
    console.error(`move-log skipped: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
