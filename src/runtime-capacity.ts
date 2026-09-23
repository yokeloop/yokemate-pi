import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { processStarttime } from "./coordinator-control.ts";

export interface CapacityLease { ownerId: string; pid: number; starttime: string; units: number }

function prune(db: DatabaseSync): void {
  const rows = db.prepare("SELECT owner_id,pid,starttime FROM runtime_capacity_lease").all() as unknown as { owner_id: string; pid: number; starttime: string }[];
  for (const row of rows) if (processStarttime(row.pid) !== row.starttime) db.prepare("DELETE FROM runtime_capacity_lease WHERE owner_id=?").run(row.owner_id);
  const subscribers = db.prepare("SELECT subscriber_id,pid,starttime FROM runtime_capacity_subscriber").all() as unknown as { subscriber_id: string; pid: number; starttime: string }[];
  for (const row of subscribers) if (processStarttime(row.pid) !== row.starttime) db.prepare("DELETE FROM runtime_capacity_subscriber WHERE subscriber_id=?").run(row.subscriber_id);
}

export function reserveRuntimeCapacity(path: string, lease: CapacityLease, limit: number): void {
  const pool = lease.ownerId.split(":", 1)[0];
  if (!pool || lease.units < 1 || !Number.isInteger(lease.units) || limit < lease.units) throw new Error("global runtime capacity exhausted");
  const db = openDb(path);
  db.exec("BEGIN IMMEDIATE");
  try {
    prune(db);
    const existing = db.prepare("SELECT pid,starttime,units FROM runtime_capacity_lease WHERE owner_id=?").get(lease.ownerId) as { pid: number; starttime: string; units: number } | undefined;
    if (existing) {
      if (existing.pid !== lease.pid || existing.starttime !== lease.starttime || existing.units !== lease.units) throw new Error("runtime capacity lease identity changed");
      db.exec("COMMIT");
      return;
    }
    const used = (db.prepare("SELECT COALESCE(SUM(units),0) total FROM runtime_capacity_lease WHERE owner_id LIKE ?").get(`${pool}:%`) as { total: number }).total;
    if (used + lease.units > limit) throw new Error(`global ${pool} capacity exhausted (${used}/${limit})`);
    db.prepare("INSERT INTO runtime_capacity_lease (owner_id,pid,starttime,units) VALUES (?,?,?,?)").run(lease.ownerId, lease.pid, lease.starttime, lease.units);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally { db.close(); }
}

export function releaseRuntimeCapacity(path: string, ownerId: string): void {
  const db = openDb(path);
  let sockets: string[] = [];
  try {
    const deleted = db.prepare("DELETE FROM runtime_capacity_lease WHERE owner_id=?").run(ownerId);
    if (deleted.changes) {
      prune(db);
      sockets = (db.prepare("SELECT socket_path FROM runtime_capacity_subscriber").all() as unknown as { socket_path: string }[]).map((row) => row.socket_path);
    }
  } finally { db.close(); }
  for (const socket of sockets) {
    const client = createConnection(socket);
    client.unref();
    client.on("error", () => {});
    client.end("capacity");
  }
}

export function subscribeRuntimeCapacity(path: string, subscriberId: string, wake: () => void): () => void {
  const starttime = processStarttime(process.pid);
  if (!starttime) throw new Error("cannot prove runtime capacity subscriber process");
  const token = createHash("sha256").update(`${path}\0${subscriberId}\0${process.pid}\0${starttime}`).digest("hex").slice(0, 24);
  const socketPath = join(tmpdir(), `yokemate-capacity-${token}.sock`);
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const server = createServer((socket) => { socket.resume(); socket.once("end", wake); });
  server.listen(socketPath, () => {
    const db = openDb(path);
    try {
      prune(db);
      db.prepare("INSERT INTO runtime_capacity_subscriber (subscriber_id,pid,starttime,socket_path) VALUES (?,?,?,?) ON CONFLICT(subscriber_id) DO UPDATE SET pid=excluded.pid,starttime=excluded.starttime,socket_path=excluded.socket_path,created_at=datetime('now')").run(subscriberId, process.pid, starttime, socketPath);
    } finally { db.close(); }
    wake();
  });
  server.unref();
  return () => {
    const db = openDb(path);
    try { db.prepare("DELETE FROM runtime_capacity_subscriber WHERE subscriber_id=? AND pid=? AND starttime=?").run(subscriberId, process.pid, starttime); } finally { db.close(); }
    server.close();
    if (existsSync(socketPath)) unlinkSync(socketPath);
  };
}

export function availableRuntimeCapacity(path: string, limit: number, pool = "running"): number {
  const db = openDb(path);
  db.exec("BEGIN IMMEDIATE");
  try {
    prune(db);
    const used = (db.prepare("SELECT COALESCE(SUM(units),0) total FROM runtime_capacity_lease WHERE owner_id LIKE ?").get(`${pool}:%`) as { total: number }).total;
    db.exec("COMMIT");
    return Math.max(0, limit - used);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally { db.close(); }
}
