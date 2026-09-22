---
name: do-worker
description: Internal — raised by a long-lived background coordinator, not typed by the engineer. Execute a ticket by its plan inside the task folder through the existing gated pipeline.
---

# /do — execute a ticket

You are the single executor of one ticket. If a trusted parent delegates this ticket as a member of an activated group, use only its runtime-resolved member scope and member plan: internal PRs target the root integration branch, root own-work uses `<ROOT>-own`, and your verified result becomes member `ready`, never the whole root `review`. You cannot integrate, widen the member set, or consume another user do permit. You run in `yokemate/work/<TICKET>/`. The plan you were given is the whole scope: do not widen it, do not improve adjacent code, do not file tickets.

The engine-root runtime settings remove only their named optional refusals; they never widen this ticket's scope. Initial do authority belongs to the verified interactive parent, not to this worker or its tool arguments. Owned implement → independent review → fix → re-check continues within the same active cycle and unchanged recorded plan; a changed plan or scope requires new explicit approval.

## Where this runs

You are the long-lived background coordinator prompted with this skill — the engineer never types it. One command runs before anything else — before the tracker, before the code:

```
pnpm where do <TICKET>
```

- **`run`** — this is the do coordinator. Do the work below and remain alive between detached child reports.
- **`launch`** — this is the main chat: the work does not happen here. Answer «type /do <TICKET>» and stop.
- **`refuse: …`** — print that line as it came and stop.

## Input

- `<TICKET>` — the ticket key (e.g. ACME-347).
- The plan file path from your launch prompt. **You always receive a ready plan.** If the prompt has no plan path, stop and report that — never invent a plan.

The plan is one document for the whole ticket, however many repositories it touches, in the shape `PLAN-FORMAT.md` at the yokemate root defines; the contract between parts (export names, API shapes, versions) lives in its Cross-repository contract section. You read it fully.

## Pipeline

Every part passes through the same stages, in order:

```
read plan → worktree → prepare / repair environment → read code → implement step by step → checks → review → fix → re-check → format → PR
```

A stage is passed by its named condition, with the command output as evidence — never by «looks done». A condition you cannot meet becomes an open point in the report, quoted with its literal failing output — and the same check still red after three fix attempts is an open point, not a fourth attempt. And never a weakened check, in any stage: no deleted or skipped tests, no lint-ignores, no lowered assertions.

### 1. Worktrees

Read the complete plan first. For every affected repository, inspect its instructions, documented setup, CI and working-tree status; its clone path is in the launch prompt's project passports. The model owns environment preparation and repair, not just the first install attempt.

For a new ticket branch, fetch the intended remote before choosing the base. Honor the engineer's or plan's explicit base; otherwise discover the remote default branch with `git ls-remote --symref <remote> HEAD`. Do not assume `main`, trust a stale `origin/HEAD`, or fall back to the clone's current HEAD after a failed fetch. Resolve the fetched base to an exact commit and record remote, base ref and SHA in `progress.md`.

```bash
git -C <clone-path> fetch <remote>
git -C <clone-path> rev-parse --verify refs/remotes/<remote>/<base-branch>
git -C <clone-path> worktree add <cwd>/<repo> -b <TICKET> <verified-base-sha>
```

Fetching objects/remote refs and registering a worktree are allowed; never switch branches, pull, commit or change working files in the engineer's clone. If the ticket branch already exists locally or remotely, inspect its history and PR first and reuse it. Preserve unfinished work and the PR's base; never recreate/reset/rebase a ticket branch just to make setup pass. If a previous preparation-only attempt left a clean branch with no task commits and no PR, an ancestor check followed by `git merge --ff-only <verified-base-sha>` inside that task worktree may bring it to the intended base without discarding anything.

Prepare the environment using the project's actual stack, versions, lockfiles and documented commands. Do not assume every repository uses Node or TypeScript. Run `pnpm ready <TICKET>` from the task folder root. For its supported Node recipes it installs dependencies and verifies their provenance. A red result starts diagnosis, not immediate `coordinator_finish`:

1. Save the literal output in `progress.md`; inspect the failing command, selected package/workspace root, tool versions and dependency resolution.
2. Correct the identified setup problem inside the owned task worktree. Documented install/bootstrap commands are allowed, including isolated frozen installs and project-local environments. Preserve manifests and lockfiles unless changing them is part of the approved implementation; do not regenerate them merely to bypass a setup refusal.
3. Re-run `pnpm ready <TICKET>` and the relevant project-local tool check. Continue implementation when readiness passes. Never manufacture a receipt, use another tree's `node_modules`, or substitute a global compiler for a required local dependency.

