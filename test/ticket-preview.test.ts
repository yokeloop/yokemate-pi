import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  ISSUE_PREVIEW_FIELDS,
  IssuePreviewFetchError,
  fetchIssuePreview,
} from "../src/youtrack.ts";
import {
  formatTicketPreview,
  loadTicketPreview,
  registerTicketPreview,
  type TicketPreviewLoadResult,
} from "../src/ticket-preview.ts";

const tracker = { kind: "youtrack", name: "yokeloop", baseUrl: "https://yt.example", token: "token-secret" } as const;
const preview = { idReadable: "YM-225", summary: "Startup preview", description: "# Context\n\nBody\n\nLAST-CONTROL-PARAGRAPH" };

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function passport(root: string, trackerName = "yokeloop"): void {
  const db = new DatabaseSync(join(root, "yokemate.db"));
  db.exec("CREATE TABLE project (tracker TEXT NOT NULL, tracker_key TEXT NOT NULL)");
  db.prepare("INSERT INTO project (tracker, tracker_key) VALUES (?, 'YM')").run(trackerName);
  db.close();
}

function restoreEnv(previous: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
}

test("fetchIssuePreview asks for the exact preview fields, encoded key and standard headers", async () => {
  let calls = 0;
  const result = await fetchIssuePreview(tracker, "YM/225", (async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.pathname, "/api/issues/YM%2F225");
    assert.equal(url.searchParams.get("fields"), ISSUE_PREVIEW_FIELDS);
    assert.deepEqual(init?.headers, { Authorization: "Bearer token-secret", Accept: "application/json" });
    assert.ok(init?.signal instanceof AbortSignal);
    return response(200, { ...preview, idReadable: "YM/225" });
  }) as typeof fetch, 100);
  assert.equal(calls, 1);
  assert.deepEqual(result, { ...preview, idReadable: "YM/225" });
});

test("fetchIssuePreview preserves full Markdown and normalizes missing description", async () => {
  const long = `${"paragraph\n\n".repeat(2000)}LAST-CONTROL-PARAGRAPH`;
  const full = await fetchIssuePreview(tracker, "YM-225", (async () => response(200, { ...preview, description: long })) as typeof fetch, 100);
  assert.equal(full?.description, long);
  const missing = await fetchIssuePreview(tracker, "YM-225", (async () => response(200, { idReadable: "YM-225", summary: "No body" })) as typeof fetch, 100);
  assert.equal(missing?.description, null);
  assert.equal(await fetchIssuePreview(tracker, "YM-404", (async () => response(404, { secret: "raw-body-secret" })) as typeof fetch, 100), null);
});

test("fetchIssuePreview classifies HTTP, network and JSON failures without retrying", async () => {
  for (const [kind, fetchImpl] of [
    ["http", async () => response(401, { token: "raw-body-secret" })],
    ["http", async () => response(500, { token: "raw-body-secret" })],
    ["network", async () => { throw new Error("network sentinel-secret"); }],
    ["json", async () => ({ ok: true, status: 200, json: async () => { throw new Error("json sentinel-secret"); } }) as unknown as Response],
    ["json", async () => response(200, { idReadable: 1, summary: "bad" })],
  ] as const) {
    let calls = 0;
    await assert.rejects(
      () => fetchIssuePreview(tracker, "YM-225", (async (...args: Parameters<typeof fetch>) => {
        calls++;
        return (fetchImpl as unknown as typeof fetch)(...args);
      }) as typeof fetch, 100),
      (error: unknown) => error instanceof IssuePreviewFetchError && error.kind === kind,
    );
    assert.equal(calls, 1);
  }
});

test("fetchIssuePreview bounds both fetch and body reads, aborts, and ignores late success", async () => {
  for (const stage of ["fetch", "body"] as const) {
    let calls = 0;
    let aborted = false;
    let resolveLate: ((value: Response) => void) | undefined;
    const fetchImpl = (async (_input, init) => {
      calls++;
      init?.signal?.addEventListener("abort", () => { aborted = true; });
      if (stage === "body") return { ok: true, status: 200, json: () => new Promise(() => undefined) } as Response;
      return new Promise<Response>((resolve) => { resolveLate = resolve; });
    }) as typeof fetch;
    const started = Date.now();
    await assert.rejects(
      () => fetchIssuePreview(tracker, "YM-225", fetchImpl, 15),
      (error: unknown) => error instanceof IssuePreviewFetchError && error.kind === "timeout",
    );
    assert.ok(Date.now() - started < 250);
    assert.equal(aborted, true);
    resolveLate?.(response(200, preview));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1);
  }
});

test("formatTicketPreview keeps nonempty descriptions byte-for-byte and labels every empty form", () => {
  const content = formatTicketPreview({ status: "success", preview });
  assert.equal(content, `## YM-225 — Startup preview\n\n${preview.description}`);
  assert.ok(content.endsWith("LAST-CONTROL-PARAGRAPH"));
  for (const description of [null, "", " \n\t"] as const) {
    assert.equal(
      formatTicketPreview({ status: "success", preview: { ...preview, description } }),
      "## YM-225 — Startup preview\n\nОписание отсутствует",
    );
  }
  assert.equal(
    formatTicketPreview({ status: "error", ticket: "YM-225", reason: "YouTrack не ответил за 5 секунд" }),
    "## YM-225\n\nНе удалось загрузить описание задачи: YouTrack не ответил за 5 секунд. Запуск режима продолжается.",
  );
});

