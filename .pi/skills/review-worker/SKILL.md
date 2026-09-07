---
name: review-worker
description: Internal — raised by pnpm review, not typed by the engineer. Acceptance of a ticket — raise the stand inside the task folder, prove the parts are linked, walk the engineer through the plan's Acceptance checklist. Remarks become a rework plan; a clean pass marks the ticket accepted and leaves the task folder standing for /ship.
---

# /review — acceptance

You raise the stand for one ticket and walk the engineer through it. The repositories are in `work/<TICKET>/`, in the right branches — nothing is copied; when the folder is missing, `pnpm adopt` rebuilds it (step 1). Your pane sits at the yokemate root; the stand lives in `work/<TICKET>/` and you reach it by path.

## Where this runs

You are the worker: the split raised by `pnpm review` is prompted with this skill — the engineer never types it. One command runs before anything else — before the tracker, before the code:

```
pnpm where review <TICKET>
```

- **`run`** — this is the review split. Do the work below.
- **`launch`** — this is the main chat: the work does not happen here. Answer «type /review <TICKET>» and stop.
- **`refuse: …`** — print that line as it came and stop.

## 1. Raise the stand

No `work/<TICKET>/` on this machine — run `pnpm adopt <TICKET>` first: it rebuilds the stand and the review row from observable facts (the plan in `home/knowledge/`, the `<TICKET>` branches, the open PRs). If adopt fails, print its line to the engineer exactly as it came and stop — it is transfer diagnostics (a plan not pushed from the dev machine, a missing PR), and it cannot be fixed from this pane. After adopt the order below is unchanged: fetch, the behind-base check, the stand recipes.

Read the parts and their roles from the plan (and `part.role` in the orchestrator's report if given).

First read how the project runs itself: `justfile`, `package.json` scripts, README, `.yoke/flow.md`, `home/knowledge/<org>/<repo>/context.md` and `flow.md`. The stand runs on the project's own dev recipe — never a production build, never a hand-assembled command when a recipe exists. Before raising anything: `git fetch`; if the branch is behind its base, the proof block says so.

- **library** → one-off install and build in its worktree, then a `link:` override in the consuming app's `package.json`, its peers hoisted so both sides resolve one React — the dedupe list is the library's `peerDependencies` keys. The app builds against the linked package.
- **backend** → its own dev recipe on a free port; hand the address to the frontend via its environment variable. Watch the silent-failure default: `acme-subscription-page` proxies `/api` to `VITE_API_REMOTE_URL` — override it or the app silently talks to the remote stand.
- **app** → the project's dev recipe (`just dev`, `pnpm dev` — whatever the repo declares).
- **browser extension, or anything that cannot run standalone** → do not run it: build the unpacked artifact into `~/Downloads/<TICKET>-<repo>/`, give the engineer the path and the loading steps, and wait for their word.

Never drive the engineer's browser — no claude-in-chrome, no CDP into their instance; when a look is needed, ask the engineer for a screenshot. Kill only processes you started, by saved PID — never pkill — and stop them all when the review ends. What the engineer corrects about the stand goes into `home/knowledge/<org>/<repo>/flow.md` — the next review must not relearn it.

## 2. Prove it before showing it

Print the proof block — every line is a checked fact, not trust:

```
стенд <TICKET>                       work/<TICKET>
  <lib>    ветка <branch>  <sha>
    link established                 ✓/✗
    dist built from this commit      ✓/✗
    react in graph: 1 instance       ✓/✗
  <app>    ветка <branch>  <sha>
    builds against linked lib        ✓/✗
    → http://localhost:<port>
  versions agree: lib declares X, app asks ^X
```

Any ✗ — fix the stand first; the engineer's time starts when the block is green.

## 3. Walk the checklist

The plan's **Acceptance** section is the script of this session. Walk it one criterion at a time:

- Quote the criterion's expected behavior and say where on the stand to look. The engineer looks and speaks; the criterion gets its verdict — pass or remark — before the next one starts. The walk ends when every criterion has one.
- Anything the plan promised that the stand does not show is your finding to name, not the engineer's to catch — and it is named as yours, never attributed to the engineer.
- The engineer's question is not a remark. Answer it from the plan or the code; it becomes a remark only if the engineer says so once answered.
- What the engineer raises beyond the checklist is recorded the same way and marked as beyond it.

## 4. Remarks

Remarks are the engineer's words, recorded verbatim — never a word they did not say. Before anything becomes a plan, read the collected list back to the engineer and get their confirmation.

- **Remarks exist** → each remark is its own item, two defects never fuse into one: the engineer's words quoted, the steps to see it on this stand, expected against observed. Before it enters the plan, reproduce it on the stand and localize the cause to files and lines — a fix guessed at a symptom is not a plan item. Write the rework plan to the task's `ai/<slug>/` folder under `home/knowledge/`, in the shape `PLAN-FORMAT.md` at the yokemate root defines (its rework form): per remark — the quote, the cause, the concrete change with its files, and the check that proves it fixed. Then clean the stand's edits out of the worktrees — `git restore --staged --worktree .` in each: everything legitimate is committed by /do's contract, so any dirt (the `link:` override in package.json and the like) belongs to the stand. Then record the outcome yourself: `pnpm accept <TICKET> --rework <path-to-rework-plan>` — the ticket returns to `planned`; the next `/do` runs in the same folder, same branches, same PRs.
- **No remarks** → record it yourself: `pnpm accept <TICKET>` — the command marks the ticket accepted and removes the queue row. The worktrees and `work/<TICKET>/` stay exactly as they stand: /ship works in them and removes the folder after the merge — cleanup is /ship's ending, not acceptance's.

Either way the report says what was covered and what was not: a stand limitation — an extension loaded by hand, a serial port faked by a pty — is named out loud, not passed over.

## Report

The outcome is already recorded by the `pnpm accept` you ran; the main chat is told after the fact.

1. The report goes to the chat the mode was launched from — its session name is in `YOKEMATE_PARENT_AGENT`: `SendMessage` with `to` = the variable's value (the bare name) and the report, a few lines — ticket key, and either the rework plan's path or that the ticket is verified. If the send comes back ambiguous — a fresh `ListAgents`, one retry with the ref of the line carrying that name appended; two lines with one name, or no line at all — say the report in this pane and stop. When the variable is absent (a pane raised before this was wired), say the report in this pane and stop — the stage is already recorded either way.
2. Say the same line in this split.

This split is not closed for you. Say that acceptance is finished and wait: the engineer is standing here, and only the engineer knows it is over.

You never merge anything. Merging is the engineer's button in GitHub.
