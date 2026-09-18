import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { githubPublicationAdapter } from "../src/github.ts";
import { PublicationFailure } from "../src/plan-publication.ts";
import { resolvePublicationTarget } from "../src/plan-publication-target.ts";
import { DefaultResourceLoader, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

test("target resolver accepts same YouTrack server rows and rejects ambiguous or non-github origins", () => {
  const root = mkdtempSync(join(tmpdir(), "publication-target-"));
  try {
    const db = openDb(join(root, "db"));
    db.prepare("INSERT INTO project(org,repo,path,tracker,tracker_key,model) VALUES(?,?,?,?,?,?)").run("org", "one", "/one", "acme", "ACME", "m");
    db.prepare("INSERT INTO project(org,repo,path,tracker,tracker_key,model) VALUES(?,?,?,?,?,?)").run("org", "two", "/two", "acme", "ACME", "m");
    const youtrack = resolvePublicationTarget(db, "ACME-7");
    assert.equal(youtrack.type, "youtrack");
    assert.equal(youtrack.target, "youtrack-acme:ACME-7");
    db.prepare("UPDATE project SET tracker='github' WHERE repo='two'").run();
    assert.throws(() => resolvePublicationTarget(db, "ACME-7"), /conflicting/);
    db.prepare("DELETE FROM project").run();
    db.prepare("INSERT INTO project(org,repo,path,tracker,tracker_key,model) VALUES(?,?,?,?,?,?)").run("local", "name", "/clone", "github", "GH", "m");
    assert.throws(() => resolvePublicationTarget(db, "GH-2", () => "git@gitlab.example:owner/repo.git"), /github.com/);
    const github = resolvePublicationTarget(db, "GH-2", () => "git@github.com:Actual/Remote.git");
    assert.equal(github.type, "github");
    assert.equal(github.target, "github:Actual/Remote#2");
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("GitHub adapter paginates to an empty page and posts through body-file stdin", async () => {
  const calls: { args: string[]; input?: string }[] = [];
  const values = Array.from({ length: 205 }, (_, index) => ({ id: index + 1, body: `comment-${index + 1}`, html_url: `https://github.com/o/r/issues/2#issuecomment-${index + 1}` }));
  const adapter = githubPublicationAdapter({ owner: "o", repo: "r", issueNumber: 2, clonePath: "/clone" }, (args, options) => {
    calls.push({ args, input: options.input });
    if (args[0] === "api") {
      const page = Number(/&page=(\d+)/.exec(args[1]!)![1]);
      return JSON.stringify(values.slice((page - 1) * 100, page * 100));
    }
    return "ok";
  });
  const comments = await adapter.list();
  assert.equal(comments.length, 205);
  assert.equal(calls.filter((call) => call.args[0] === "api").length, 4);
  await adapter.add("Unicode 🙂 body");
  const post = calls.at(-1)!;
  assert.deepEqual(post.args, ["issue", "comment", "2", "--repo", "o/r", "--body-file", "-"]);
  assert.equal(post.input, "Unicode 🙂 body");
});

test("GitHub executable fixture paginates, accepts Unicode stdin and exposes stable remote facts", async () => {
  const root = mkdtempSync(join(tmpdir(), "publication-gh-"));
  const prior = { ...process.env };
  try {
    const bin = join(root, "bin");
    const clone = join(root, "clone");
    const state = join(root, "state.json");
    const log = join(root, "log.json");
    mkdirSync(bin);
    mkdirSync(clone);
    symlinkSync(join(import.meta.dirname, "fixtures/plan-publication-gh.mjs"), join(bin, "gh"));
    writeFileSync(state, JSON.stringify(Array.from({ length: 101 }, (_, index) => ({ id: index + 1, body: `comment-${index + 1}`, html_url: `https://github.com/o/r/issues/2#issuecomment-${index + 1}` }))));
    writeFileSync(log, "[]");
    Object.assign(process.env, { PATH: `${bin}:${prior.PATH ?? ""}`, YM216_GH_STATE: state, YM216_GH_LOG: log });
    const adapter = githubPublicationAdapter({ owner: "o", repo: "r", issueNumber: 2, clonePath: clone });
    assert.equal((await adapter.list()).length, 101);
    await adapter.add("Unicode 🙂 publication");
    const comments = await adapter.list();
    assert.equal(comments.length, 102);
    assert.equal(comments.at(-1)?.text, "Unicode 🙂 publication");
    const calls = JSON.parse(readFileSync(log, "utf8")) as { args: string[]; body?: string }[];
    const post = calls.find((call) => call.args[0] === "issue")!;
    assert.deepEqual(post.args, ["issue", "comment", "2", "--repo", "o/r", "--body-file", "-"]);
    assert.equal(post.body, "Unicode 🙂 publication");
    assert.ok(calls.filter((call) => call.args[0] === "api").length >= 6);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
    Object.assign(process.env, prior);
    rmSync(root, { recursive: true, force: true });
  }
});

test("private YouTrack bridge uses the real pinned adapter, exact schemas and pagination", { timeout: 30000 }, async () => {
  const source = join(import.meta.dirname, "..");
  const root = mkdtempSync(join(tmpdir(), "publication-mcp-"));
  const comments = join(root, "comments.json");
  const result = join(root, "result.json");
  const prior = { ...process.env };
  let extension: any;
  let ctx: ExtensionContext | undefined;
  try {
    mkdirSync(join(root, ".pi"), { recursive: true });
    symlinkSync(join(source, "node_modules"), join(root, "node_modules"), "dir");
    writeFileSync(comments, JSON.stringify(Array.from({ length: 23 }, (_, index) => ({ ...(index ? { id: String(index + 1) } : {}), text: `comment-${index + 1}`, author: "fixture", url: `https://tracker.example/comment/${index + 1}`, createdAt: index ? "2026-01-01" : 1789724993409 }))));
    const connectMarker = join(root, "connect-failed-once");
    const serverStarts = join(root, "server-starts");
    writeFileSync(join(root, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { "youtrack-fixture": { command: process.execPath, args: [join(source, "test/fixtures/plan-publication-mcp-flaky.mjs")], env: { YM216_COMMENTS: comments, YM216_CONNECT_MARKER: connectMarker, YM216_SERVER_STARTS: serverStarts } } }, settings: {} }));
    Object.assign(process.env, { YM216_ROOT: root, YM216_RESULT: result, YM216_COMMENTS: comments, YM216_RETRY_CONNECT: "1", YM216_PARALLEL_CONNECT: "1" });
    const host = join(source, "test/fixtures/plan-publication-adapter-host.mjs");
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, "agent"), settingsManager: SettingsManager.create(root, join(root, "agent")), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [host] });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    extension = loaded.extensions.find((item) => item.resolvedPath === host)!;
    ctx = { cwd: root, mode: "rpc", hasUI: false, sessionManager: { getSessionId: () => "fixture-session" }, modelRegistry: { getAll: () => [], hasConfiguredAuth: () => false }, ui: { setStatus() {}, setWidget() {}, notify() {} } } as unknown as ExtensionContext;
    for (const handler of extension.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" } as never, ctx);
    const value = JSON.parse(readFileSync(result, "utf8"));
    assert.deepEqual(value, { canonicalUrl: "https://tracker.example/issue/YM-216", before: 23, after: 24, tail: "Unicode 🙂 publication" });
    assert.equal(readFileSync(connectMarker, "utf8"), "failed-once");
    assert.equal(readFileSync(serverStarts, "utf8"), "1");
  } finally {
    if (extension && ctx) for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" } as never, ctx);
    for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
    Object.assign(process.env, prior);
    rmSync(root, { recursive: true, force: true });
  }
});

test("real MCP tool errors preserve 403, 429 and 413 classifications", { timeout: 30000 }, async () => {
  const source = join(import.meta.dirname, "..");
  for (const [status, code] of [[403, "permission"], [429, "rate_limit"], [413, "size"]] as const) {
    const root = mkdtempSync(join(tmpdir(), `publication-mcp-${status}-`));
    const comments = join(root, "comments.json");
    const result = join(root, "result.json");
    const prior = { ...process.env };
    let extension: any;
    let ctx: ExtensionContext | undefined;
    try {
      mkdirSync(join(root, ".pi"), { recursive: true });
      symlinkSync(join(source, "node_modules"), join(root, "node_modules"), "dir");
      writeFileSync(comments, "[]");
      writeFileSync(join(root, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { "youtrack-fixture": { command: process.execPath, args: [join(source, "test/fixtures/plan-publication-mcp-server.mjs")], env: { YM216_COMMENTS: comments, YM216_MCP_ERROR: String(status) } } }, settings: {} }));
      Object.assign(process.env, { YM216_ROOT: root, YM216_RESULT: result, YM216_COMMENTS: comments, YM216_EXPECT_ERROR: "1" });
      const host = join(source, "test/fixtures/plan-publication-adapter-host.mjs");
      const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, "agent"), settingsManager: SettingsManager.create(root, join(root, "agent")), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [host] });
      await loader.reload();
      const loaded = loader.getExtensions();
      assert.deepEqual(loaded.errors, []);
      extension = loaded.extensions.find((item) => item.resolvedPath === host)!;
      ctx = { cwd: root, mode: "rpc", hasUI: false, sessionManager: { getSessionId: () => `fixture-${status}` }, modelRegistry: { getAll: () => [], hasConfiguredAuth: () => false }, ui: { setStatus() {}, setWidget() {}, notify() {} } } as unknown as ExtensionContext;
      for (const handler of extension.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" } as never, ctx);
      assert.deepEqual(JSON.parse(readFileSync(result, "utf8")), { error: code });
    } finally {
      if (extension && ctx) for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" } as never, ctx);
      for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
      Object.assign(process.env, prior);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("GitHub adapter fails closed on malformed and classified failures", async () => {
  const malformed = githubPublicationAdapter({ owner: "o", repo: "r", issueNumber: 1, clonePath: "/clone" }, () => "not-json");
  await assert.rejects(() => malformed.list(), (error: unknown) => error instanceof PublicationFailure && error.code === "incomplete_listing");
  for (const code of ["auth", "permission", "rate_limit", "size", "unavailable"] as const) {
    const failed = githubPublicationAdapter({ owner: "o", repo: "r", issueNumber: 1, clonePath: "/clone" }, () => { throw { publicationCode: code, stderr: "private response" }; });
    await assert.rejects(() => failed.list(), (error: unknown) => error instanceof PublicationFailure && error.code === code);
  }
});
