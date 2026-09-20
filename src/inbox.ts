import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as net from "node:net";
import { join, resolve } from "node:path";
import { readRuntimeSettings, type RuntimeSettings } from "./guard-policy.ts";

export const TIMEOUT_MS = 2000;
export const ROOT = resolve(new URL("..", import.meta.url).pathname);

export interface InboxEnv {
  HERDR_PANE_ID?: string;
  YOKEMATE_PARENT_PANE?: string;
  YOKEMATE_MODE?: string;
  YOKEMATE_TICKET?: string;
  YOKEMATE_RUN_ID?: string;
  XDG_RUNTIME_DIR?: string;
}

export interface Sidecar {
  mode: string;
  ticket: string | null;
  cwd: string;
  pid: number;
  starttime: string;
  sessionId: string;
  parentPane: string | null;
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

export interface Report {
  from: string;
  mode: string;
  ticket: string | null;
  text: string;
  runId?: string;
}

export type Delivery = { ok: true } | { ok: false; reason: string };

export function deliver(sock: string, report: Report, timeoutMs = TIMEOUT_MS): Promise<Delivery> {
  return new Promise((resolve) => {
    const socket = net.createConnection(sock);
    let settled = false;
    const finish = (d: Delivery): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(d);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);

    socket.on("connect", () => socket.write(JSON.stringify(report) + "\n"));
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      let ack: unknown;
      try {
        ack = JSON.parse(buf.slice(0, nl));
      } catch {
        return finish({ ok: false, reason: "bad ack" });
      }
      finish(
        (ack as { ok?: unknown } | null)?.ok === true
          ? { ok: true }
          : { ok: false, reason: "bad ack" },
      );
    });
    socket.on("error", (err: NodeJS.ErrnoException) =>
      finish({ ok: false, reason: err.code ?? err.message }),
    );
    socket.on("close", () => finish({ ok: false, reason: "bad ack" }));
  });
}

export interface Inbox {
  pane: string;
  sock: string;
  server: net.Server;
}

function probe(sock: string, timeoutMs: number): Promise<"alive" | "dead"> {
  return new Promise((resolve) => {
    const socket = net.createConnection(sock);
    let settled = false;
    const finish = (v: "alive" | "dead"): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => finish("alive"), timeoutMs);
    socket.on("connect", () => finish("alive"));
    socket.on("error", (err: NodeJS.ErrnoException) =>
      finish(err.code === "ECONNREFUSED" || err.code === "ENOENT" ? "dead" : "alive"),
    );
  });
}

export function bindInbox(
  dir: string,
  pane: string,
  sidecar: Sidecar,
  onReport: (r: Report) => void,
  timeoutMs = TIMEOUT_MS,
): Promise<Inbox> {
  const sock = socketPath(dir, pane);
  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("error", () => {});
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = "";
      let report: Report;
      try {
        report = JSON.parse(line) as Report;
      } catch {
        conn.end('{"ok":false}\n');
        return;
      }
      onReport(report);
      conn.end('{"ok":true}\n');
    });
  });

  return new Promise<Inbox>((resolve, reject) => {
    let settled = false;
    let retried = false;
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      if (err.code !== "EADDRINUSE" || retried) {
        settled = true;
        return reject(err);
      }
      retried = true;
      void probe(sock, timeoutMs).then((state) => {
        if (state === "alive") {
          settled = true;
          return reject(new Error(`inbox ${sock} занят живой сессией`));
        }
        try {
          unlinkSync(sock);
        } catch {}
        server.listen(sock);
      });
    });
    server.on("listening", () => {
      settled = true;
      writeFileSync(sidecarPath(dir, pane), JSON.stringify(sidecar));
      resolve({ pane, sock, server });
    });
    server.listen(sock);
  });
}

export function closeInbox(dir: string, inbox: Inbox): void {
  inbox.server.close();
  rmSync(inbox.sock, { force: true });
  rmSync(sidecarPath(dir, inbox.pane), { force: true });
}

export interface Candidate {
  pane: string;
  sock: string;
  json: string;
  cwd: string;
}

function readMains(dir: string, self?: string): Candidate[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const found: Candidate[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const pane = name.slice(0, -".json".length);
    if (pane === self) continue;
    let side: Sidecar;
    try {
      side = JSON.parse(readFileSync(join(dir, name), "utf8")) as Sidecar;
    } catch {
      continue;
    }
    if (side?.mode !== "main") continue;
    found.push({ pane, sock: socketPath(dir, pane), json: sidecarPath(dir, pane), cwd: side.cwd });
  }
  return found;
}

export function scanMains(dir: string, self?: string, root: string = ROOT): Candidate[] {
  return readMains(dir, self).filter((c) => resolve(c.cwd) === root);
}

export function allowTarget(
  env: InboxEnv,
  to: string | undefined,
  mains: string[],
  settings: RuntimeSettings = readRuntimeSettings(),
): { ok: true } | { ok: false; reason: string } {
  const { policy } = settings;
  if (!policy.guards.reportTarget || !env.YOKEMATE_MODE) return { ok: true };
  if (!to) return { ok: true };
  if (to === parentPane(env) || mains.includes(to)) return { ok: true };
  return {
    ok: false,
    reason:
      "из панели отчёт уходит только родителю или главному чату — убери `to`, адрес выводится сам",
  };
}

export async function sendReport(
  env: InboxEnv,
  uid: number,
  text: string,
  to?: string,
  timeoutMs = TIMEOUT_MS,
  root: string = ROOT,
): Promise<{ ok: boolean; line: string }> {
  const dir = socketDir(env, uid);
  const self = ownPane(env);
  const report: Report = {
    from: self ?? "cli",
    mode: env.YOKEMATE_MODE ?? "main",
    ticket: env.YOKEMATE_TICKET ?? null,
    text,
    ...(env.YOKEMATE_RUN_ID ? { runId: env.YOKEMATE_RUN_ID } : {}),
  };

  const sweepIfDead = (pane: string, reason: string): void => {
    if (reason !== "ECONNREFUSED" && reason !== "ENOENT") return;
    rmSync(socketPath(dir, pane), { force: true });
    rmSync(sidecarPath(dir, pane), { force: true });
  };

  const target = to ?? parentPane(env);
  let reason: string | undefined;
  if (target) {
    const d = await deliver(socketPath(dir, target), report, timeoutMs);
    if (d.ok) return { ok: true, line: "delivered" };
    reason = d.reason;
    sweepIfDead(target, d.reason);
  }

  const live: Candidate[] = [];
  for (const c of readMains(dir, self)) {
    if (c.pane === target) continue;
    if ((await probe(c.sock, timeoutMs)) !== "alive") sweepIfDead(c.pane, "ECONNREFUSED");
    else if (resolve(c.cwd) === root) live.push(c);
  }

  if (live.length > 1)
    return {
      ok: false,
      line: "unreachable: главных чатов корня больше одного — скажи отчёт в своей панели",
    };

  if (live.length === 1) {
    const d = await deliver(live[0]!.sock, report, timeoutMs);
    if (d.ok) return { ok: true, line: `delivered: fallback ${live[0]!.pane}` };
    sweepIfDead(live[0]!.pane, d.reason);
  }

  return { ok: false, line: `unreachable: ${reason ?? "no live inbox"}` };
}
