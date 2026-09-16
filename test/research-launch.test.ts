import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { researchAgentArgs, resolveResearchContext, resolveResearchLaunch } from "../src/research-launch.ts";

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

test("research launch keeps the closed extension argv and typed diagnostics template", () => {
  const root = join(import.meta.dirname, "..");
  const args = researchAgentArgs(root, "model");
  assert.deepEqual(args, ["--model", "model", "--skill", join(root, ".pi", "skills"), "--no-extensions", "--no-builtin-tools", "-e", join(root, "src", "research.ts")]);
  assert.equal(args.includes("--no-tools"), false);
  assert.equal(args.includes("--tools"), false);
  assert.equal(args.filter((arg) => arg === "-e").length, 1);
  const prompt = readFileSync(join(root, ".pi", "prompts", "research.md"), "utf8");
  assert.match(prompt, /On success, return its one output line unchanged/);
  assert.match(prompt, /On failure, return the full relevant multiline CLI diagnostics unchanged/);
  assert.match(prompt, /pnpm research \$@/);
});

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

test("project-only research waits without a synthetic topic while explicit topics launch immediately", () => {
  const { root } = fixture();
  try {
    for (const args of [["app"], ["--project", "app"]]) {
      const context = resolveResearchContext(root, args);
      assert.equal(context.project?.repo, "app");
      assert.equal(context.topic, "");
      assert.equal(resolveResearchLaunch(root, args).prompt, "/skill:research-worker");
    }
    assert.equal(resolveResearchLaunch(root, ["app", "audit"]).prompt, "/skill:research-worker audit");
    for (const args of [[], ["--topic"], ["--topic", " "]]) {
      assert.throws(() => resolveResearchContext(root, args), /usage: research/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("research worker waits for the engineer's question before reading or reporting", () => {
  const root = join(import.meta.dirname, "..");
  const worker = readFileSync(join(root, ".pi", "skills", "research-worker", "SKILL.md"), "utf8");
  assert.match(worker, /Run `pnpm where research` first/);
  assert.match(worker, /Without a topic, perform only the mandatory mode check above/);
  assert.match(worker, /confirm that the selected project is connected and wait for the engineer's question/);
  assert.match(worker, /Until the next message, do not read the clone or knowledge, create artifacts, or call `send_message`/);
  assert.match(worker, /Use the engineer's next question as the topic and follow the research flow below/);
  assert.match(worker, /With an explicit topic, start the research flow below immediately/);
  assert.doesNotMatch(worker, /обзор проекта/);
  assert.doesNotMatch(readFileSync(join(root, "src", "research-launch.ts"), "utf8"), /обзор проекта/);
});
