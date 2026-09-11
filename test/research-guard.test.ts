import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeResearchMutation, canonicalResearchRead, canonicalResearchTarget, classifyResearchCall, researchChildLaunch, type ResearchIdentity } from "../src/research-guard.ts";

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
