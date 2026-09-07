import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const TIMEOUT_MS = 2000;

export interface InboxEnv {
  HERDR_PANE_ID?: string;
  YOKEMATE_PARENT_PANE?: string;
  YOKEMATE_MODE?: string;
  YOKEMATE_TICKET?: string;
  XDG_RUNTIME_DIR?: string;
}

export interface Sidecar {
  mode: string;
  ticket: string | null;
  cwd: string;
  pid: number;
}

export function socketDir(env: InboxEnv, uid: number): string {
  const runtime = env.XDG_RUNTIME_DIR?.trim();
  return runtime ? join(runtime, "yokemate") : `/tmp/yokemate-${uid}`;
}

export function socketPath(dir: string, pane: string): string {
  return join(dir, `${pane}.sock`);
}

export function sidecarPath(dir: string, pane: string): string {
  return join(dir, `${pane}.json`);
}

export function ownPane(env: InboxEnv): string | undefined {
  return env.HERDR_PANE_ID?.trim() || undefined;
}

export function parentPane(env: InboxEnv): string | undefined {
  return env.YOKEMATE_PARENT_PANE?.trim() || undefined;
}

export function ensureDir(
  dir: string,
  uid: number,
  stat: (p: string) => { uid: number } = (p) => statSync(p),
): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const owner = stat(dir).uid;
  if (owner !== uid)
    throw new Error(`inbox dir ${dir} принадлежит uid ${owner}, не ${uid} — инбокс не поднимается`);
}
