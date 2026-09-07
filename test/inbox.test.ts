import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allowTarget,
  bindInbox,
  closeInbox,
  deliver,
  ensureDir,
  scanMains,
  sendReport,
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

function writeSidecar(dir: string, pane: string, side: Record<string, unknown>): void {
  writeFileSync(sidecarPath(dir, pane), JSON.stringify(side));
}

test("the ladder falls back to a live main and sweeps the dead pairs it passes", async () => {
  const tmp = makeTmp();
  const env = {
    XDG_RUNTIME_DIR: "",
    YOKEMATE_PARENT_PANE: "w0:pX",
    YOKEMATE_MODE: "review",
    YOKEMATE_TICKET: "YM-0",
    HERDR_PANE_ID: "wT:p9",
  };
  const dir = socketDir({ ...env, XDG_RUNTIME_DIR: tmp }, 0);
  try {
    mkdirSync(dir, { recursive: true });
    const send = (to?: string) =>
      sendReport({ ...env, XDG_RUNTIME_DIR: tmp }, 0, "проба", to, 200, "/root");

    assert.deepEqual(await send(), { ok: false, line: "unreachable: ENOENT" });

    writeSidecar(dir, "wA:p1", { mode: "main", ticket: null, cwd: "/root", pid: 1 });
    writeFileSync(socketPath(dir, "wA:p1"), "");
    writeSidecar(dir, "wB:p1", { mode: "review", ticket: "YM-1", cwd: "/root", pid: 2 });
    writeSidecar(dir, "wC:p1", { mode: "main", ticket: null, cwd: "/root", pid: 3 });
    writeFileSync(sidecarPath(dir, "wD:p1"), "{ not json");
    writeSidecar(dir, "w0:pX", { mode: "ship", ticket: "YM-2", cwd: "/root", pid: 4 });
    writeFileSync(socketPath(dir, "w0:pX"), "");

    const got: Report[] = [];
    const inbox = await bindInbox(dir, "wC:p1", SIDECAR, (r) => got.push(r));
    try {
      assert.deepEqual(await send(), { ok: true, line: "delivered: fallback wC:p1" });
      assert.deepEqual(got, [
        { from: "wT:p9", mode: "review", ticket: "YM-0", text: "проба" },
      ]);
      assert.equal(existsSync(socketPath(dir, "wA:p1")), false);
      assert.equal(existsSync(sidecarPath(dir, "wA:p1")), false);
      assert.equal(existsSync(sidecarPath(dir, "wD:p1")), true);

      // The dead parent is swept too, though scanMains never lists it: it is
      // stamped, not a main, and the ladder only ever tried it as the target.
      assert.equal(existsSync(socketPath(dir, "w0:pX")), false);
      assert.equal(existsSync(sidecarPath(dir, "w0:pX")), false);

      assert.deepEqual(await send("wC:p1"), { ok: true, line: "delivered" });
    } finally {
      closeInbox(dir, inbox);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

const PANE_ENV = {
  YOKEMATE_PARENT_PANE: "w0:pX",
  YOKEMATE_MODE: "review",
  YOKEMATE_TICKET: "YM-0",
  HERDR_PANE_ID: "wT:p9",
};

test("отчёт не уходит в главный чат чужого корня", async () => {
  const tmp = makeTmp();
  const env = { ...PANE_ENV, XDG_RUNTIME_DIR: tmp };
  const dir = socketDir(env, 0);
  try {
    mkdirSync(dir, { recursive: true });
    const got: Report[] = [];
    const alien = await bindInbox(
      dir,
      "wA:p1",
      { mode: "main", ticket: null, cwd: "/elsewhere", pid: 1 },
      (r) => got.push(r),
    );
    try {
      assert.deepEqual(await sendReport(env, 0, "проба", undefined, 200, "/root"), {
        ok: false,
        line: "unreachable: ENOENT",
      });
      assert.deepEqual(got, []);
    } finally {
      closeInbox(dir, alien);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("при двух главных чатах своего корня отчёт никуда не уходит", async () => {
  const tmp = makeTmp();
  const env = { ...PANE_ENV, XDG_RUNTIME_DIR: tmp };
  const dir = socketDir(env, 0);
  try {
    mkdirSync(dir, { recursive: true });
    const got: Report[] = [];
    const side = { mode: "main", ticket: null, cwd: "/root", pid: 1 };
    const one = await bindInbox(dir, "wA:p1", side, (r) => got.push(r));
    const two = await bindInbox(dir, "wB:p1", side, (r) => got.push(r));
    try {
      const r = await sendReport(env, 0, "проба", undefined, 200, "/root");
      assert.equal(r.ok, false);
      assert.match(r.line, /главных чатов корня больше одного/);
      assert.deepEqual(got, []);
    } finally {
      closeInbox(dir, one);
      closeInbox(dir, two);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("scanMains lists only live-shaped mains, sorted, without self", () => {
  const tmp = makeTmp();
  try {
    assert.deepEqual(scanMains(join(tmp, "absent"), undefined, "/root"), []);
    writeSidecar(tmp, "wC:p1", { mode: "main", ticket: null, cwd: "/root", pid: 3 });
    writeSidecar(tmp, "wA:p1", { mode: "main", ticket: null, cwd: "/root", pid: 1 });
    writeSidecar(tmp, "wB:p1", { mode: "ship", ticket: "YM-1", cwd: "/root", pid: 2 });
    writeFileSync(sidecarPath(tmp, "wD:p1"), "{ not json");
    assert.deepEqual(
      scanMains(tmp, "wA:p1", "/root").map((c) => c.pane),
      ["wC:p1"],
    );
    assert.deepEqual(
      scanMains(tmp, undefined, "/root").map((c) => c.pane),
      ["wA:p1", "wC:p1"],
    );
    assert.deepEqual(scanMains(tmp, "wA:p1", "/root")[0], {
      pane: "wC:p1",
      sock: socketPath(tmp, "wC:p1"),
      json: sidecarPath(tmp, "wC:p1"),
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("scanMains не берёт главный чат чужого корня", () => {
  const tmp = makeTmp();
  try {
    writeSidecar(tmp, "wA:p1", { mode: "main", ticket: null, cwd: "/root", pid: 1 });
    writeSidecar(tmp, "wB:p1", { mode: "main", ticket: null, cwd: "/elsewhere", pid: 2 });
    assert.deepEqual(
      scanMains(tmp, undefined, "/root").map((c) => c.pane),
      ["wA:p1"],
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("allowTarget frees the main chat and fences a stamped pane", () => {
  const main = {};
  const pane = { YOKEMATE_MODE: "review", YOKEMATE_PARENT_PANE: "w4:p1" };
  assert.deepEqual(allowTarget(main, undefined, []), { ok: true });
  assert.deepEqual(allowTarget(main, "w9:p9", []), { ok: true });
  assert.deepEqual(allowTarget(pane, undefined, []), { ok: true });
  assert.deepEqual(allowTarget(pane, "w4:p1", []), { ok: true });
  assert.deepEqual(allowTarget(pane, "w7:p2", ["w7:p2"]), { ok: true });
  const denied = allowTarget(pane, "w7:p2", ["w8:p3"]);
  assert.equal(denied.ok, false);
  assert.match(
    (denied as { reason: string }).reason,
    /только родителю или главному чату/,
  );
});
