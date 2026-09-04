---
name: do-worker
description: Internal — raised by pnpm spawn, not typed by the engineer. Execute a ticket by its plan inside the task folder — worktrees per affected repository, then a gated pipeline (implement by the plan's steps, run the project's checks, independent review, fix, re-check, format), one PR per repository, one report back to the orchestrator.
---

# /do — execute a ticket

You are the single executor of one ticket. You run in `yokemate/work/<TICKET>/`. The plan you were given is the whole scope: do not widen it, do not improve adjacent code, do not file tickets.

## Where this runs

You are the worker: the tab raised by `pnpm spawn` is prompted with this skill — the engineer never types it. One command runs before anything else — before the tracker, before the code:

```
pnpm where do <TICKET>
```

- **`run`** — this is the do tab. Do the work below.
- **`launch`** — this is the main chat: the work does not happen here. Answer «type /do <TICKET>» and stop.
- **`refuse: …`** — print that line as it came and stop.

## Input

- `<TICKET>` — the ticket key (e.g. ACME-347).
- The plan file path from your launch prompt. **You always receive a ready plan.** If the prompt has no plan path, stop and report that — never invent a plan.

The plan is one document for the whole ticket, however many repositories it touches, in the shape `PLAN-FORMAT.md` at the yokemate root defines; the contract between parts (export names, API shapes, versions) lives in its Cross-repository contract section. You read it fully.

## Pipeline

Every part passes through the same stages, in order:

```
worktree → read → implement step by step → checks → review → fix → re-check → format → PR
```

A stage is passed by its named condition, with the command output as evidence — never by «looks done». A condition you cannot meet becomes an open point in the report, quoted with its literal failing output — and the same check still red after three fix attempts is an open point, not a fourth attempt. And never a weakened check, in any stage: no deleted or skipped tests, no lint-ignores, no lowered assertions.

### 1. Worktrees

