import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPublishable, COMMENT_BUDGET, normalizeScoutMarkdown, PublicationFailure, publishDocument, reconcilePublication, splitPublication, type RemoteComment } from "../src/plan-publication.ts";
import { sha256 } from "../src/subagent-runs.ts";
import type { PublicationRow } from "../src/plan-publication-state.ts";

function input(text: string, run = "run-one") {
  const bytes = Buffer.from(text);
  return { target: "youtrack-yokeloop:YM-216", targetHash: sha256("youtrack-yokeloop:YM-216"), canonicalUrl: "https://tracker.example/issue/YM-216", ticket: "YM-216", run, kind: "scout" as const, hash: sha256(bytes), bytes };
}

function row(text: string): { row: PublicationRow; bytes: Buffer } {
  const value = input(text);
  return { bytes: value.bytes, row: { id: 1, target: value.target, target_hash: value.targetHash, canonical_url: value.canonicalUrl, ticket: value.ticket, kind: "scout", content_hash: value.hash, artifact_path: "/fixture", bytes: value.bytes.length, run_id: value.run, owner_run_id: null, owner_session_id: null, batch_id: null, task_hash: null, plan_path: null, scope_hash: null, scout_publication: null, successful_record: 0, complete: 0, error_code: null, side_effects_started: 0 } };
}

test("publication framing is lossless, stable and inside the byte budget", () => {
  const text = "\uFEFF# Report\r\n\r\n```ts\r\n" + "🙂".repeat(10_000) + "\r\n```\r\n\r\n<!-- yokemate-plan-publication:{not framing} -->\r\n";
  const bytes = normalizeScoutMarkdown(text);
  const framed = splitPublication({ ...input(bytes.toString()), bytes, hash: sha256(bytes) });
  assert.ok(framed.length > 1);
  assert.ok(framed.every((part) => Buffer.byteLength(part.body) <= COMMENT_BUDGET));
  assert.deepEqual(Buffer.concat(framed.map((part) => part.fragment)), bytes);
  assert.equal(reconcilePublication({ ...input(bytes.toString()), bytes, hash: sha256(bytes) }, framed.map((part) => ({ id: String(part.part), text: part.body }))).complete, true);
});

test("remote trimming of one trailing newline is restored only when metadata proves the byte", () => {
  const value = input("# Plan\nbody\n");
  const framed = splitPublication(value);
  const trimmed = framed.map((part) => ({ id: String(part.part), text: part.body.slice(0, -1) }));
  const restored = reconcilePublication(value, trimmed);
  assert.equal(restored.complete, true);
  assert.deepEqual(Buffer.concat(restored.parts.map((part) => part.fragment)), value.bytes);
  const overtrimmed = framed.map((part) => ({ id: String(part.part), text: part.body.slice(0, -2) }));
  assert.throws(() => reconcilePublication(value, overtrimmed), (error: unknown) => error instanceof PublicationFailure && error.code === "remote_conflict");
});

test("same content with a new run reconciles the original framing and partial writes append only missing parts", async () => {
  const text = "# Report\n" + "line value\n".repeat(5000);
  const first = splitPublication(input(text));
  const remote: RemoteComment[] = first.slice(0, -1).map((part) => ({ id: String(part.part), text: part.body }));
  const next = input(text, "run-two");
  const reconciled = reconcilePublication(next, remote);
  assert.equal(reconciled.missing.length, 1);
  assert.equal(reconciled.parts[0]!.run, "run-one");
  const document = row(text);
  document.row.run_id = "run-two";
  let adds = 0;
  const result = await publishDocument(document.row, document.bytes, { list: async () => remote, add: async (body) => { adds++; remote.push({ id: `new-${adds}`, text: body }); } }, { canonicalUrl: next.canonicalUrl });
  assert.equal(result.complete, true);
  assert.equal(adds, 1);
  const again = await publishDocument(document.row, document.bytes, { list: async () => remote, add: async () => { adds++; } }, { canonicalUrl: next.canonicalUrl });
  assert.equal(again.complete, true);
  assert.equal(adds, 1);
});

test("response loss reconciles before returning and conflicts fail closed", async () => {
  const text = "# Report\nbody\n";
  const document = row(text);
  const remote: RemoteComment[] = [];
  const accepted = await publishDocument(document.row, document.bytes, { list: async () => remote, add: async (body) => { remote.push({ id: "accepted", text: body }); throw new Error("lost response with private body"); } }, { canonicalUrl: input(text).canonicalUrl });
  assert.equal(accepted.complete, true);
  const conflict = [{ ...remote[0]!, text: remote[0]!.text + "changed" }];
  const blocked = await publishDocument(document.row, document.bytes, { list: async () => conflict, add: async () => assert.fail("must not post") }, { canonicalUrl: input(text).canonicalUrl });
  assert.equal(blocked.error, "remote_conflict");
});

