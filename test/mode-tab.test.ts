import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { openDb } from "../src/db.ts";

const ids = { tab: "w-fixture:t-created", tabPane: "w-fixture:p-tab-created", split: "w-fixture:p-split-created", parent: "w-fixture:p-parent" };
type Call = { executable: string; args: string[] };

function fixture() {
  // Outside the repository: no inherited workspace, node_modules/.bin or user HOME.
  const root = mkdtempSync(join(tmpdir(), "mode-entry-"));
  const bin = join(root, "node_modules/.bin");
  for (const path of [bin, join(root, ".pi"), join(root, "home"), join(root, "work/YM-1")]) mkdirSync(path, { recursive: true });
  cpSync(join(import.meta.dirname, "../src"), join(root, "src"), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8"));
  // pnpm may prepend its own bins: pin PATH again at the package-script boundary.
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "mode-canary", private: true, type: "module", scripts: { research: `PATH='${bin}' ${pkg.scripts.research}` } }));
  writeFileSync(join(root, ".npmrc"), "manage-package-manager-versions=false\nenable-pre-post-scripts=false\nscript-shell=/bin/sh\n");
  writeFileSync(join(root, ".pi/settings.json"), "{}");
  writeFileSync(join(root, "home/pool.json"), JSON.stringify({ research: "test/pool" }));
  const db = openDb(join(root, "yokemate.db"));
  db.prepare("INSERT INTO project (org,repo,path,tracker,tracker_key,model,mode_models) VALUES ('org','repo',?,'github','YM','test/default',?)")
    .run(join(root, "clone"), JSON.stringify({ review: "test/passport" }));
  db.close();
  const journal = join(root, "journal.jsonl");
  symlinkSync(process.execPath, join(bin, "node"));
  for (const name of ["pi", "herdr"]) {
    writeFileSync(join(bin, name), `#!${process.execPath}
import fs from "node:fs";
if (process.env.PATH !== ${JSON.stringify(bin)}) throw new Error("application PATH escaped shim isolation");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.JOURNAL, JSON.stringify({ executable: fs.realpathSync(process.argv[1]), args }) + "\\n");
if (${JSON.stringify(name)} === "pi") {
  if (args[0] !== "--offline" || args[1] !== "--list-models") throw new Error("unexpected Pi shim invocation");
  console.log("provider model context max-out thinking images\\ntest pool 1 1 yes yes\\ntest passport 1 1 yes yes");
} else {
  const op = args.slice(0, 2).join(" ");
  const results = {
    "agent list": { agents: [] },
    "tab create": { tab: { tab_id: "${ids.tab}" }, root_pane: { pane_id: "${ids.tabPane}" } },
    "pane split": { pane: { pane_id: "${ids.split}" } },
    "agent start": {}, "agent prompt": {},
  };
  if (!(op in results)) throw new Error("unexpected herdr shim operation: " + op);
  // Deliberately never execute the launch command passed to agent start.
  console.log(JSON.stringify({ result: results[op] }));
}
`, { mode: 0o755 });
    assert.equal(realpathSync(join(bin, name)), join(bin, name));
  }
  function run(args: string[], extra: Record<string, string> = {}, packageEntry = false) {
    writeFileSync(journal, "");
    let command = process.execPath;
    let argv = ["--experimental-strip-types", "--no-warnings", "src/mode-tab.ts", ...args];
    let launcherPath = bin;
    if (packageEntry) {
      const searchPath = (process.env.PATH ?? "").split(delimiter);
      const pnpm = searchPath.map((dir) => join(dir, "pnpm")).find((path) => existsSync(path));
      assert.ok(pnpm, "package canary needs installed pnpm");
      command = realpathSync(pnpm);
      argv = args;
      // setup-pnpm installs a shell wrapper needing these utilities before Node starts.
      // Keep them out of the application's PATH, which the package script resets to bin.
      const bootstrapBin = join(root, "pnpm-bootstrap");
      mkdirSync(bootstrapBin, { recursive: true });
      for (const name of ["sed", "dirname", "uname"]) {
        const source = searchPath.map((dir) => join(dir, name)).find((path) => existsSync(path));
        assert.ok(source, `pnpm launcher needs ${name}`);
        const target = join(bootstrapBin, name);
        if (!existsSync(target)) symlinkSync(realpathSync(source), target);
      }
      launcherPath = `${bin}${delimiter}${bootstrapBin}`;
    }
    const out = spawnSync(command, argv, {
      cwd: root, encoding: "utf8", timeout: 20000,
      env: { PATH: launcherPath, HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_RUNTIME_DIR: root,
        HERDR_ENV: "1", HERDR_PANE_ID: ids.parent, HERDR_WORKSPACE_ID: "w-fixture", JOURNAL: journal, ...extra },
    });
    assert.equal(out.error, undefined);
    const records = readFileSync(journal, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Call);
    for (const call of records) assert.ok([join(bin, "pi"), join(bin, "herdr")].includes(call.executable), call.executable);
    return { ...out, calls: records.filter((call) => call.executable === join(bin, "herdr")).map((call) => call.args), records };
  }
  return { root, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function value(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index < 0 ? undefined : args[index + 1];
}
function stamp(args: string[]): Record<string, string> {
  return Object.fromEntries(args.flatMap((word, i) => word === "--env" ? [args[i + 1]!.split(/=(.*)/s).slice(0, 2)] : []));
}

test("Node review defaults to a tab and passes literal argv and only allowed isolation env to shims", () => {
  const f = fixture();
  try {
    const isolation = { PI_CODING_AGENT_DIR: join(f.root, "agent"), PI_CODING_AGENT_SESSION_DIR: join(f.root, "sessions") };
    const out = f.run(["review", "YM-1", "--", "--split", "--model", "literal"], {
      ...isolation, PI_SESSION_FILE: "stale-session", YOKEMATE_RUN_ID: "stale-run", UNRELATED_SECRET: "sentinel",
    });
    assert.equal(out.status, 0, out.stderr);
    const create = out.calls.find((c) => c[1] === "create")!;
    assert.deepEqual(create.slice(0, 8), ["tab", "create", "--workspace", "w-fixture", "--cwd", f.root, "--label", "YM-1 review"]);
    assert.deepEqual(stamp(create), { YOKEMATE_MODE: "review", YOKEMATE_TICKET: "YM-1", YOKEMATE_PARENT_PANE: ids.parent, YOKEMATE_ROLE: "coordinator", ...isolation });
    const start = out.calls.find((c) => c[1] === "start")!;
    assert.equal(start[2], "ym-1-review");
    assert.equal(value(start, "--pane"), ids.tabPane);
    assert.deepEqual(start.slice(start.indexOf("--model")), ["--model", "test/passport", "--skill", join(f.root, ".pi/skills")]);
    assert.deepEqual(out.calls.find((c) => c[1] === "prompt"), ["agent", "prompt", "ym-1-review", "/skill:review-worker YM-1 --split --model literal"]);
    assert.equal(out.calls.filter((c) => c[1] === "create" || c[1] === "split").length, 1);
    assert.equal(out.calls.some((c) => c[1] === "close"), false);
  } finally { f.cleanup(); }
});

test("package research split preserves its topic and literal tail using only shims", () => {
  const f = fixture();
  try {
    const out = f.run(["research", "--split", "--topic", "audit", "--", "--model", "literal", "YM-99"], {}, true);
    assert.equal(out.status, 0, out.stderr);
    const create = out.calls.find((c) => c[1] === "split")!;
    assert.deepEqual(create.slice(0, 7), ["pane", "split", ids.parent, "--direction", "down", "--cwd", f.root]);
    const env = stamp(create);
    assert.equal(env.YOKEMATE_MODE, "research");
    assert.equal(env.YOKEMATE_TICKET, undefined);
    assert.equal(env.YOKEMATE_RESEARCH_ROOT, f.root);
    assert.equal(env.YOKEMATE_RESEARCH_PROJECT, "");
    assert.equal(env.YOKEMATE_PARENT_PANE, ids.parent);
    assert.match(env.YOKEMATE_RESEARCH_ID!, /^[a-f0-9-]{36}$/);
    const start = out.calls.find((c) => c[1] === "start")!;
    assert.equal(start[2], `research-${env.YOKEMATE_RESEARCH_ID!.replace(/-/g, "").slice(0, 8)}`);
    assert.equal(value(start, "--pane"), ids.split);
    assert.deepEqual(start.slice(start.indexOf("--model")), ["--model", "test/pool", "--skill", join(f.root, ".pi/skills"), "--no-extensions", "--no-builtin-tools", "-e", join(f.root, "src/research.ts")]);
    assert.deepEqual(out.calls.find((c) => c[1] === "prompt"), ["agent", "prompt", start[2], "/skill:research-worker audit --model literal YM-99"]);
    assert.equal(out.calls.filter((c) => c[1] === "create" || c[1] === "split").length, 1);
  } finally { f.cleanup(); }
});

test("Node plan with unavailable parent refuses before create, split or start effects", () => {
  const f = fixture();
  try {
    const out = f.run(["plan", "YM-1", "YM-2"], { PI_SESSION_ID: "missing-parent-session" });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /coordinator parent sidecar is missing/);
    assert.deepEqual(out.records, []);
  } finally { f.cleanup(); }
});
