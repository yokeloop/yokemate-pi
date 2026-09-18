import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const sourceRoot = resolve(import.meta.dirname, "..");
const sourceEntry = join(sourceRoot, "src", "ticket-preview.ts");

function fixture(): { root: string; agentDir: string; entry: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "ticket-preview-startup-"));
  const agentDir = join(root, "agent");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".pi"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  for (const file of ["ticket-preview.ts", "youtrack.ts", "trackers.ts"])
    cpSync(join(sourceRoot, "src", file), join(root, "src", file));
  writeFileSync(join(root, ".env.local"), "YT_YOKELOOP_URL=https://yt.example\nYT_YOKELOOP_TOKEN=fixture-token\n");
  writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({ extensions: ["../src/ticket-preview.ts"] }));
  const db = new DatabaseSync(join(root, "yokemate.db"));
  db.exec("CREATE TABLE project (tracker TEXT NOT NULL, tracker_key TEXT NOT NULL)");
  db.prepare("INSERT INTO project (tracker, tracker_key) VALUES ('yokeloop', 'YM')").run();
  db.close();
  return { root, agentDir, entry: join(root, "src", "ticket-preview.ts"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function restoreEnv(previous: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
}

async function bind(
  root: string,
  agentDir: string,
  entry: string,
  sessionManager: ReturnType<typeof SessionManager.inMemory>,
  reason: "startup" | "resume" = "startup",
) {
  const settingsManager = SettingsManager.create(root, agentDir);
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [entry],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const loaded = loader.getExtensions().extensions.find((item) => resolve(item.resolvedPath) === entry);
  assert.ok(loaded);
  assert.ok(loaded.handlers.has("session_start"));
  const errors: string[] = [];
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    settingsManager,
    sessionManager,
    resourceLoader: loader,
    noTools: "builtin",
    sessionStartEvent: { type: "session_start", reason } as never,
  });
  await session.bindExtensions({
    uiContext: { notify: () => undefined, setStatus: () => undefined } as never,
    onError: (error) => errors.push(error.error),
  });
  assert.deepEqual(errors, []);
  return session;
}

function previews(entries: readonly unknown[]) {
  return entries.filter((value) => {
    const entry = value as { type?: string; customType?: string };
    return entry.type === "custom_message" && entry.customType === "yokemate-ticket-preview";
  }) as { type: string; content: string; display: boolean; details: { ticket: string; mode: string } }[];
}

test("the project settings load the real ticket preview extension", async () => {
  const settings = JSON.parse(readFileSync(join(sourceRoot, ".pi", "settings.json"), "utf8")) as { extensions?: string[] };
  assert.ok(settings.extensions?.includes("../src/ticket-preview.ts"));
  const agentDir = mkdtempSync(join(tmpdir(), "ticket-preview-settings-"));
  try {
    const loader = new DefaultResourceLoader({
      cwd: sourceRoot,
      agentDir,
      settingsManager: SettingsManager.create(sourceRoot, agentDir),
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const extension = loader.getExtensions().extensions.find((item) => resolve(item.resolvedPath) === sourceEntry);
    assert.ok(extension);
    assert.ok(extension.handlers.has("session_start"));
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
});

test("real Pi startup stores success, empty and error cards before the first worker prompt for plan and review", async () => {
  const previousEnv = { ...process.env };
  const previousFetch = globalThis.fetch;
  const f = fixture();
  try {
    for (const mode of ["plan", "review"] as const) {
      for (const scenario of ["success", "empty", "error"] as const) {
        process.env.YOKEMATE_MODE = mode;
        process.env.YOKEMATE_ROLE = "coordinator";
        process.env.YOKEMATE_TICKET = "YM-225";
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
          fetchCalls++;
          if (scenario === "error") return { ok: false, status: 500, json: async () => ({ secret: "raw-secret" }) } as Response;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              idReadable: "YM-225",
              summary: "Startup preview",
              description: scenario === "empty" ? " \n\t" : "# Full Markdown\n\nFirst paragraph\n\nLAST-CONTROL-PARAGRAPH",
            }),
          } as Response;
        }) as typeof fetch;
        const manager = SessionManager.inMemory(f.root);
        const session = await bind(f.root, f.agentDir, f.entry, manager);
        try {
          const beforePrompt = manager.getEntries();
          const cards = previews(beforePrompt);
          assert.equal(fetchCalls, 1);
          assert.equal(cards.length, 1);
          assert.equal(cards[0]!.display, true);
          assert.deepEqual(cards[0]!.details, { ticket: "YM-225", mode });
          if (scenario === "success") assert.ok(cards[0]!.content.endsWith("LAST-CONTROL-PARAGRAPH"));
          if (scenario === "empty") assert.ok(cards[0]!.content.endsWith("Описание отсутствует"));
          if (scenario === "error") {
            assert.match(cards[0]!.content, /YouTrack вернул HTTP 500.*Запуск режима продолжается\.$/);
            assert.doesNotMatch(cards[0]!.content, /raw-secret|fixture-token/);
          }
          assert.equal(beforePrompt.some((entry) => entry.type === "message"), false);
          manager.appendMessage({ role: "user", content: `/skill:${mode}`, timestamp: Date.now() });
          const afterPrompt = manager.getEntries();
          assert.ok(afterPrompt.indexOf(cards[0] as never) < afterPrompt.findIndex((entry) => entry.type === "message"));
        } finally { session.dispose(); }
      }
    }
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(previousEnv);
    f.cleanup();
  }
});

