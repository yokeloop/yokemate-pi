---
name: ship-worker
description: Internal — raised by pnpm ship, not typed by the engineer. Drive one or several accepted tickets to the merge — update each from its base, settle the conflicts, push to the same PRs, wait out CI, merge every PR, log the outcome and remove the task folder; a batch merges in order, each next key updating onto the base the previous one already entered.
---

# /ship — drive the ticket to the merge

The typed /ship command is the engineer's word to merge: you take each key to the end — update from the base, settle the conflicts, push, green CI, merge the PRs, log the outcome, remove the task folder. The repositories are already in `work/<KEY>/`, in the ticket's branches — nothing is copied, nothing new is planned. A batch of keys ships strictly in the order typed: the next key starts only after the previous one's PRs are merged.

## Where this runs

You are the worker: the tab raised by `pnpm ship` is prompted with this skill — the engineer never types it. One command runs before anything else, with the same `+`-joined key string the tab was stamped with:

```
pnpm where ship <KEY1+KEY2>
```

- **`run`** — this is the ship tab. Do the work below.
- **`launch`** — this is the main chat: the work does not happen here. Answer «type /ship <KEY> [<KEY> …]» and stop.
- **`refuse: …`** — print that line as it came and stop.

## Bring each branch to the base

Per key, in order; per repository worktree in `work/<KEY>/`:

1. **Fetch and read the convention.** `git fetch origin`. Then how this repository updates branches: `gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed`, CONTRIBUTING if it speaks, and the base's history shape (`git log --merges` — merge commits present or linear). Merge the base in where merge commits are the norm; rebase only where history is linear and the ticket branch has no commits but this ticket's own — and push that with `--force-with-lease`, never `--force`.
2. **Read intent before hunks.** The neighbor's merged PR — its description and commits (`gh pr list --state merged --base <base>`, the merge commit itself) — and this ticket's plan. You cannot preserve an intent you have not read.
3. **Settle each conflict so both intents survive.** Keep what the merged neighbor established and what this ticket changes; where both rewrote the same lines, the resolution leaves both behaviors true. Never resolve by flag or wholesale — no `--ours`, no `--theirs`, no deleting a block unread: a resolution can be syntactically perfect and still silently drop a change somebody made on purpose. Invent no new behavior. A hunk the plan cannot answer is resolved conservatively toward the neighbor's merged state and named in the report as an open point.
4. **A clean merge is untested, not settled.** Semantic conflicts — a rename, a changed contract, a side effect moved elsewhere — merge clean and only checks expose them. Search the ticket's own diff for every identifier the neighbor's PR changed; then run the project's own checks — lint, typecheck, tests, build; only commands that finish on their own, nothing long-running.

## Merge

Still per key, once its branches stand on the base and the local checks are green:

5. **Push to the same PRs.** The PR updates itself. Then `gh pr checks <url> --watch --fail-fast` per PR — the one form of waiting there is: the command finishes on its own. No sleep, no polling loops.
6. **Green → merge; red → stop.** Green checks → `gh pr merge <url>` by the method the repository's convention names (the `mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed` answer is already in hand from step 1). Red you cannot make green inside the ticket's scope → do not merge: put the literal failing output in the report, leave the folder and the PRs as they stand, and do not touch the keys that follow.
7. **Log and clean up.** After every PR of the key is merged: append `- YYYY-MM-DD HH:MM <KEY> отгружено` to `journal/YYYY-MM.md` at the yokemate root (same shape as the other outcome lines), then `rm -rf work/<KEY>` — the yokemate tree, the guard lets it pass.
8. **The next key starts fresh.** `git fetch origin` and the update from the base the previous key's merge already entered — that is the point of the order.

The scope is the update and the merge: no new features, no cleanups, no plan changes. Commit messages English only; no comments in code.

## Report

Merging is not the finish. The main chat has to learn about it — it closes this tab on your report, and the engineer follows the work from there.

1. The report goes to the chat the mode was launched from. It is a few lines — per key: the merged PRs, the checks before the merge, the removed folder; for a key stopped on red — the literal failing output and what stands untouched; open points if any. Deliver it by these steps:
   1. `SendMessage` with `to` = the value of `YOKEMATE_PARENT_AGENT` (the bare name) and the report.
   2. The send comes back ambiguous → a fresh `ListAgents`, one retry with the ref of the line carrying that name appended.
   3. The send comes back unreachable («No agent named …»), or the retry from step 2 failed too, or the variable is empty → a fresh `ListAgents`, find the **current** main chat: the interactive unstamped session of this pool — the line whose bare name is `yokemate` or of the form `yokemate-*` and which is not a mode pane (not a ticket key, not `*-review`/`*-ship`/`*-worklog`/`*-plan*`). Exactly one candidate → one retry `SendMessage` to it.
   4. Zero or several candidates, or the retry from step 3 failed too → say the report in this pane and stop.
2. Say the same line in this tab, then stop.

The stage does not change — no «merged» stage exists; the accepted row has already left the queue. The launching chat closes this tab (`pnpm close-mode ship <KEY1+KEY2>` — the same `+`-joined string from your report).