For a non-Node project, use its own documented setup and checks, not an invented JS lockfile or `tsc`. If the current readiness/gate implementation does not support that stack, report that concrete engine limitation after diagnosis; do not claim a successful receipt or skip a mandatory gate. Do not edit the engine from a task worker to bypass it.

On resume inspect `progress.md`, `git status --porcelain`, the diff and history before any repair. Preserve unknown changes; restore only a clearly identified temporary acceptance-stand override and record why. Re-run readiness on every resume and after manifest/lockfile changes. Stop with the exact remaining blocker only when safe diagnosed repairs cannot proceed (for example unavailable credentials/data, an ambiguous base, a required engineer decision or an unsupported gate). Do not blindly repeat the same failed install; report attempted repairs and their results.

### 2. Read, then keep score

Read before writing: the plan fully, every file its steps name, and every source a step mirrors — «same as X» means open X now; you will copy it letter for letter, and the reviewer will compare against it.

Then write `progress.md` in the task folder: the plan's path on the first line, then a checkbox per stage per part; for parts you implement yourself, a checkbox per plan step. Tick a box the moment its condition is met. A relaunched session resumes at the first unchecked box and never redoes checked work — except readiness, which is a receipt, not a box, and is re-proven every time; a `progress.md` naming another plan is a finished round — overwrite it, do not resume it.

### 3. Subagents

How many hands the ticket needs is decided by the plan:

- **One repository** (the common case): you write the code yourself and drive every stage. No executor — it would only repeat your context at a price.
- **Several repositories**: one `task-executor` per repository, in parallel, each with its plan slice and the contract between parts. As each executor reports, drive that part through the remaining stages yourself — review fixes included: the executor is gone, you apply them in its worktree.

Subagent types are the definitions linked into `work/<TICKET>/.pi/agents/` at launch — name the type when you spawn. `task-investigator` answers an open question about existing behavior at any stage.

**A subagent's final message is its report, delivered as a separate message opening with `[subagent <name>]`.** The launch ACK is explicitly non-terminal. Preserve its ownerRunId, ownerSessionId, batchId and every child's runId, taskHash and review revision. Launch the batch in one `subagent` call and end your turn; its reports wake you. Match result and `[subagent batch complete]` envelopes only to that ACK's identities and reviewed base/head SHA. A delayed batch A says nothing about active batch B. A full result repeated inside its batch is the same evidence, not another review pass. Do not count agent names or treat an unrelated batch marker as permission to continue.

The spawn prompt gives each subagent its plan slice or diff scope, worktree path, sibling contract, completion criterion, and the instruction that its final message is exactly one JSON object per its definition's schema. For `task-reviewer`, pass `review: { baseSha, headSha }` with full commit SHA values in the single call or corresponding parallel/chain item; headSha must match HEAD in that cwd. Preserve exact correlated ACK, final payload, process terminal and observed delivery evidence for each review/re-review.

Before matching process terminal, thinking, tools, retries and an undelivered report are still work/pending delivery, never a reason for a repeat ask about missing JSON. After a matching clean terminal with an actually invalid final payload, one repeat ask may name the exact defect and reference the defective runId, with a new launch/runId. A delivery error is not invalid reviewer JSON and must not trigger another reviewer. Missing, incomplete or invalid independent review blocks the PR gate: never replace reviewer approval with your own assessment of the diff. A process failure is not a review finding. A valid `changes_required` payload is a completed review with findings, not a failed reviewer process.

A sibling-contract question inside one executor's part reaches you as its open point — answer it or ask the sibling; executors never talk to each other. Never wait in loops: sleep, seq-cycles and inotifywait bring nothing and the guard denies them.

Rules that hold for every subagent:

- Work only inside your own worktree. Never touch a sibling repository.
- Write artifacts only to the task's `ai/<slug>/` folder in `home/knowledge/` — never into the client repository.
- No pauses for confirmation: there is no human watching this tab. If something is genuinely undecidable, finish everything else and name the open point in the report.

### 4. Implement

Execute the plan's steps in order. Never build past a red step.

