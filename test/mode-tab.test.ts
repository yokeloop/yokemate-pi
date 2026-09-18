import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bindCoordinatorControl, processStarttime, requestPlanControl } from "../src/coordinator-control.ts";
import { openDb } from "../src/db.ts";
import { resolveRuntimeSettings } from "../src/guard-policy.ts";
import { socketDir } from "../src/inbox.ts";
import { ListRunRegistry } from "../src/list-run.ts";
import { launchPlanKey } from "../src/plan-launch.ts";

const modes = ["plan", "review", "worklog", "note", "research"] as const;
type Mode = typeof modes[number];
const inputs: Record<Mode, string[]> = {
  plan: ["YM-1"], review: ["YM-1"], worklog: ["org"], note: ["topic"], research: ["--topic", "topic"],
};
const prompts: Record<Mode, string> = {
  plan: "/skill:plan YM-1", review: "/skill:review-worker YM-1", worklog: "/skill:worklog-worker org",
  note: "/skill:note-worker topic", research: "/skill:research-worker topic",
};
const stamps: Partial<Record<Mode, string>> = { plan: "YM-1", review: "YM-1", worklog: "org" };
const names: Record<Mode, string> = { plan: "ym-1-plan", review: "ym-1-review", worklog: "org-worklog", note: "note", research: "research" };
const ids = { tab: "w-fixture:t-created", tabPane: "w-fixture:p-tab-created", split: "w-fixture:p-split-created", parent: "w-fixture:p-parent" };

