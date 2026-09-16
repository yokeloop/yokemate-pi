import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeResearchMutation, canonicalResearchRead, canonicalResearchTarget, classifyResearchCall, researchChildLaunch, resolveResearchRead, type ResearchIdentity } from "../src/research-guard.ts";

const identity = (path: string): ResearchIdentity => ({ root: path, id: "r", project: "acme/app", projectPath: path, sessionId: "s", role: "worker" });

test("research mutation needs fresh UI consent and rejects escapes", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-guard-"));
  try {
    const file = join(root, "a.ts"); writeFileSync(file, "old");
    const yes = await authorizeResearchMutation({ identity: identity(root), target: file, initialContent: "old", finalContent: "new", hasUI: true, confirm: async () => true });
    assert.deepEqual(yes, { ok: true });
    const no = await authorizeResearchMutation({ identity: identity(root), target: file, initialContent: "old", finalContent: "new", hasUI: false });
    assert.equal(no.ok, false);
    assert.throws(() => canonicalResearchTarget(join(root, "..", "outside"), root));
    const target = join(root, "target"); mkdirSync(target); symlinkSync(target, join(root, "link"));
    assert.throws(() => canonicalResearchTarget(join(root, "link", "x"), root));
    assert.equal(classifyResearchCall(identity(root), "node").ok, false);
    assert.equal(canonicalResearchRead(file, identity(root)).ok, true);
    const secret = join(root, ".env"); writeFileSync(secret, "secret");
    assert.equal(canonicalResearchRead(secret, identity(root)).ok, false);
    assert.equal(canonicalResearchRead("/etc/passwd", identity(root)).ok, false);
    const child = researchChildLaunch(identity(root), root, [root]);
    assert.equal(child.cwd, root);
    assert.equal(child.env.YOKEMATE_RESEARCH_ROLE, "child");
    assert.throws(() => researchChildLaunch(identity(root), "/tmp", [root]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("research reads resolve against the canonical clone and diagnose denied targets", () => {
  const dir = mkdtempSync(join(tmpdir(), "research-read-"));
  const root = join(dir, "engine");
  const clone = join(dir, "clone");
  const link = join(dir, "clone-link");
  try {
    for (const path of [root, join(clone, "test"), join(root, "src"), join(root, "docs"), join(root, ".pi", "skills"), join(root, "home", "notes"), join(root, "home", "knowledge", "acme", "app")]) mkdirSync(path, { recursive: true });
    symlinkSync(clone, link);
    const selected = { ...identity(root), projectPath: link };
    for (const [input, expected] of [["test", join(clone, "test")], [".", clone], [undefined, clone], ["", clone], [join(root, "src"), join(root, "src")]] as const) {
      const target = resolveResearchRead(input, selected);
      assert.equal(target, expected);
      assert.deepEqual(canonicalResearchRead(target, selected), { ok: true });
    }
    for (const path of ["docs", ".pi/skills", "home/notes", "home/knowledge/acme/app"])
      assert.deepEqual(canonicalResearchRead(join(root, path), selected), { ok: true });
    for (const name of [".env", ".env.local", ".git", "credentials.json", "token.json"]) writeFileSync(join(clone, name), "PRIVATE_CONTENT");
    const outside = join(dir, "outside"); mkdirSync(outside);
    symlinkSync(outside, join(clone, "escape"));
    for (const target of [root, outside, join(clone, "escape"), join(clone, "missing"), ...[".env", ".env.local", ".git", "credentials.json", "token.json"].map((name) => join(clone, name))]) {
      const verdict = canonicalResearchRead(resolveResearchRead(target, selected), selected);
      assert.equal(verdict.ok, false, target);
      if (verdict.ok) throw new Error("expected denied read");
      assert.ok(verdict.reason.includes(target), verdict.reason);
      assert.ok(verdict.reason.includes(`allowed roots: ${clone}`), verdict.reason);
      assert.doesNotMatch(verdict.reason, /PRIVATE_CONTENT/);
    }
    const free = { ...identity(root), project: null, projectPath: null };
    assert.equal(resolveResearchRead(".", free), root);
    assert.equal(canonicalResearchRead(resolveResearchRead(".", free), free).ok, false);
    assert.equal(canonicalResearchRead(resolveResearchRead("src", free), free).ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