test("real Pi startup bounds a hanging fetch for both worker modes and still stores the card", async () => {
  const previousEnv = { ...process.env };
  const previousFetch = globalThis.fetch;
  const f = fixture();
  try {
    for (const mode of ["plan", "review"] as const) {
      process.env.YOKEMATE_MODE = mode;
      process.env.YOKEMATE_ROLE = "coordinator";
      process.env.YOKEMATE_TICKET = "YM-225";
      let calls = 0;
      let aborted = false;
      globalThis.fetch = (async (_input, init) => {
        calls++;
        init?.signal?.addEventListener("abort", () => { aborted = true; });
        return new Promise<Response>(() => undefined);
      }) as typeof fetch;
      const manager = SessionManager.inMemory(f.root);
      const started = Date.now();
      const session = await bind(f.root, f.agentDir, f.entry, manager);
      try {
        assert.ok(Date.now() - started >= 4900);
        assert.ok(Date.now() - started < 7000);
        assert.equal(calls, 1);
        assert.equal(aborted, true);
        const cards = previews(manager.getEntries());
        assert.equal(cards.length, 1);
        assert.match(cards[0]!.content, /YouTrack не ответил за 5 секунд.*Запуск режима продолжается\.$/);
      } finally { session.dispose(); }
    }
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(previousEnv);
    f.cleanup();
  }
});

test("reload and resume keep one saved card, while a separate session loads its own", async () => {
  const previousEnv = { ...process.env };
  const previousFetch = globalThis.fetch;
  const f = fixture();
  try {
    process.env.YOKEMATE_MODE = "plan";
    process.env.YOKEMATE_ROLE = "coordinator";
    process.env.YOKEMATE_TICKET = "YM-225";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: false, status: 500, json: async () => ({ secret: "raw-secret" }) } as Response;
    }) as typeof fetch;
    const manager = SessionManager.inMemory(f.root);
    const first = await bind(f.root, f.agentDir, f.entry, manager);
    try {
      assert.equal(calls, 1);
      assert.equal(previews(manager.getEntries()).length, 1);
      await first.reload();
      assert.equal(calls, 1);
      assert.equal(previews(manager.getEntries()).length, 1);
    } finally { first.dispose(); }

    const resumed = await bind(f.root, f.agentDir, f.entry, manager, "resume");
    try {
      assert.equal(calls, 1);
      assert.equal(previews(manager.getEntries()).length, 1);
      assert.match(previews(manager.getEntries())[0]!.content, /HTTP 500/);
    } finally { resumed.dispose(); }

    const separateManager = SessionManager.inMemory(f.root);
    const separate = await bind(f.root, f.agentDir, f.entry, separateManager);
    try {
      assert.equal(calls, 2);
      assert.equal(previews(separateManager.getEntries()).length, 1);
    } finally { separate.dispose(); }
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(previousEnv);
    f.cleanup();
  }
});