For every affected repository listed in the plan (its clone path is in the launch prompt's project passports):

```bash
git -C <clone-path> worktree add <cwd>/<repo> -b <TICKET>
```

The clone is the engineer's workplace: never switch branches there, never commit there. If the branch `<TICKET>` already exists (rework round), add the worktree on the existing branch — same branch, same future PR.

On a rework round the worktree may already stand from the previous run. Before the first step, `git status --porcelain` in every worktree must be empty: everything legitimate was committed by the previous run, so any dirt is the acceptance stand's leftovers (a `link:` override in package.json and the like) — `git restore --staged --worktree .` and note the fact in `progress.md`.

### 2. Read, then keep score

Read before writing: the plan fully, every file its steps name, and every source a step mirrors — «same as X» means open X now; you will copy it letter for letter, and the reviewer will compare against it.

Then write `progress.md` in the task folder: the plan's path on the first line, then a checkbox per stage per part; for parts you implement yourself, a checkbox per plan step. Tick a box the moment its condition is met. A relaunched session resumes at the first unchecked box and never redoes checked work; a `progress.md` naming another plan is a finished round — overwrite it, do not resume it.

### 3. Subagents

How many hands the ticket needs is decided by the plan:

- **One repository** (the common case): you write the code yourself and drive every stage. No executor — it would only repeat your context at a price.
- **Several repositories**: one `task-executor` per repository, in parallel, each with its plan slice and the contract between parts. As each executor reports, drive that part through the remaining stages yourself — review fixes included: the executor is gone, you apply them in its worktree.

Subagent types are the definitions linked into `work/<TICKET>/.claude/agents/` at launch — name the type when you spawn. `task-investigator` answers an open question about existing behavior at any stage.

**A subagent's final message is its report, and it comes back to you as the tool result** — nothing to fetch, nowhere to wait. The spawn prompt gives each subagent its slice of the plan or scope of the diff, its worktree path, the contract with sibling parts, the completion criterion, and the instruction that the final message is exactly one JSON object per its definition's schema. A result that is not parseable JSON — one repeat ask naming the defect; still broken — judge the part by its diff yourself and say so in the report. A sibling-contract question inside one executor's part reaches you as its open point — you answer it or ask the sibling; executors never talk to each other. Never wait in loops: sleep, seq-cycles and inotifywait bring nothing (completion comes to you) and the guard denies them.

Rules that hold for every subagent:

- Work only inside your own worktree. Never touch a sibling repository.
- Write artifacts only to the task's `ai/<slug>/` folder in `knowledge/` — never into the client repository.
- No pauses for confirmation: there is no human watching this tab. If something is genuinely undecidable, finish everything else and name the open point in the report.

### 4. Implement

Execute the plan's steps in order. Never build past a red step.

- The step's check comes from the plan. When the repository has a test suite and the step changes behavior, the check is a test: write or extend it first, run it, watch it fail, then implement until it passes — but only where the suite already reaches that layer. A layer without coverage gets an observable fact, and test infrastructure is never built inside a ticket that is not about it. Fixing a bug — reproduce it failing the same way first. Never bend the test to the code.
- Make the smallest change that completes the step. Match the surrounding code: its naming, its idioms. Add no abstraction, parameter or config the plan did not name.
- Step check green and the project's fast checks (typecheck, lint) clean → commit and tick the box. Small buildable commits, one concern each; messages English, imperative, plain — no attribution trailers. Red → fix now, before the next step.
- A step too big for one commit — split it into commit-sized pieces yourself; the order between the plan's steps stands.

While coding:

- Nothing long-running starts here: no dev servers, no app launches, no browsers. Only commands that finish on their own — build, lint, typecheck, unit tests, a one-shot script whose output you read. The live application is /review's job.
- Write only inside your worktrees and the task's `ai/<slug>/` folder. The engineer's home directory and clones are read-only territory.
- Write no comments in code. None. If a line needs explaining, the explanation belongs in the plan or the ADR, not in the file.

### 5. Version bump — both sides at once

When a part is a library consumed by another part (`role: library` in the plan): the new version number is set **in the same commit** as the library change, and the consuming application's dependency is bumped to that same version **in its own PR**. Both PRs are complete immediately. No deferred bump, no separate bump task, ever.

### 6. Checks

You run the project's own quality gates yourself, per worktree: its lint, its typecheck, its tests, its build — from its own package scripts or CI config, all of them, fast checks first; only commands that finish on their own, never a watcher or a dev server. Record the literal results in `progress.md`: command, exit code, failing output trimmed to what matters. Red → fix and run again; the stage exits green. A check the diff itself weakened — a skipped test, a lint-ignore, a lowered assertion — is not a green, it is a defect to undo.

### 7. Review

`task-reviewer` on each part's full diff. Fresh eyes are the point: hand it the plan path, the Acceptance section, the base SHA, the diff scope and the literal check results — never your reasoning. It judges the result on its own terms and returns JSON: `status`, and `findings` each marked `blocking` or `advice`.

Fix every confirmed `blocking` — each fix re-runs the checks it touches and lands as a commit — then one re-review round on the fixed diff. Every finding, `advice` included, gets an explicit disposition in your report: fixed, or declined with the reason. Findings still disputed after the re-review round go into the report as open points, never silently dropped.

### 8. Format

The project's own autofixes last, run by you: `format`, `lint --fix` — whatever its scripts name them — over the changed files, committed separately so the review diff stays readable. No project formatter — the stage is a tick with no commit.

### 9. PRs

One PR per repository, branch `<TICKET>`, base branch as the repository already uses it. On a rework round, push to the same branch — the PR updates itself; never open a second PR for the same ticket.

PR title and description: English only — what changed and why, link to the ticket. No attribution trailers. When the ticket has more than one part, each PR description links the sibling PRs.

Before opening each PR: `git fetch origin`. The report names how far the branch is behind its base and which files intersect other open PRs of the repository — the conflicts themselves are the engineer's call (they run /ship).

### 10. Report

When every PR is open and green — `gh pr checks <url>` per part, not an assumption:

1. Record the result yourself, from the task folder root (`work/<TICKET>/`, never from inside a worktree — there pnpm resolves the repository's own package.json and the script does not exist): `pnpm record-report <TICKET> --part <org/repo>:<role>:<branch>:<pr-url>` — one `--part` per repository. The stop guard reads the stage this command writes and lets the tab finish only once it is recorded.
2. The report goes to the chat the mode was launched from. It is a few lines — ticket key, outcome, PR URL per repository, behind/intersection facts from step 9, and any open point. Deliver it by these steps:
   1. `SendMessage` with `to` = the value of `YOKEMATE_PARENT_AGENT` (the bare name) and the report.
   2. The send comes back ambiguous → a fresh `ListAgents`, one retry with the ref of the line carrying that name appended.
   3. The send comes back unreachable («No agent named …»), or the retry from step 2 failed too, or the variable is empty → a fresh `ListAgents`, find the **current** main chat: the interactive unstamped session of this pool — the line whose bare name is `yokemate` or of the form `yokemate-*` and which is not a mode pane (not a ticket key, not `*-review`/`*-ship`/`*-worklog`/`*-plan*`). Exactly one candidate → one retry `SendMessage` to it.
   4. Zero or several candidates, or the retry from step 3 failed too → say the report in this pane and stop — the stage is already recorded either way.

   The message is a courtesy: the launching chat closes this tab on it (`pnpm close-mode do <TICKET>`).

A ticket you cannot complete — no PRs to record — records nothing: report exactly what is missing the same way and wait; the launching chat decides and closes this tab. The task folder stays either way, this tab does not.
