// The task tab's teammates (R4.4). A tab runs from work/<TICKET>/, so
// <ROOT>/.pi/agents is out of reach — the agents are linked into the task
// folder's own .pi/agents at launch and die with it at /review. Nothing is
// placed outside yokemate for this: the engineer's home directory is not ours
// to arrange, and an agent left there would show up in every unrelated session.
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

/** Returns the file names linked, so the caller can say what the tab got. */
export function linkTeammates(src: string, dst: string): string[] {
  if (!existsSync(src)) return [];
  const files = readdirSync(src).filter((f) => f.endsWith(".md"));
  // Relaunch of the same ticket relinks from scratch: a teammate renamed in the
  // repository must not survive in the task folder under its old name.
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  for (const f of files) symlinkSync(join(src, f), join(dst, f));
  return files;
}