test("binding is rechecked after the final remote listing", async () => {
  const document = row("# Report\nbody\n");
  const framed = splitPublication(input(document.bytes.toString()));
  let listings = 0;
  let changed = false;
  await assert.rejects(publishDocument(document.row, document.bytes, {
    list: async () => { listings++; if (listings === 2) changed = true; return framed.map((part) => ({ id: String(part.part), text: part.body })); },
    add: async () => assert.fail("complete remote must not post"),
  }, { canonicalUrl: input("body").canonicalUrl, verifyBinding: () => { if (changed) throw new PublicationFailure("binding_changed"); } }), (error: unknown) => error instanceof PublicationFailure && error.code === "binding_changed");
});

test("remote target changes are pending while local binding failures remain blocking", async () => {
  const document = row("# body\n");
  let posts = 0;
  const remote = await publishDocument(document.row, document.bytes, {
    list: async () => [],
    add: async () => { posts++; },
  }, { canonicalUrl: input("body").canonicalUrl, verifyBinding: () => { throw new PublicationFailure("target_changed"); } });
  assert.equal(remote.complete, false);
  assert.equal(remote.error, "target_changed");
  assert.equal(posts, 0);
  await assert.rejects(publishDocument(document.row, document.bytes, {
    list: async () => [],
    add: async () => { posts++; },
  }, { canonicalUrl: input("body").canonicalUrl, verifyBinding: () => { throw new PublicationFailure("binding_changed"); } }), (error: unknown) => error instanceof PublicationFailure && error.code === "binding_changed");
  assert.equal(posts, 0);
});

test("binding changes stop multipart publication before the next remote write", async () => {
  const text = "# Report\n" + "line value\n".repeat(5000);
  const document = row(text);
  const remote: RemoteComment[] = [];
  let posts = 0;
  let changed = false;
  await assert.rejects(publishDocument(document.row, document.bytes, {
    list: async () => remote,
    add: async (body) => { posts++; remote.push({ id: String(posts), text: body }); changed = true; },
  }, { canonicalUrl: input(text).canonicalUrl, verifyBinding: () => { if (changed) throw new PublicationFailure("binding_changed"); } }), (error: unknown) => error instanceof PublicationFailure && error.code === "binding_changed");
  assert.equal(posts, 1);
});

test("classified POST failures survive mandatory response-loss reconciliation", async () => {
  const document = row("# Report\nbody\n");
  for (const code of ["auth", "permission", "rate_limit", "size"] as const) {
    const result = await publishDocument(document.row, document.bytes, {
      list: async () => [],
      add: async () => { throw new PublicationFailure(code); },
    }, { canonicalUrl: input("body").canonicalUrl });
    assert.equal(result.error, code);
  }
});

test("credential sentinels block the whole document before the first post and placeholders remain allowed", async () => {
  const sentinels = [
    "-----BEGIN PRIVATE KEY-----", "Authorization: Bearer abcdef", "Cookie: session=abcdef",
    "github_pat_abcdefghijklmnopqrstuvwxyz", "https://user:password@example.test/path", "https://literal-secret@example.test/path", "https://example.test/?access_token=value", "client_secret = literal-value",
    "const token = \"literal-secret-value\"", "- token: literal-secret-value", "{\"password\":\"literal-secret-value\"}",
  ];
  for (const sentinel of sentinels) {
    const text = `# Safe beginning\n${"x".repeat(30_000)}\n${sentinel}`;
    const document = row(text);
    let posts = 0;
    await assert.rejects(publishDocument(document.row, document.bytes, { list: async () => [], add: async () => { posts++; } }, { canonicalUrl: input(text).canonicalUrl }), (error: unknown) => error instanceof PublicationFailure && error.code === "unsafe_document", sentinel);
    assert.equal(posts, 0, sentinel);
  }
  assert.doesNotThrow(() => assertPublishable(Buffer.from("token = ${TOKEN}\npassword: <example>\nsecret=[REDACTED]\nAuthorization: Bearer <TOKEN>\nhttps://example.test/?token=${TOKEN}\nhttps://${USERINFO}@example.test/path\nCookie: session=${SESSION}")));
  assert.throws(() => assertPublishable(Buffer.from("password=literal")), (error: unknown) => error instanceof PublicationFailure && error.code === "unsafe_document");
});
