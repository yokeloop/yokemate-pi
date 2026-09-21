import { test } from "node:test";
import assert from "node:assert/strict";
import { processStarttime } from "../src/coordinator-control.ts";
import { observePlanProcess, observeProcess, type ProcessObservation } from "../src/plan-lifecycle.ts";

test("process observation requires positive exit evidence", () => {
  const starttime = processStarttime(process.pid)!;
  assert.equal(observeProcess({ pid: process.pid, starttime }), "live");
  assert.equal(observeProcess({ pid: process.pid, starttime: `${starttime}-reused` }), "exited");
  assert.equal(observeProcess({ pid: 2_000_000_000, starttime: "missing" }), "exited");
});

test("plan process observer ignores unknown/live and emits one exit", async () => {
  const observations: ProcessObservation[] = ["unknown", "live", "unknown", "exited", "exited"];
  let exits = 0;
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
  observePlanProcess({ pid: 1, starttime: "one" }, () => { exits += 1; resolveExit(); }, {
    probe: () => observations.shift() ?? "exited",
    wait: async () => {},
  });
  await exited;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(exits, 1);
});

test("stopping an observer fences a late probe", async () => {
  let releaseProbe!: (value: ProcessObservation) => void;
  const probe = new Promise<ProcessObservation>((resolve) => { releaseProbe = resolve; });
  let exits = 0;
  const observer = observePlanProcess({ pid: 1, starttime: "one" }, () => { exits += 1; }, {
    probe: () => probe,
    wait: async () => {},
  });
  observer.stop();
  releaseProbe("exited");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(exits, 0);
});
