import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..");
const PANE = "wT:p1";
const MARKER = "проба-e2e-7f3a";

function hasPi(): boolean {
  try {
    return spawnSync("pi", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

test("a report says delivered and reaches the pi session as a custom message", async (t) => {
  if (!hasPi()) return t.skip("pi not in PATH");

  const tmp = mkdtempSync(join(tmpdir(), "bus-e2e-"));
  const pi = spawn("pi", ["--mode", "rpc", "--no-session", "-e", "src/bus.ts"], {
    cwd: REPO_ROOT,
    env: {
      XDG_RUNTIME_DIR: tmp,
      HERDR_PANE_ID: PANE,
      PI_OFFLINE: "1",
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  pi.stdout.on("data", (c) => (out += c.toString("utf8")));

  try {
    const sock = join(tmp, "yokemate", `${PANE}.sock`);
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 60 && !existsSync(sock); i++) await wait(250);
    assert.equal(existsSync(sock), true, "the extension did not raise its inbox");

    const say = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "src/say.ts", MARKER],
      {
        cwd: REPO_ROOT,
        env: {
          XDG_RUNTIME_DIR: tmp,
          YOKEMATE_PARENT_PANE: PANE,
          YOKEMATE_MODE: "review",
          YOKEMATE_TICKET: "YM-0",
          HERDR_PANE_ID: "wT:p9",
          PATH: process.env.PATH ?? "",
        },
        encoding: "utf8",
      },
    );
    assert.equal(say.status, 0, say.stderr);
    assert.equal(say.stdout.trim(), "delivered");

    for (let i = 0; i < 40 && !out.includes("yokemate-report"); i++) await wait(250);
    const line = out
      .split("\n")
      .find((l) => l.includes('"customType":"yokemate-report"'));
    assert.ok(line, `no yokemate-report in the rpc stream:\n${out.slice(0, 2000)}`);
    const content = JSON.stringify(JSON.parse(line));
    assert.match(content, new RegExp(MARKER));
    assert.match(content, /YM-0/);
  } finally {
    pi.kill("SIGKILL");
    rmSync(tmp, { recursive: true, force: true });
  }
});
