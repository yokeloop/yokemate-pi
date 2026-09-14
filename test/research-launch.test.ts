import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveResearchContext, resolveResearchLaunch } from "../src/research-launch.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "research-launch-"));
  mkdirSync(join(root, "home"));
  writeFileSync(join(root, "home", "pool.json"), '{"research":"pool"}');
  const clone = join(root, "clone"); mkdirSync(clone);
  const db = new DatabaseSync(join(root, "yokemate.db"));
  db.exec("CREATE TABLE project (org TEXT, repo TEXT, path TEXT, tracker TEXT, tracker_key TEXT, subsystem TEXT, model TEXT, mode_models TEXT)");
  db.prepare("INSERT INTO project VALUES ('acme','app',?,'youtrack','ACME',NULL,'default','{\"research\":\"override\"}')").run(clone);
  db.close();
  return { root, clone };
}

test("research resolves canonical project aliases and topic without a ticket", () => {
  const { root } = fixture();
  try {
    for (const token of ["acme/app", "app", "acme"]) {
      const r = resolveResearchContext(root, [token, "audit"]);
      assert.equal(r.project?.repo, "app");
      assert.equal(r.topic, "audit");
      assert.equal(r.model, "override");
    }
    assert.equal(resolveResearchContext(root, ["YM-198", "topic"]).project, null);
    assert.equal(resolveResearchContext(root, ["--topic", "app", "topic"]).project, null);
    const launch = resolveResearchLaunch(root, ["app"] , "12345678-1234-1234-1234-123456789abc");
    assert.match(launch.agentName, /^research-12345678$/);
    assert.equal(launch.env.some((v) => v.startsWith("YOKEMATE_TICKET=")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("research shares surface controls without changing topic or security argv", async () => {
  const { parseResearchArgs, researchAgentArgs } = await import("../src/research-launch.ts");
  const { root } = fixture();
  try {
    assert.equal(resolveResearchLaunch(root, ["--topic", "audit"]).surface, "tab");
    const split = resolveResearchLaunch(root, ["--split", "app", "--model", "explicit", "audit"]);
    assert.equal(split.surface, "split");
    assert.equal(split.model, "explicit");
    assert.equal(split.prompt, "/skill:research-worker audit");
    for (const tail of [["--split"], ["--model", "x"], ["--project", "app", "--topic", "--"], ["app"]]) {
      const launch = resolveResearchLaunch(root, ["--", ...tail]);
      assert.equal(launch.surface, "tab");
      assert.equal(launch.model, "pool");
      assert.equal(launch.project, null);
      assert.equal(launch.topic, tail.join(" "));
    }
    assert.throws(() => parseResearchArgs(["--unknown"]), /unknown research option --unknown/);
    assert.throws(() => parseResearchArgs(["--model"]), /--model needs a value/);
    assert.throws(() => parseResearchArgs(["--project"]), /--project needs/);
    assert.equal(parseResearchArgs(["--project", "--split"]).project, "--split");
    assert.deepEqual(researchAgentArgs(root, "explicit"), ["--model", "explicit", "--skill", join(root, ".pi", "skills"), "--no-extensions", "--no-tools", "-e", join(root, "src", "research.ts")]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
