import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDir, socketDir } from "../src/inbox.ts";

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
