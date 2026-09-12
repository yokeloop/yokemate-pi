import { test } from "node:test";
import assert from "node:assert/strict";
import { formatHerdrError, herdr, herdrRaw, runHerdr, startAgent } from "../src/herdr.ts";

function spawn(result: Record<string, unknown>) {
  return (_command: string, _args: string[], _options: Record<string, unknown>) => ({ status: 0, signal: null, ...result });
}

test("herdr preserves raw streams, status, signal, and subprocess cause", () => {
  const cause = new Error("ENOENT");
  assert.throws(() => runHerdr(["pane", "read", "p"], {}, spawn({ status: 1, stdout: Buffer.from("out\n"), stderr: Buffer.from("err\n"), error: cause })), (error: Error) => {
    assert.match(error.message, /ENOENT/);
    assert.match(formatHerdrError(error), /out\n/);
    assert.match(formatHerdrError(error), /err\n/);
    assert.equal(error.cause, cause);
    return true;
  });
  assert.throws(() => runHerdr(["pane", "read", "p"], {}, spawn({ status: null, signal: "SIGTERM", stdout: "tail\n" })), /signal SIGTERM/);
});

test("raw herdr output does not parse JSON and malformed JSON retains streams", () => {
  const raw = herdrRaw(["pane", "read", "p"], {}, spawn({ stdout: Buffer.from("terminal\n"), stderr: Buffer.from("warn\n") }));
  assert.equal(raw, "terminal\n");
  assert.throws(() => herdr(["agent", "list"], spawn({ stdout: "not json\n", stderr: "diagnostic\n" })), (error: Error) => {
    assert.match(error.message, /malformed JSON/);
    assert.match(formatHerdrError(error), /not json/);
    assert.match(formatHerdrError(error), /diagnostic/);
    return true;
  });
});

test("startAgent retries busy diagnostics from stdout or stderr and preserves another failure", () => {
  let attempts = 0;
  startAgent("r", "p", "r", [], () => {
    attempts++;
    if (attempts < 3) throw Object.assign(new Error("failed"), { stdout: attempts === 1 ? "agent_pane_busy" : "", stderr: attempts === 2 ? "agent_pane_busy" : "" });
  }, 20, 0);
  assert.equal(attempts, 3);
  const primary = Object.assign(new Error("primary"), { stdout: "out", stderr: "err" });
  assert.throws(() => startAgent("r", "p", "r", [], () => { throw primary; }, 20, 0), (error) => error === primary);
});
