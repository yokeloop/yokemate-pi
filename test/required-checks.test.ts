import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { requiredJobs } from "../src/required-checks.ts";

const root = resolve(import.meta.dirname, "..");
const workflow = (name: string) => ({ path: `.github/workflows/${name}`, text: readFileSync(join(root, ".github", "workflows", name), "utf8") });

test("the notify workflow is not a required check", () => {
  assert.deepEqual(requiredJobs([workflow("telegram-notify.yml")]), []);
});

test("every unconditional job of the ci workflow is required", () => {
  assert.deepEqual(requiredJobs([workflow("ci.yml"), workflow("telegram-notify.yml")]), [
    { workflow: "ci", job: "checks" },
    { workflow: "ci", job: "pi-loader-smoke" },
  ]);
});

test("pull_request without types includes synchronize", () => {
  const jobs = "jobs:\n  build:\n    runs-on: ubuntu-latest\n";
  assert.deepEqual(requiredJobs([{ path: "a.yml", text: `name: a\non: [pull_request]\n${jobs}` }]), [{ workflow: "a", job: "build" }]);
  assert.deepEqual(requiredJobs([{ path: "b.yaml", text: `name: b\non: pull_request\n${jobs}` }]), [{ workflow: "b", job: "build" }]);
  assert.deepEqual(requiredJobs([{ path: "c.yml", text: `name: c\non:\n  pull_request:\n${jobs}` }]), [{ workflow: "c", job: "build" }]);
});

test("pull_request types without synchronize are not required", () => {
  assert.deepEqual(requiredJobs([{ path: "a.yml", text: "name: a\non:\n  pull_request:\n    types: [opened]\njobs:\n  build:\n    runs-on: ubuntu-latest\n" }]), []);
  assert.deepEqual(requiredJobs([{ path: "b.yml", text: "name: b\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n" }]), []);
});

test("a named job reports its name, an unnamed workflow reports its path, and conditional jobs stay optional", () => {
  assert.deepEqual(
    requiredJobs([{ path: ".github/workflows/lint.yml", text: "on: pull_request\njobs:\n  lint:\n    name: Lint code\n    runs-on: ubuntu-latest\n  diagnostic:\n    if: github.head_ref == 'diagnostic'\n    runs-on: ubuntu-latest\n" }]),
    [{ workflow: ".github/workflows/lint.yml", job: "Lint code" }],
  );
});