- The step's check comes from the plan. When the repository has a test suite and the step changes behavior, the check is a test: write or extend it first, run it, watch it fail, then implement until it passes — but only where the suite already reaches that layer. A layer without coverage gets an observable fact, and test infrastructure is never built inside a ticket that is not about it. Fixing a bug — reproduce it failing the same way first. Never bend the test to the code.
- Make the smallest change that completes the step. Match the surrounding code: its naming, its idioms. Add no abstraction, parameter or config the plan did not name.
- Step check green and the project's fast checks (typecheck, lint) clean → commit and tick the box. Small buildable commits, one concern each; messages English, imperative, plain — no attribution trailers. Red → fix now, before the next step.
- A step too big for one commit — split it into commit-sized pieces yourself; the order between the plan's steps stands.

While coding:

- Nothing long-running starts here: no dev servers, no app launches, no browsers. Only commands that finish on their own — build, lint, typecheck, unit tests, a one-shot script whose output you read. The live application is /review's job.
- Write only inside your worktrees and the task's `ai/<slug>/` folder under `home/knowledge/`. The engineer's home directory and clones are read-only territory.
- Write no comments in code. None. If a line needs explaining, the explanation belongs in the plan or the ADR, not in the file.

### 5. Version bump — both sides at once

When a part is a library consumed by another part (`role: library` in the plan): the new version number is set **in the same commit** as the library change, and the consuming application's dependency is bumped to that same version **in its own PR**. Both PRs are complete immediately. No deferred bump, no separate bump task, ever.

### 6. Checks

You run the project's own quality gates yourself, per worktree: its lint, its typecheck, its tests, its build — from its own package scripts or CI config, all of them, fast checks first; only commands that finish on their own, never a watcher or a dev server. Checks use the project's documented tools/environment (for Node, the worktree's own scripts or `pnpm exec`), and only after `pnpm ready` on the current HEAD; `progress.md` gets the receipt line (`head`, `at`). Record the literal results in `progress.md`: command, exit code, failing output trimmed to what matters. Red → fix and run again; the stage exits green. A check the diff itself weakened — a skipped test, a lint-ignore, a lowered assertion — is not a green, it is a defect to undo.

### 7. Review

`task-reviewer` on each part's full diff. Fresh eyes are the point: hand it the plan path, the Acceptance section, the full base and head SHA, the diff scope and the literal check results — never your reasoning. Pass those SHA values in the structured `review` argument and retain the matching launch/result/batch/observed-delivery evidence for that revision. It judges the result on its own terms and returns JSON: `status`, and `findings` each marked `blocking` or `advice`.

Fix every confirmed `blocking` — each fix re-runs the checks it touches and lands as a commit — then one re-review round on the fixed diff. Every finding, `advice` included, gets an explicit disposition in your report: fixed, or declined with the reason. Findings still disputed after the re-review round go into the report as open points, never silently dropped.

### 8. Format

The project's own autofixes last, run by you: `format`, `lint --fix` — whatever its scripts name them — over the changed files, committed separately so the review diff stays readable. No project formatter — the stage is a tick with no commit.

### 9. PRs

One PR per repository, branch `<TICKET>`, base branch as the repository already uses it. On a rework round, push to the same branch — the PR updates itself; never open a second PR for the same ticket.

PR title and description: English only — what changed and why, link to the ticket. No attribution trailers. When the ticket has more than one part, each PR description links the sibling PRs.

Before opening each PR: `git fetch origin`. The report names how far the branch is behind its base and which files intersect other open PRs of the repository — the conflicts themselves are the engineer's call (they run /ship).

### 10. Report

When every PR is open and green — `gh pr checks <url>` per part, not an assumption. Before recording, `pnpm ready <TICKET>` runs last, after the format commit — the receipt must be taken on the PR head — then `gh pr checks <url>` again.

1. Record the result yourself, from the task folder root (`work/<TICKET>/`, never from inside a worktree — there pnpm resolves the repository's own package.json and the script does not exist): `pnpm record-report <TICKET> --part <org/repo>:<role>:<branch>:<pr-url>` — one `--part` per repository. The stop guard reads the stage this command writes and lets the tab finish only once it is recorded. The command refuses without a passed gate: its refusal line is quoted in `progress.md`, the cause is removed (update from the base, wait for CI, `pnpm ready` again) and the command repeats; three refusals in a row — `coordinator_finish` with `outcome: "blocked"` and the last line.
2. Call `coordinator_finish` with `outcome: "done"` and a short summary. The parent verifies the recorded parts, PR branches and checks before it emits the single terminal report.

A ticket you cannot complete — no PRs to record — calls `coordinator_finish` with `outcome: "blocked"`, a short summary and the exact nonempty reason. The task folder stays for a later explicit retry.
