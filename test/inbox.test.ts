import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindInbox,
  closeInbox,
  deliver,
  ensureDir,
  sidecarPath,
  socketDir,
  socketPath,
  type Report,
} from "../src/inbox.ts";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "inbox-"));
}

test("socketDir takes XDG_RUNTIME_DIR when it has one, /tmp otherwise", () => {
  assert.equal(socketDir({ XDG_RUNTIME_DIR: "/run/user/1000" }, 1000), "/run/user/1000/yokemate");
  assert.equal(socketDir({ XDG_RUNTIME_DIR: "" }, 1000), "/tmp/yokemate-1000");
  assert.equal(socketDir({ XDG_RUNTIME_DIR: "   " }, 1000), "/tmp/yokemate-1000");
  assert.equal(socketDir({}, 1000), "/tmp/yokemate-1000");
});

test("ensureDir refuses a directory owned by someone else", () => {
  const tmp = makeTmp();
  try {
    const dir = join(tmp, "yokemate");
    assert.throws(
      () => ensureDir(dir, 1000, () => ({ uid: 4242 })),
      /принадлежит uid 4242, не 1000/,
    );
    ensureDir(dir, 1000, () => ({ uid: 1000 }));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

const REPORT: Report = { from: "wT:p9", mode: "review", ticket: "YM-0", text: "проба" };

test("deliver answers ENOENT on a dead address and times out on a mute listener", async () => {
  const tmp = makeTmp();
  try {
    assert.deepEqual(await deliver(join(tmp, "nobody.sock"), REPORT), {
      ok: false,
      reason: "ENOENT",
    });

    const sock = join(tmp, "mute.sock");
    const mute = net.createServer(() => {});
    await new Promise<void>((r) => mute.listen(sock, r));
    try {
      assert.deepEqual(await deliver(sock, REPORT, 100), { ok: false, reason: "timeout" });
    } finally {
      mute.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

const SIDECAR = { mode: "main", ticket: null, cwd: "/root", pid: 42 };

test("bindInbox takes a report, acks it and leaves a four-field sidecar", async () => {
  const tmp = makeTmp();
  try {
    const got: Report[] = [];
    const inbox = await bindInbox(tmp, "wT:p1", SIDECAR, (r) => got.push(r));
    try {
      assert.deepEqual(await deliver(inbox.sock, REPORT), { ok: true });
      assert.deepEqual(got, [REPORT]);
      const side = JSON.parse(readFileSync(sidecarPath(tmp, "wT:p1"), "utf8"));
      assert.deepEqual(Object.keys(side).sort(), ["cwd", "mode", "pid", "ticket"]);
      assert.deepEqual(side, SIDECAR);
    } finally {
      closeInbox(tmp, inbox);
    }
    assert.equal(existsSync(inbox.sock), false);
    assert.equal(existsSync(sidecarPath(tmp, "wT:p1")), false);
    closeInbox(tmp, inbox);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("an orphaned socket is taken over, a live one is never stolen", async () => {
  const { spawn } = await import("node:child_process");
  const tmp = makeTmp();
  try {
    const sock = socketPath(tmp, "wT:p2");
    const child = spawn(
      process.execPath,
      [
        "-e",
        `require("node:net").createServer(()=>{}).listen(${JSON.stringify(sock)},()=>console.log("up"))`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((r) => child.stdout.once("data", () => r()));
    child.kill("SIGKILL");
    await new Promise<void>((r) => child.once("exit", () => r()));

    assert.equal(existsSync(sock), true);
    assert.deepEqual(await deliver(sock, REPORT), { ok: false, reason: "ECONNREFUSED" });

    const inbox = await bindInbox(tmp, "wT:p2", SIDECAR, () => {});
    try {
      assert.deepEqual(await deliver(sock, REPORT), { ok: true });
      await assert.rejects(
        () => bindInbox(tmp, "wT:p2", SIDECAR, () => {}),
        /занят живой сессией/,
      );
      assert.deepEqual(await deliver(sock, REPORT), { ok: true });
    } finally {
      closeInbox(tmp, inbox);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
