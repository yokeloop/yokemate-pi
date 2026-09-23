import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCurrentTaskTree, discoverTaskTree, type TaskTreeSourceNode } from "../src/group-tree.ts";
import { fetchHierarchy } from "../src/youtrack.ts";
import type { Tracker } from "../src/trackers.ts";

const node = (ticket: string, parentIdentities: string[], childrenIdentities: string[], trackerState = "open"): TaskTreeSourceNode => ({ identity: `yt:${ticket}`, ticket, parentIdentities, childrenIdentities, trackerState, snapshot: { ticket, trackerState } });

function fetcher(nodes: TaskTreeSourceNode[]) {
  const values = new Map(nodes.map((value) => [value.identity, value]));
  return async (identity: string) => {
    const value = values.get(identity);
    if (!value) throw new Error(`incomplete_tree: unavailable ${identity}`);
    return value;
  };
}

test("discovers a nested non-Epic tree including closed and foreign-assignee children", async () => {
  const tree = await discoverTaskTree("yt:YM-1", fetcher([
    node("YM-1", [], ["yt:YM-2", "yt:YM-3"]),
    node("YM-2", ["yt:YM-1"], ["yt:YM-4"], "closed"),
    node("YM-3", ["yt:YM-1"], []),
    node("YM-4", ["yt:YM-2"], []),
  ]));
  assert.deepEqual(tree.nodes.map((value) => [value.ticket, value.parentIdentity, value.trackerState]), [
    ["YM-1", null, "open"],
    ["YM-2", "yt:YM-1", "closed"],
    ["YM-4", "yt:YM-2", "open"],
    ["YM-3", "yt:YM-1", "open"],
  ]);
  assert.match(tree.treeHash, /^[a-f0-9]{64}$/);
});

test("recovery verifies topology while allowing expected issue changes and requiring evidence for closure", async () => {
  const tree = await discoverTaskTree("yt:YM-1", fetcher([
    { ...node("YM-1", [], ["yt:YM-2"]), snapshot: { title: "changed after planning" } },
    node("YM-2", ["yt:YM-1"], [], "closed"),
  ]));
  assert.doesNotThrow(() => assertCurrentTaskTree(tree, [
    { memberIdentity: "yt:YM-1", parentIdentity: null, execution: "ready" },
    { memberIdentity: "yt:YM-2", parentIdentity: "yt:YM-1", execution: "integrated" },
  ]));
  assert.throws(() => assertCurrentTaskTree(tree, [
    { memberIdentity: "yt:YM-1", parentIdentity: null, execution: "ready" },
    { memberIdentity: "yt:YM-2", parentIdentity: "yt:YM-1", execution: "queued" },
  ]), /closed without preserved integrated evidence/);
  assert.throws(() => assertCurrentTaskTree(tree, [
    { memberIdentity: "yt:YM-1", parentIdentity: null, execution: "ready" },
    { memberIdentity: "yt:YM-2", parentIdentity: null, execution: "integrated" },
  ]), /topology changed/);
});

test("rejects cycles, multiple parents, unavailable nodes and mismatched direct parent", async () => {
  await assert.rejects(() => discoverTaskTree("yt:YM-1", fetcher([
    node("YM-1", [], ["yt:YM-2"]),
    node("YM-2", ["yt:YM-1"], ["yt:YM-1"]),
  ])), /cycle/);
  await assert.rejects(() => discoverTaskTree("yt:YM-1", fetcher([
    node("YM-1", [], ["yt:YM-2", "yt:YM-3"]),
    node("YM-2", ["yt:YM-1"], ["yt:YM-4"]),
    node("YM-3", ["yt:YM-1"], ["yt:YM-4"]),
    node("YM-4", ["yt:YM-2", "yt:YM-3"], []),
  ])), /multiple parents/);
  await assert.rejects(() => discoverTaskTree("yt:YM-1", fetcher([node("YM-1", [], ["yt:YM-2"])])), /unavailable/);
  await assert.rejects(() => discoverTaskTree("yt:YM-1", fetcher([
    node("YM-1", [], ["yt:YM-2"]),
    node("YM-2", ["yt:OTHER"], []),
  ])), /parent does not match/);
});

test("YouTrack hierarchy reads directed native links and fails closed on HTTP errors", async () => {
  const tracker: Tracker = { kind: "youtrack", name: "demo", baseUrl: "https://yt.example", token: "token" };
  const okFetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/links?")) return new Response(JSON.stringify([
      { direction: "OUTWARD", linkType: { sourceToTarget: "parent for", targetToSource: "subtask of", directed: true }, issues: [{ idReadable: "D-3", summary: "child" }] },
      { direction: "INWARD", linkType: { sourceToTarget: "parent for", targetToSource: "subtask of", directed: true }, issues: [{ idReadable: "D-1", summary: "parent" }] },
    ]), { status: 200 });
    return new Response(JSON.stringify({ idReadable: "D-2", summary: "middle", resolved: null }), { status: 200 });
  };
  const hierarchy = await fetchHierarchy(tracker, "D-2", okFetch as typeof fetch);
  assert.deepEqual(hierarchy.parents.map((issue) => issue.idReadable), ["D-1"]);
  assert.deepEqual(hierarchy.subtasks.map((issue) => issue.idReadable), ["D-3"]);
  const denied = async (input: string | URL | Request) => String(input).includes("/links?")
    ? new Response("forbidden", { status: 403 })
    : new Response(JSON.stringify({ idReadable: "D-2", summary: "middle" }), { status: 200 });
  await assert.rejects(() => fetchHierarchy(tracker, "D-2", denied as typeof fetch), /incomplete_tree.*403/);
});

test("tree hash changes with issue snapshots and is stable for the same traversal", async () => {
  const first = await discoverTaskTree("yt:YM-1", fetcher([node("YM-1", [], [])]));
  const repeat = await discoverTaskTree("yt:YM-1", fetcher([node("YM-1", [], [])]));
  const changed = await discoverTaskTree("yt:YM-1", fetcher([node("YM-1", [], [], "closed")]));
  assert.equal(first.treeHash, repeat.treeHash);
  assert.notEqual(first.treeHash, changed.treeHash);
});