test("loadTicketPreview performs a read-only passport lookup, closes it, and maps the tracker alias", async () => {
  let closed = 0;
  let registryCalls = 0;
  let fetchCalls = 0;
  let prepared = "";
  const result = await loadTicketPreview("YM-225", {
    root: "/engine",
    openDatabase: (path, options) => {
      assert.equal(path, "/engine/yokemate.db");
      assert.deepEqual(options, { readOnly: true });
      return {
        prepare(sql: string) {
          prepared = sql;
          return { get: (key: string) => { assert.equal(key, "YM"); return { tracker: "yokeloop" }; } };
        },
        close() { closed++; },
      } as never;
    },
    trackerRegistry: () => { registryCalls++; return [tracker]; },
    fetchImpl: (async () => { fetchCalls++; return response(200, preview); }) as typeof fetch,
    timeoutMs: 100,
  });
  assert.deepEqual(result, { status: "success", preview });
  assert.match(prepared, /SELECT tracker FROM project WHERE tracker_key = \? LIMIT 1/);
  assert.equal(closed, 1);
  assert.equal(registryCalls, 1);
  assert.equal(fetchCalls, 1);
});

test("loadTicketPreview skips GitHub before registry and network access", async () => {
  let closed = 0;
  let registryCalls = 0;
  let fetchCalls = 0;
  const result = await loadTicketPreview("YM-225", {
    root: "/engine",
    openDatabase: () => ({ prepare: () => ({ get: () => ({ tracker: "github" }) }), close: () => { closed++; } }) as never,
    trackerRegistry: () => { registryCalls++; return [tracker]; },
    fetchImpl: (async () => { fetchCalls++; return response(200, preview); }) as typeof fetch,
  });
  assert.deepEqual(result, { status: "skip" });
  assert.equal(closed, 1);
  assert.equal(registryCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("loadTicketPreview does not create a missing database and returns bounded safe reasons", async () => {
  const root = mkdtempSync(join(tmpdir(), "ticket-preview-missing-"));
  try {
    const missing = join(root, "yokemate.db");
    const result = await loadTicketPreview("YM-225", { root });
    assert.deepEqual(result, { status: "error", ticket: "YM-225", reason: "не удалось прочитать паспорт проекта" });
    assert.equal(existsSync(missing), false);
  } finally { rmSync(root, { recursive: true, force: true }); }

  const cases: [string, Parameters<typeof loadTicketPreview>[1], string][] = [
    ["passport", { root: "/engine", openDatabase: () => ({ prepare: () => ({ get: () => undefined }), close: () => undefined }) as never }, "паспорт проекта не найден"],
    ["config", { root: "/engine", openDatabase: () => ({ prepare: () => ({ get: () => ({ tracker: "yokeloop" }) }), close: () => undefined }) as never, trackerRegistry: () => { throw new Error("config sentinel-secret"); } }, "конфигурация YouTrack недоступна"],
    ["alias", { root: "/engine", openDatabase: () => ({ prepare: () => ({ get: () => ({ tracker: "youtrack-yokeloop" }) }), close: () => undefined }) as never, trackerRegistry: () => [tracker] }, "конфигурация YouTrack недоступна"],
  ];
  for (const [, options, reason] of cases) {
    const result = await loadTicketPreview("YM-225", options);
    assert.deepEqual(result, { status: "error", ticket: "YM-225", reason });
    assert.doesNotMatch(JSON.stringify(result), /sentinel-secret|token-secret/);
  }
});

test("loadTicketPreview maps 404, HTTP, network, JSON and timeout failures to safe text", async () => {
  const root = mkdtempSync(join(tmpdir(), "ticket-preview-errors-"));
  passport(root);
  try {
    const cases: [string, typeof fetch, string][] = [
      ["404", (async () => response(404, { secret: "raw-body-secret" })) as typeof fetch, "задача не найдена в YouTrack"],
      ["401", (async () => response(401, { secret: "raw-body-secret" })) as typeof fetch, "YouTrack вернул HTTP 401"],
      ["500", (async () => response(500, { secret: "raw-body-secret" })) as typeof fetch, "YouTrack вернул HTTP 500"],
      ["network", (async () => { throw new Error("network sentinel-secret"); }) as typeof fetch, "не удалось связаться с YouTrack"],
      ["json", (async () => ({ ok: true, status: 200, json: async () => { throw new Error("json sentinel-secret"); } }) as unknown as Response) as typeof fetch, "YouTrack вернул некорректный ответ"],
      ["timeout", (async () => new Promise<Response>(() => undefined)) as typeof fetch, "YouTrack не ответил за 5 секунд"],
    ];
    for (const [, fetchImpl, reason] of cases) {
      const result = await loadTicketPreview("YM-225", { root, trackerRegistry: () => [tracker], fetchImpl, timeoutMs: 10 });
      assert.deepEqual(result, { status: "error", ticket: "YM-225", reason });
      assert.doesNotMatch(formatTicketPreview(result), /raw-body-secret|sentinel-secret|token-secret/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function extensionHarness(existing: unknown[] = []) {
  const entries = [...existing];
  const handlers: ((event: unknown, ctx: ExtensionContext) => Promise<void>)[] = [];
  const messages: { message: Record<string, unknown>; options: Record<string, unknown> }[] = [];
  const pi = {
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) { if (name === "session_start") handlers.push(handler); },
    sendMessage(message: Record<string, unknown>, options: Record<string, unknown>) {
      messages.push({ message, options });
      entries.push({ type: "custom_message", ...message });
    },
  } as never as ExtensionAPI;
  const ctx = { sessionManager: { getEntries: () => entries } } as never as ExtensionContext;
  return { pi, handlers, messages, entries, ctx };
}

async function withStamp(stamp: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const previous = { ...process.env };
  try {
    for (const [key, value] of Object.entries(stamp)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await run();
  } finally { restoreEnv(previous); }
}

test("plan and review handlers show success, empty, failure and timeout once without triggering a turn", async () => {
  const results: TicketPreviewLoadResult[] = [
    { status: "success", preview },
    { status: "success", preview: { ...preview, description: null } },
    { status: "error", ticket: "YM-225", reason: "не удалось связаться с YouTrack" },
    { status: "error", ticket: "YM-225", reason: "YouTrack не ответил за 5 секунд" },
  ];
  for (const mode of ["plan", "review"]) for (const result of results) {
    await withStamp({ YOKEMATE_MODE: mode, YOKEMATE_ROLE: "coordinator", YOKEMATE_TICKET: "YM-225" }, async () => {
      let loads = 0;
      const h = extensionHarness();
      registerTicketPreview(h.pi, { load: async () => { loads++; return result; } });
      await Promise.all([h.handlers[0]!({} as never, h.ctx), h.handlers[0]!({} as never, h.ctx)]);
      await h.handlers[0]!({} as never, h.ctx);
      assert.equal(loads, 1);
      assert.equal(h.messages.length, 1);
      assert.deepEqual(h.messages[0]!.options, { triggerTurn: false });
      assert.equal(h.messages[0]!.message.customType, "yokemate-ticket-preview");
      assert.equal(h.messages[0]!.message.display, true);
      assert.deepEqual(h.messages[0]!.message.details, { ticket: "YM-225", mode });
      assert.equal(typeof h.messages[0]!.message.content, "string");
    });
  }
});

test("handler eligibility rejects main, ticketless, other modes, executors, invalid and literal-only keys before I/O", async () => {
  const cases = [
    {},
    { YOKEMATE_MODE: "plan", YOKEMATE_ROLE: "coordinator" },
    { YOKEMATE_MODE: "do", YOKEMATE_ROLE: "coordinator", YOKEMATE_TICKET: "YM-225" },
    { YOKEMATE_MODE: "plan", YOKEMATE_ROLE: "executor", YOKEMATE_TICKET: "YM-225" },
    { YOKEMATE_MODE: "review", YOKEMATE_ROLE: "coordinator", YOKEMATE_TICKET: "YM-225+YM-226" },
    { YOKEMATE_MODE: "plan", YOKEMATE_ROLE: "coordinator", YOKEMATE_PLAN_LITERAL: '["YM-225"]' },
  ];
  for (const stamp of cases) await withStamp({ YOKEMATE_MODE: undefined, YOKEMATE_ROLE: undefined, YOKEMATE_TICKET: undefined, YOKEMATE_PLAN_LITERAL: undefined, ...stamp }, async () => {
    let loads = 0;
    const h = extensionHarness();
    registerTicketPreview(h.pi, { load: async () => { loads++; return { status: "success", preview }; } });
    await h.handlers[0]!({} as never, h.ctx);
    assert.equal(loads, 0);
    assert.equal(h.messages.length, 0);
  });
});

test("an existing success, empty or error marker suppresses I/O after extension reconstruction", async () => {
  for (const content of [preview.description, "Описание отсутствует", "Запуск режима продолжается."]) {
    await withStamp({ YOKEMATE_MODE: "plan", YOKEMATE_ROLE: "coordinator", YOKEMATE_TICKET: "YM-225" }, async () => {
      let loads = 0;
      const marker = { type: "custom_message", customType: "yokemate-ticket-preview", content, display: true, details: { ticket: "YM-225", mode: "plan" } };
      const h = extensionHarness([marker]);
      registerTicketPreview(h.pi, { load: async () => { loads++; return { status: "success", preview }; } });
      await h.handlers[0]!({} as never, h.ctx);
      assert.equal(loads, 0);
      assert.equal(h.messages.length, 0);
    });
  }
});
