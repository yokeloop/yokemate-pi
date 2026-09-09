// home/pool.json: the model of a launch that has no ticket to ask a passport
// about. Nothing in src/ may answer with a literal instead, so every gap here
// is a refusal — and each refusal has to name the file and what to write in it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { poolModel, poolPath, readPool } from "../src/pool.ts";

function makeRoot(pool?: string): string {
  const root = mkdtempSync(join(tmpdir(), "pool-"));
  if (pool !== undefined) writeFileSync(join(root, "pool.json"), pool);
  return root;
}

test("the pool map answers the ticketless modes, each with its own model", () => {
  const root = makeRoot('{"plan": "astra", "note": "terra"}\n');
  try {
    assert.equal(poolPath(root), join(root, "pool.json"));
    assert.deepEqual(readPool(root), { plan: "astra", note: "terra" });
    assert.equal(poolModel(root, "plan"), "astra");
    assert.equal(poolModel(root, "note"), "terra");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a mode missing from the pool refuses, naming the mode and the file", () => {
  const root = makeRoot('{"plan": "astra"}\n');
  try {
    assert.throws(() => poolModel(root, "note"), (e: Error) => {
      assert.match(e.message, /no note model/);
      assert.match(e.message, /pool\.json/);
      assert.match(e.message, /"note": "<pattern>"/);
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no pool.json at all refuses, naming the file and its shape", () => {
  const root = makeRoot();
  try {
    assert.throws(() => poolModel(root, "plan"), (e: Error) => {
      assert.match(e.message, /no pool\.json in /);
      assert.match(e.message, /"plan": "<pattern>"/);
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a hand-edited pool.json is refused, not quietly half-read", () => {
  for (const [pool, pattern] of [
    ["не json", /not valid JSON/],
    ['["plan"]', /expected an object/],
    ["null", /expected an object/],
    ['{"staging": "astra"}', /unknown mode "staging" — the panel modes are: plan, review, do, ship, worklog, note/],
    ['{"plan": ""}', /"plan" must be a model pattern string/],
    ['{"plan": 7}', /"plan" must be a model pattern string/],
  ] as const) {
    const root = makeRoot(pool);
    try {
      assert.throws(() => readPool(root), pattern, `pool.json ${pool}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
