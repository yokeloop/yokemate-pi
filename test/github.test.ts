import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { ticketUrl } from "../src/ticket-url.ts";
import {
  issueStates,
  issueUrl,
  mine,
  postComment,
  validGithubPrefix,
  viewerLogin,
  type GhExec,
  type GhIssue,
  type GithubProject,
} from "../src/github.ts";

const demoApp: GithubProject = { org: "octo", repo: "demo-app", path: "/clones/demo-app", prefix: "DEMO" };

function fakeGh(issues: GhIssue[], me = "me") {
  const calls: { args: string[]; cwd?: string }[] = [];
  const exec: GhExec = (args, cwd) => {
    calls.push({ args, cwd });
    if (args[0] === "api") return `${me}\n`;
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify(issues);
    return "";
  };
  return { exec, calls };
}

test("issueStates lists once per project and maps keys to issue numbers", () => {
  const { exec, calls } = fakeGh([
    { number: 12, title: "open one", state: "OPEN", assignees: [{ login: "me" }] },
    { number: 13, title: "closed one", state: "CLOSED", assignees: [{ login: "me" }] },
  ]);
  const states = issueStates(demoApp, ["DEMO-12", "DEMO-13", "DEMO-14"], exec);
  const lists = calls.filter((c) => c.args[0] === "issue" && c.args[1] === "list");
  assert.equal(lists.length, 1);
  assert.deepEqual(lists[0].args.slice(0, 4), ["issue", "list", "--state", "all"]);
  assert.equal(lists[0].cwd, "/clones/demo-app");
  assert.deepEqual(states.get("DEMO-12"), { resolved: false, assignedToMe: true, title: "open one" });
  assert.deepEqual(states.get("DEMO-13"), { resolved: true, assignedToMe: true, title: "closed one" });
  assert.equal(states.has("DEMO-14"), false);
});

test("mine: unassigned or includes me", () => {
  const issue = (assignees: { login: string }[]): GhIssue => ({
    number: 1, title: "t", state: "OPEN", assignees,
  });
  assert.equal(mine(issue([]), "me"), true);
  assert.equal(mine(issue([{ login: "other" }]), "me"), false);
  assert.equal(mine(issue([{ login: "other" }, { login: "me" }]), "me"), true);

  const { exec } = fakeGh([
    { number: 1, title: "nobody", state: "OPEN", assignees: [] },
    { number: 2, title: "other", state: "OPEN", assignees: [{ login: "other" }] },
    { number: 3, title: "both", state: "OPEN", assignees: [{ login: "other" }, { login: "me" }] },
  ]);
  const states = issueStates(demoApp, ["DEMO-1", "DEMO-2", "DEMO-3"], exec);
  assert.equal(states.get("DEMO-1")?.assignedToMe, true);
  assert.equal(states.get("DEMO-2")?.assignedToMe, false);
  assert.equal(states.get("DEMO-3")?.assignedToMe, true);
});

test("issueUrl from ssh and https remotes", () => {
  assert.equal(
    issueUrl("/clones/demo-app", 12, () => "git@github.com:octo/demo-app.git\n"),
    "https://github.com/octo/demo-app/issues/12",
  );
  assert.equal(
    issueUrl("/clones/demo-app", 12, () => "https://github.com/octo/demo-app.git\n"),
    "https://github.com/octo/demo-app/issues/12",
  );
});

test("postComment runs gh issue comment in the clone", () => {
  const { exec, calls } = fakeGh([]);
  postComment(demoApp, 12, "PR: https://github.com/octo/demo-app/pull/3", exec);
  assert.deepEqual(calls, [
    {
      args: ["issue", "comment", "12", "--body", "PR: https://github.com/octo/demo-app/pull/3"],
      cwd: "/clones/demo-app",
    },
  ]);
});

test("viewerLogin caches", () => {
  const { exec, calls } = fakeGh([], "octocat");
  assert.equal(viewerLogin(exec), "octocat");
  assert.equal(viewerLogin(exec), "octocat");
  assert.equal(calls.filter((c) => c.args[0] === "api").length, 1);
});

test("validGithubPrefix", () => {
  assert.equal(validGithubPrefix("DEMO"), true);
  assert.equal(validGithubPrefix("demo-app"), false);
  assert.equal(validGithubPrefix("DEMO-1"), false);
  assert.equal(validGithubPrefix(""), false);
});

test("ticketUrl resolves a github passport to the issue URL", () => {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO project (org, repo, path, tracker, tracker_key, model) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("octo", "demo-app", "/clones/demo-app", "github", "DEMO", "opus");
  assert.equal(
    ticketUrl(db, "DEMO-12", () => "git@github.com:octo/demo-app.git\n"),
    "https://github.com/octo/demo-app/issues/12",
  );
  assert.equal(ticketUrl(db, "NOPE-12", () => "git@github.com:octo/demo-app.git\n"), "ticket:NOPE-12");
  assert.equal(
    ticketUrl(db, "DEMO-12", () => {
      throw new Error("no origin");
    }),
    "ticket:DEMO-12",
  );
});