function fixture() {
  const root = mkdtempSync(join(import.meta.dirname, "fixtures", "mode-entry-"));
  cpSync(join(import.meta.dirname, "..", "src"), join(root, "src"), { recursive: true });
  cpSync(join(import.meta.dirname, "..", "package.json"), join(root, "package.json"));
  for (const path of ["node_modules/.bin", ".pi", "home", "clone", "work/YM-1", "home/knowledge/org/repo/ai/YM-2-stand"])
    mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, "home/knowledge/org/repo/ai/YM-2-stand/YM-2-stand-plan.md"), "# YM-2\n");
  writeFileSync(join(root, "home/pool.json"), JSON.stringify({ plan: "test/pool", note: "test/pool", research: "test/pool" }));
  const policy = (duplicateMode = true) => writeFileSync(join(root, ".pi/settings.json"), JSON.stringify({ guardPolicy: { yolo: false, guards: { duplicateMode, shipConfirmation: true } } }));
  policy();
  const db = openDb(join(root, "yokemate.db"));
  db.prepare("INSERT INTO project (org,repo,path,tracker,tracker_key,model,mode_models) VALUES ('org','repo',?,'github','YM','test/default',?)")
    .run(join(root, "clone"), JSON.stringify(Object.fromEntries(modes.map((mode) => [mode, "test/passport"]))));
  db.prepare("INSERT INTO project (org,repo,path,tracker,tracker_key,model,mode_models) VALUES ('second','repo',?,'github','ACME','test/default',?)")
    .run(join(root, "clone"), JSON.stringify({ plan: "test/second" }));
  db.close();
  const journal = join(root, "journal.jsonl");
  writeFileSync(join(root, "node_modules/.bin/herdr"), `#!${process.execPath}
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.JOURNAL, JSON.stringify(args) + "\\n");
if ((args[0] === "agent" && args[1] === process.env.FAIL_AT && (!process.env.FAIL_AGENT || args[2] === process.env.FAIL_AGENT)) || (args[1] === "close" && process.env.FAIL_CLEANUP)) {
  console.error("injected-" + args[1] + "-failure"); process.exit(1);
}
const created = fs.readFileSync(process.env.JOURNAL, "utf8").trim().split("\\n").map(JSON.parse).filter(c => c[1] === "create" || c[1] === "split").length;
const suffix = created > 1 ? "-" + created : "";
let result = {};
if (args[0] === "agent" && args[1] === "list") result = { agents: JSON.parse(process.env.AGENTS || "[]") };
if (args[0] === "tab" && args[1] === "create") result = { tab: { tab_id: "${ids.tab}" + suffix }, root_pane: { pane_id: "${ids.tabPane}" + suffix } };
if (args[0] === "pane" && args[1] === "split") result = { pane: { pane_id: "${ids.split}" + suffix } };
console.log(JSON.stringify({ result }));
`, { mode: 0o755 });
  writeFileSync(join(root, "node_modules/.bin/pi"), `#!${process.execPath}
import fs from "node:fs";
fs.appendFileSync(process.env.JOURNAL, JSON.stringify(["pi", ...process.argv.slice(2)]) + "\\n");
console.log("provider model context max-out thinking images\\ntest pool 1 1 yes yes\\ntest passport 1 1 yes yes\\ntest explicit 1 1 yes yes\\ntest second 1 1 yes yes");
`, { mode: 0o755 });
  const env = {
    PATH: `${join(root, "node_modules/.bin")}:${process.env.PATH ?? ""}`, HOME: root,
    HERDR_ENV: "1", HERDR_PANE_ID: ids.parent, HERDR_WORKSPACE_ID: "w-fixture", JOURNAL: journal,
    XDG_RUNTIME_DIR: root,
  };
  function run(mode: string, args: string[], extra: Record<string, string> = {}, entry = "node") {
    writeFileSync(journal, "");
    const out = spawnSync(entry === "package" ? "pnpm" : process.execPath,
      entry === "package" ? (mode === "plan" ? ["split", "plan", ...args] : [mode, ...args])
        : ["--experimental-strip-types", "--no-warnings", "src/mode-tab.ts", mode, ...args],
      { cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 20000 });
    const calls = readFileSync(journal, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
    return { ...out, calls };
  }
  return { root, env, run, policy, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function value(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index < 0 ? undefined : args[index + 1];
}

test("explicit plan lists do not bypass an unavailable live parent", () => {
  const f = fixture();
  try {
    for (const entry of ["node", "package"]) {
      const out = f.run("plan", ["YM-1", "YM-2"], { PI_SESSION_ID: "missing-parent-session" }, entry);
      assert.equal(out.status, 1);
      assert.match(out.stderr, /no live coordinator parent for this yokemate root/);
      assert.equal(out.calls.some((call) => call[1] === "create" || call[1] === "split"), false);
    }
  } finally { f.cleanup(); }
});

test("package and Node plan-list launchers print a parent refusal before admission", async () => {
  const f = fixture();
  const target = { sessionId: "fixture-session", runtimeId: "fixture-runtime" };
  let launches = 0;
  const parent = bindCoordinatorControl(f.root, {
    async launch() { throw new Error("unexpected coordinator launch"); },
    async launchPlan() { launches++; return { listRunId: "unexpected", results: [] }; },
    status(requestId) { return { requestId, state: "status" }; },
    async cancel() {},
  }, { root: f.root, ...target, pid: process.pid, starttime: processStarttime(process.pid)!, cwd: f.root, pane: ids.parent }, f.env);
  try {
    if (!parent.listening) await once(parent, "listening");
    const runtimeDir = socketDir(f.env, process.getuid!());
    writeFileSync(join(runtimeDir, `${ids.parent}.json`), JSON.stringify({ mode: "review", ticket: null, cwd: f.root, pid: process.pid }));
    for (const entry of ["node", "package"]) {
      writeFileSync(join(f.root, "journal.jsonl"), "");
      const command = entry === "package" ? "pnpm" : process.execPath;
      const args = entry === "package"
        ? ["split", "plan", "YM-1", "YM-2"]
        : ["--experimental-strip-types", "--no-warnings", "src/mode-tab.ts", "plan", "YM-1", "YM-2"];
      const child = spawn(command, args, { cwd: f.root, env: { ...f.env, PI_SESSION_ID: target.sessionId }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const [status] = await once(child, "close") as [number, NodeJS.Signals | null];
      assert.equal(status, 1, stdout + stderr);
      assert.match(stderr, /panel origin is not registered with this parent/);
      const calls = readFileSync(join(f.root, "journal.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
      assert.equal(calls.some((call) => call[1] === "create" || call[1] === "split"), false);
    }
    assert.equal(launches, 0);
  } finally {
    await new Promise<void>((resolve) => parent.close(() => resolve()));
    f.cleanup();
  }
});

test("package and Node plan lists show ready, queued and mixed parent admission in input order", { timeout: 20000 }, async () => {
  const f = fixture();
  const target = { sessionId: "fixture-session", runtimeId: "fixture-runtime" };
  const registry = new ListRunRegistry();
  const settings = resolveRuntimeSettings({ subagent: { maxParallelTasks: 6, maxConcurrency: 2, maxDetached: 6 } });
  const listIds: string[] = [];
  const previous = { PATH: process.env.PATH, JOURNAL: process.env.JOURNAL };
  process.env.PATH = f.env.PATH;
  process.env.JOURNAL = f.env.JOURNAL;
  const parent = bindCoordinatorControl(f.root, {
    async launch() { throw new Error("unexpected coordinator launch"); },
    async launchPlan(request, origin) {
      const run = registry.admit({ mode: "plan", keys: request.targets.map((item) => item.ticket), parentSessionId: target.sessionId, parentRuntimeId: target.runtimeId, settings, rejectKey: (key) => key === "YM-3" ? "fixture admission refusal" : undefined });
      listIds.push(run.identity.listRunId);
      setImmediate(() => {
        registry.start(run.identity.listRunId, async (lane) => {
          const item = request.targets[lane.index]!;
          const facts = await launchPlanKey(f.root, request, item, lane.keyRunId, request.model!, async (pane) => {
            const reply = await requestPlanControl(f.root, "bind-plan", { ticket: lane.key, runId: lane.keyRunId, pane }, { sessionId: target.sessionId, pid: process.pid, starttime: processStarttime(process.pid)!, cwd: f.root }, target, f.env);
            if (reply.state !== "accepted") throw new Error(reply.reason ?? "plan pane binding refused");
          });
          lane.active({ ...facts });
        });
        registry.publishImmediate(run.identity.listRunId);
      });
      return { listRunId: run.identity.listRunId, results: run.entries.map((entry) => ({ key: entry.key, keyRunId: entry.keyRunId, state: entry.immediate!.state, reservation: entry.immediate?.reservation, reason: entry.immediate?.reason })) };
    },
    status(requestId) { return { requestId, state: "status" }; },
    async cancel(runId) { registry.cancel(runId); },
  }, { root: f.root, ...target, pid: process.pid, starttime: processStarttime(process.pid)!, cwd: f.root, pane: ids.parent }, f.env);
  const waitForLaunches = async () => {
    const count = () => readFileSync(join(f.root, "journal.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]).filter((call) => call[1] === "prompt").length;
    if (count() >= 2) return;
    await new Promise<void>((resolve, reject) => {
      const watcher = watch(join(f.root, "journal.jsonl"), () => { if (count() >= 2) { clearTimeout(timer); watcher.close(); resolve(); } });
      const timer = setTimeout(() => { watcher.close(); reject(new Error("timed out waiting for scheduled plan launches")); }, 5000);
    });
  };
  try {
    if (!parent.listening) await once(parent, "listening");
    writeFileSync(join(socketDir(f.env, process.getuid!()), `${ids.parent}.json`), JSON.stringify({ mode: "main", ticket: null, cwd: f.root, pid: process.pid }));
    for (const entry of ["node", "package"]) {
      writeFileSync(join(f.root, "journal.jsonl"), "");
      const command = entry === "package" ? "pnpm" : process.execPath;
      const args = entry === "package"
        ? ["split", "plan", "YM-1", "YM-2", "YM-3", "YM-4", "YM-5", "--model", "test/explicit"]
        : ["--experimental-strip-types", "--no-warnings", "src/mode-tab.ts", "plan", "YM-1", "YM-2", "YM-3", "YM-4", "YM-5", "--model", "test/explicit"];
      const child = spawn(command, args, { cwd: f.root, env: { ...f.env, PI_SESSION_ID: target.sessionId }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const [status] = await once(child, "close") as [number, NodeJS.Signals | null];
      assert.equal(status, 1, stdout + stderr);
      const listId = listIds.at(-1)!;
      const admitted = registry.get(listId);
      assert.ok(admitted && !("run" in admitted));
      assert.deepEqual(stdout.trim().split("\n").filter((line) => /^YM-/.test(line)), [
        "YM-1 → ready in plan list " + listId + ", run " + admitted.entries[0]!.keyRunId,
        "YM-2 → ready in plan list " + listId + ", run " + admitted.entries[1]!.keyRunId,
        "YM-4 → queued in plan list " + listId + ", run " + admitted.entries[3]!.keyRunId,
        "YM-5 → queued in plan list " + listId + ", run " + admitted.entries[4]!.keyRunId,
      ]);
      assert.match(stderr, /^YM-3: fixture admission refusal/m);
      await waitForLaunches();
      const calls = readFileSync(join(f.root, "journal.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
      assert.equal(calls.filter((call) => call[1] === "create" || call[1] === "split").length, 2);
      assert.deepEqual(calls.filter((call) => call[1] === "prompt").map((call) => call[3]).sort(), ["/skill:plan YM-1", "/skill:plan YM-2"]);
      for (const item of [...admitted.entries].reverse()) registry.cancel(item.keyRunId);
    }
  } finally {
    await new Promise<void>((resolve) => parent.close(() => resolve()));
    if (previous.PATH === undefined) delete process.env.PATH; else process.env.PATH = previous.PATH;
    if (previous.JOURNAL === undefined) delete process.env.JOURNAL; else process.env.JOURNAL = previous.JOURNAL;
    f.cleanup();
  }
});

for (const mode of modes) {
  for (const entry of ["node", "package"]) {
    test(`${entry} ${mode}: default, explicit split and literal separator preserve identity`, () => {
      const f = fixture();
      try {
        for (const variant of ["default", "split", "literal"]) {
          const args = [...inputs[mode], ...(variant === "split" ? ["--split"] : variant === "literal" ? ["--", "--split"] : [])];
          const out = f.run(mode, args, {}, entry);
          assert.equal(out.status, 0, out.stderr);
          const created = out.calls.filter((c) => c[1] === "create" || c[1] === "split");
          assert.equal(created.length, 1);
          const surface = created[0]!;
          assert.deepEqual(surface.slice(0, 2), variant === "split" ? ["pane", "split"] : ["tab", "create"]);
          if (variant === "split") assert.equal(surface[2], ids.parent);
          else assert.equal(value(surface, "--workspace"), "w-fixture");
          assert.equal(value(surface, "--cwd"), f.root);
          const stampEnv = Object.fromEntries(surface.flatMap((word, index) => word === "--env" ? [surface[index + 1]!.split(/=(.*)/s).slice(0, 2)] : []));
          assert.equal(stampEnv.YOKEMATE_MODE, mode);
          assert.equal(stampEnv.YOKEMATE_TICKET, stamps[mode]);
          assert.equal(stampEnv.YOKEMATE_PARENT_PANE, ids.parent);
          const start = out.calls.find((c) => c[0] === "agent" && c[1] === "start")!;
          assert.equal(value(start, "--pane"), variant === "split" ? ids.split : ids.tabPane);
          const expectedModel = mode === "note" || mode === "research" ? "test/pool" : "test/passport";
          assert.equal(value(start, "--model"), expectedModel);
          assert.equal(value(start, "--skill"), join(f.root, ".pi/skills"));
          if (mode === "research") {
            assert.match(stampEnv.YOKEMATE_RESEARCH_ID!, /^[a-f0-9-]{36}$/);
            assert.equal(start[2], `research-${stampEnv.YOKEMATE_RESEARCH_ID!.replace(/-/g, "").slice(0, 8)}`);
            assert.deepEqual(start.slice(start.indexOf("--model")), ["--model", expectedModel, "--skill", join(f.root, ".pi/skills"), "--no-extensions", "--no-builtin-tools", "-e", join(f.root, "src/research.ts")]);
            assert.equal(stampEnv.YOKEMATE_RESEARCH_ROOT, f.root);
            assert.equal(stampEnv.YOKEMATE_RESEARCH_PROJECT, "");
          } else {
            assert.equal(start[2], names[mode]);
            assert.equal(stampEnv.YOKEMATE_ROLE, "coordinator");
            assert.deepEqual(start.slice(start.indexOf("--model")), ["--model", expectedModel, "--skill", join(f.root, ".pi/skills")]);
          }
          const prompt = out.calls.find((c) => c[0] === "agent" && c[1] === "prompt")!;
          assert.equal(prompt[3], prompts[mode] + (variant === "literal" ? " --split" : ""));
          assert.equal(out.calls.some((c) => c[1] === "close"), false);
          assert.ok(out.stdout.includes(variant === "split" ? `→ pane ${ids.split}` : `→ tab ${ids.tab}, pane ${ids.tabPane}`));
          if (mode === "plan") {
            const where = spawnSync("pnpm", ["where", "plan", "YM-1"], { cwd: f.root, env: { ...f.env, ...stampEnv }, encoding: "utf8" });
            assert.equal(where.status, 0, where.stderr);
            assert.match(where.stdout, /\nrun\s*$/);
          }
        }
      } finally { f.cleanup(); }
    });
  }

  test(`${mode}: explicit model is control only before separator on both surfaces`, () => {
    const f = fixture();
    try {
      for (const split of [[], ["--split"]]) {
        for (const literal of [false, true]) {
          const out = f.run(mode, [...split, ...inputs[mode], ...(literal ? ["--"] : []), "--model", literal ? "literal" : "test/explicit"]);
          assert.equal(out.status, 0, out.stderr);
          const start = out.calls.find((c) => c[1] === "start")!;
          assert.equal(value(start, "--model"), literal ? (mode === "note" || mode === "research" ? "test/pool" : "test/passport") : "test/explicit");
          assert.equal(out.calls.find((c) => c[1] === "prompt")![3], prompts[mode] + (literal ? " --model literal" : ""));
        }
      }
    } finally { f.cleanup(); }
  });

  for (const surface of ["tab", "split"]) {
    for (const failAt of ["start", "prompt"]) {
      test(`${mode} ${surface}: ${failAt} failure closes exactly the created surface`, () => {
        const f = fixture();
        try {
          const out = f.run(mode, [...inputs[mode], ...(surface === "split" ? ["--split"] : [])], { FAIL_AT: failAt, FAIL_CLEANUP: "1" });
          assert.equal(out.status, 1);
          assert.match(out.stderr, new RegExp(`injected-${failAt}-failure`));
          if (mode === "research") {
            assert.match(out.stderr, /injected-close-failure/);
            assert.match(out.stderr, /Pi terminal output:/);
            const captureIndex = out.calls.findIndex((c) => c[0] === "pane" && c[1] === "read");
            assert.ok(captureIndex >= 0);
            assert.deepEqual(out.calls[captureIndex], ["pane", "read", surface === "tab" ? ids.tabPane : ids.split, "--source", "recent-unwrapped", "--lines", "200", "--format", "text", "--raw"]);
            assert.ok(captureIndex < out.calls.findIndex((c) => c[1] === "close"));
          } else {
            assert.doesNotMatch(out.stderr, /injected-close-failure/);
          }
          assert.deepEqual(out.calls.filter((c) => c[1] === "close"), [surface === "tab" ? ["tab", "close", ids.tab] : ["pane", "close", ids.split]]);
          assert.equal(out.calls.some((c) => c[1] === "prompt"), failAt === "prompt");
        } finally { f.cleanup(); }
      });
    }
  }
}

test("generic duplicate guards and ticketless name series are surface independent", () => {
  const f = fixture();
  try {
    for (const split of [[], ["--split"]]) {
      for (const mode of ["plan", "review", "worklog"] as const) {
        const agents = JSON.stringify([{ name: names[mode], pane_id: "w-fixture:p-neighbor" }]);
        f.policy();
        const refused = f.run(mode, [...split, ...inputs[mode]], { AGENTS: agents });
        assert.equal(refused.status, 1);
        assert.match(refused.stderr, /already runs in pane w-fixture:p-neighbor/);
        assert.deepEqual(refused.calls, [["agent", "list"]]);
        f.policy(false);
        const allowed = f.run(mode, [...split, ...inputs[mode]], { AGENTS: agents });
        assert.equal(allowed.status, 0, allowed.stderr);
        const start = allowed.calls.find((c) => c[1] === "start")!;
        assert.match(start[2]!, new RegExp(`^${names[mode]}-[a-f0-9]{8}$`));
        const runId = start[2]!.slice(-8);
        assert.ok(allowed.calls.find((c) => c[1] === "create" || c[1] === "split")!.includes(`YOKEMATE_RUN_ID=${runId}`));
        assert.ok(allowed.calls.find((c) => c[1] === "prompt")![3]!.endsWith(`Run ID: ${runId}. Include it in your final report.`));
        assert.ok(start.includes(`${stamps[mode]} ${mode} [${runId}]`));
      }
      for (const mode of ["plan", "note"] as const) {
        for (const guarded of [true, false]) {
          f.policy(guarded);
          const out = f.run(mode, [...split, "problem"], { AGENTS: JSON.stringify([{ name: mode }, { name: `${mode}-3` }]) });
          assert.equal(out.status, 0, out.stderr);
          assert.equal(out.calls.find((c) => c[1] === "start")![2], `${mode}-2`);
          assert.equal(value(out.calls.find((c) => c[1] === "start")!, "--model"), "test/pool");
          const surface = out.calls.find((c) => c[1] === "create" || c[1] === "split")!;
          assert.equal(surface.some((arg) => arg.startsWith("YOKEMATE_TICKET=")), false);
          assert.equal(out.calls.find((c) => c[1] === "prompt")![3], `/skill:${mode === "plan" ? "plan" : "note-worker"} problem`);
        }
      }
    }
    for (const surface of ["cli", "pane"]) for (const variant of ["on", "off", "neighbor"]) console.log(`RUNTIME_CASE ${surface}:guards.duplicateMode:${variant}`);
  } finally { f.cleanup(); }
});

test("preflight refusals and review adopt happen before creating either surface", () => {
  const f = fixture();
  try {
    for (const split of [[], ["--split"]]) {
      const adopt = f.run("review", [...split, "YM-2", "note"]);
      assert.equal(adopt.status, 0, adopt.stderr);
      assert.match(adopt.calls.find((c) => c[1] === "prompt")![3]!, /pnpm adopt YM-2.*note$/);
      const fallback = f.run("plan", [...split, "OTHER-1"]);
      assert.equal(fallback.status, 0, fallback.stderr);
      assert.equal(value(fallback.calls.find((c) => c[1] === "start")!, "--model"), "test/pool");
      writeFileSync(join(f.root, "home/pool.json"), JSON.stringify({ note: "test/pool", research: "test/pool" }));
      const missingFallback = f.run("plan", [...split, "OTHER-1"]);
      assert.equal(missingFallback.status, 1);
      assert.match(missingFallback.stderr, /OTHER-1.*no plan model/);
      assert.equal(missingFallback.calls.some((c) => c[1] === "create" || c[1] === "split"), false);
      writeFileSync(join(f.root, "home/pool.json"), JSON.stringify({ plan: "test/pool", note: "test/pool", research: "test/pool" }));
      for (const [mode, args, error] of [
        ["review", ["YM-99"], /no task folder/],
        ["note", ["--model"], /--model needs a value/],
        ["research", ["--topic", "topic", "--unknown"], /unknown research option/],
        ["research", ["--topic", "topic", "--model", "test/missing"], /не найдена/],
      ] as const) {
        const out = f.run(mode, [...split, ...args]);
        assert.equal(out.status, 1);
        assert.match(out.stderr, error);
        assert.equal(out.calls.some((c) => c[1] === "create" || c[1] === "split"), false);
      }
      const project = f.run("research", [...split, "--project", "org/repo", "audit"]);
      assert.equal(project.status, 0, project.stderr);
      assert.equal(value(project.calls.find((c) => c[1] === "start")!, "--model"), "test/passport");
      assert.ok(project.calls.find((c) => c[1] === "create" || c[1] === "split")!.includes("YOKEMATE_RESEARCH_PROJECT=org/repo"));
    }
  } finally { f.cleanup(); }
});

test("plan worker keeps literal ticket words out of ownership and ticket inputs", () => {
  const f = fixture();
  try {
    for (const split of [[], ["--split"]]) {
      for (const keys of [["YM-1"], []]) {
        const literal = keys.length ? ["YM-2"] : ["YM-1"];
        const out = f.run("plan", [...split, ...keys, "--", ...literal]);
        assert.equal(out.status, 0, out.stderr);
        const surface = out.calls.find((c) => c[1] === "create" || c[1] === "split")!;
        const stampEnv = Object.fromEntries(surface.flatMap((word, index) => word === "--env" ? [surface[index + 1]!.split(/=(.*)/s).slice(0, 2)] : []));
        assert.equal(stampEnv.YOKEMATE_TICKET, keys.length ? "YM-1" : undefined);
        assert.deepEqual(JSON.parse(stampEnv.YOKEMATE_PLAN_LITERAL!), literal);
        assert.equal(out.calls.find((c) => c[1] === "prompt")![3], `/skill:plan ${[...keys, ...literal].join(" ")}`);
        const where = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/mode-guard.ts", "plan", ...(stampEnv.YOKEMATE_TICKET ? [stampEnv.YOKEMATE_TICKET] : [])],
          { cwd: f.root, env: { ...f.env, ...stampEnv }, encoding: "utf8" });
        assert.equal(where.status, 0, where.stderr);
        assert.equal(where.stdout.trim(), "run");
      }
    }
    const skill = readFileSync(join(import.meta.dirname, "../.pi/skills/plan/SKILL.md"), "utf8");
    assert.match(skill, /pnpm where plan "\$YOKEMATE_TICKET"/);
    assert.match(skill, /YOKEMATE_PLAN_LITERAL/);
    assert.match(skill, /never planning keys or launch controls/);
  } finally { f.cleanup(); }
});

for (const entry of ["node", "package"]) {
  for (const split of [false, true]) {
    test(`${entry} plan ${split ? "split" : "tab"}: each key owns its surface, model and literal context`, () => {
      const f = fixture();
      try {
        const plain = f.run("plan", [...(split ? ["--split"] : []), "YM-1", "YM-2", "YM-3"], {}, entry);
        assert.equal(plain.status, 0, plain.stderr);
        assert.equal(plain.calls.filter(c => c[1] === "create" || c[1] === "split").length, 3);
        assert.deepEqual(plain.calls.filter(c => c[1] === "prompt").map(c => c[3]), ["/skill:plan YM-1", "/skill:plan YM-2", "/skill:plan YM-3"]);
        for (const explicit of [false, true]) {
          const keys = ["YM-1", "ACME-2"];
          const literal = ["YM-99", "--split", "--model", "literal"];
          const out = f.run("plan", [...(split ? ["--split"] : []), ...keys,
            ...(explicit ? ["--model", "test/explicit"] : []), "--", ...literal], {}, entry);
          assert.equal(out.status, 0, out.stderr);
          const surfaces = out.calls.filter(c => c[1] === "create" || c[1] === "split");
          const starts = out.calls.filter(c => c[1] === "start");
          const prompts = out.calls.filter(c => c[1] === "prompt");
          assert.equal(surfaces.length, 2);
          assert.equal(starts.length, 2);
          assert.equal(prompts.length, 2);
          keys.forEach((key, index) => {
            const surface = surfaces[index]!;
            const suffix = index ? "-2" : "";
            const pane = (split ? ids.split : ids.tabPane) + suffix;
            assert.deepEqual(surface.slice(0, 2), split ? ["pane", "split"] : ["tab", "create"]);
            if (split) assert.equal(surface[2], ids.parent);
            else {
              assert.equal(value(surface, "--workspace"), "w-fixture");
              assert.equal(value(surface, "--label"), `${key} plan`);
            }
            assert.equal(value(surface, "--cwd"), f.root);
            const env = Object.fromEntries(surface.flatMap((word, i) => word === "--env" ? [surface[i + 1]!.split(/=(.*)/s).slice(0, 2)] : []));
            assert.equal(env.YOKEMATE_TICKET, key);
            assert.equal(env.YOKEMATE_MODE, "plan");
            assert.equal(env.YOKEMATE_ROLE, "coordinator");
            assert.equal(env.YOKEMATE_PARENT_PANE, ids.parent);
            assert.deepEqual(JSON.parse(env.YOKEMATE_PLAN_LITERAL!), literal);
            assert.equal(starts[index]![2], `${key.toLowerCase()}-plan`);
            assert.equal(value(starts[index]!, "--pane"), pane);
            assert.equal(value(starts[index]!, "-n"), `${key} plan`);
            assert.equal(value(starts[index]!, "--model"), explicit ? "test/explicit" : index ? "test/second" : "test/passport");
            assert.deepEqual(prompts[index], ["agent", "prompt", `${key.toLowerCase()}-plan`, `/skill:plan ${key} ${literal.join(" ")}`]);
            const where = spawnSync("pnpm", ["where", "plan", key], { cwd: f.root, env: { ...f.env, ...env }, encoding: "utf8" });
            assert.equal(where.status, 0, where.stderr);
            assert.match(where.stdout, /\nrun\s*$/);
            assert.ok(out.stdout.includes(`${key} → ${split ? "" : `tab ${ids.tab + suffix}, `}pane ${pane}`));
          });
          assert.equal(out.calls.some(c => c[1] === "close"), false);
          assert.doesNotMatch(JSON.stringify(out.calls), /YM-1\+ACME-2|skill:plan YM-1 ACME-2/);
        }
      } finally { f.cleanup(); }
    });

    for (const failure of ["duplicate", "model", "start", "prompt"]) {
      for (const failedIndex of [0, 1]) {
        test(`${entry} plan ${split ? "split" : "tab"}: ${failure} at ${failedIndex} leaves sibling alive`, () => {
          const f = fixture();
          try {
            const keys = ["YM-1", "YM-2"];
            const failedKey = failure === "model" ? "OTHER-1" : keys[failedIndex]!;
            keys[failedIndex] = failedKey;
            const sibling = keys[1 - failedIndex]!;
            const extra: Record<string, string> = failure === "duplicate" ? { AGENTS: JSON.stringify([{ name: `${failedKey.toLowerCase()}-plan`, pane_id: "w-fixture:p-neighbor" }]) }
              : failure === "model" ? {} : { FAIL_AT: failure, FAIL_AGENT: `${failedKey.toLowerCase()}-plan`, FAIL_CLEANUP: "1" };
            if (failure === "model")
              writeFileSync(join(f.root, "home/pool.json"), JSON.stringify({ note: "test/pool", research: "test/pool" }));
            const out = f.run("plan", [...(split ? ["--split"] : []), ...keys], extra, entry);
            assert.equal(out.status, 1);
            assert.match(out.stderr, failure === "duplicate" ? new RegExp(`${failedKey} plan already runs in pane w-fixture:p-neighbor — go to it, or close it and launch again`)
              : failure === "model" ? /OTHER-1.*no plan model/ : new RegExp(`${failedKey} plan:.*injected-${failure}-failure`));
            assert.doesNotMatch(out.stderr, /injected-close-failure/);
            assert.match(out.stdout, new RegExp(`${sibling} →`));
            const creates = out.calls.filter(c => c[1] === "create" || c[1] === "split");
            const preflight = failure === "duplicate" || failure === "model";
            assert.equal(creates.length, preflight ? 1 : 2);
            assert.ok(out.calls.some(c => c[1] === "prompt" && c[2] === `${sibling.toLowerCase()}-plan`));
            const suffix = failedIndex ? "-2" : "";
            assert.deepEqual(out.calls.filter(c => c[1] === "close"), preflight ? [] : [split ? ["pane", "close", ids.split + suffix] : ["tab", "close", ids.tab + suffix]]);
            assert.equal(out.calls.some(c => c[1] === "prompt" && c[2] === `${failedKey.toLowerCase()}-plan`), failure === "prompt");
          } finally { f.cleanup(); }
        });
      }
    }
  }
}

for (const entry of ["node", "package"]) {
  test(`${entry} plan: problem and mixed input stay in one conversational surface`, () => {
    const f = fixture();
    try {
      for (const split of [[], ["--split"]]) {
        for (const words of [["fix", "problem"], ["YM-1", "fix", "YM-2"], ["YM-1", "note"]]) {
          const out = f.run("plan", [...split, ...words, "--", "YM-99"], {}, entry);
          assert.equal(out.status, 0, out.stderr);
          const surfaces = out.calls.filter(c => c[1] === "create" || c[1] === "split");
          assert.equal(surfaces.length, 1);
          assert.equal(out.calls.find(c => c[1] === "prompt")![3], `/skill:plan ${words.join(" ")} YM-99`);
          const key = words[0] === "YM-1" ? "YM-1" : "";
          assert.equal(surfaces[0]!.includes(`YOKEMATE_TICKET=${key}`), Boolean(key));
          assert.equal(value(out.calls.find(c => c[1] === "start")!, "--model"), key ? "test/passport" : "test/pool");
          const where = spawnSync("pnpm", ["where", "plan", key], { cwd: f.root,
            env: { ...f.env, YOKEMATE_MODE: "plan", YOKEMATE_TICKET: key }, encoding: "utf8" });
          assert.equal(where.status, 0, where.stderr);
          assert.match(where.stdout, /\nrun\s*$/);
        }
      }
    } finally { f.cleanup(); }
  });
}
