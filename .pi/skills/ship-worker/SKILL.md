---
name: ship-worker
description: Internal — raised by pnpm ship, not typed by the engineer. Drive one accepted ticket to the merge — update it from its base, settle conflicts, push to the same PRs, wait out CI, serialize each fresh gated merge, log the outcome and remove the task folder.
---

# /ship — drive the ticket to the merge

The typed /ship command is the engineer's word to merge. For an accepted group root, only the final registered `<ROOT>` PRs of the current candidate are shipped; internal member PRs are already integration facts. Its accepted head and external-base SHA are immutable: fetch and inspect them, but if either base or head moved, do not update or push in ship — let `coordinator_merge` supersede the candidate, return the group to review, and stop for fresh assembly and acceptance. Preserve exact `merged/remaining/unknown` results. Do not update any open member to Done until every final merge is confirmed; after that update children postorder and the root last. Full merge with unfinished tracker effects is `all merged / tracker pending`, not done, and cleanup is a separate retryable effect. This coordinator owns one accepted key and takes it to the end — update from the base, settle conflicts, push, green CI, merge the PRs, log the outcome, remove the task folder. The repositories are already in `work/<KEY>/`, in the ticket's branches — nothing is copied, nothing new is planned. Sibling keys run independently; a shared remote/base merge is serialized only for the fresh gate-and-merge critical section.

## Where this runs

You are the long-lived background coordinator raised by `/ship` — the engineer never types this skill. One command runs before anything else, with the key the coordinator is stamped with:

```
pnpm where ship <KEY>
```

- **`run`** — this is the ship coordinator. Do the work below.
- **`launch`** — this is the main chat: the work does not happen here. Answer «type /ship <KEY> [<KEY> …]» and stop.
- **`refuse: …`** — print that line as it came and stop.

## Bring each branch to the base

Per repository worktree in `work/<KEY>/`:

1. **Fetch and read the convention.** `git fetch origin`. Then how this repository updates branches: `gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed`, CONTRIBUTING if it speaks, and the base's history shape (`git log --merges` — merge commits present or linear). Merge the base in where merge commits are the norm; rebase only where history is linear and the ticket branch has no commits but this ticket's own — and push that with `--force-with-lease`, never `--force`.
2. **Read intent before hunks.** The neighbor's merged PR — its description and commits (`gh pr list --state merged --base <base>`, the merge commit itself) — and this ticket's plan. You cannot preserve an intent you have not read.
3. **Settle each conflict so both intents survive.** Keep what the merged neighbor established and what this ticket changes; where both rewrote the same lines, the resolution leaves both behaviors true. Never resolve by flag or wholesale — no `--ours`, no `--theirs`, no deleting a block unread: a resolution can be syntactically perfect and still silently drop a change somebody made on purpose. Invent no new behavior. A hunk the plan cannot answer is resolved conservatively toward the neighbor's merged state and named in the report as an open point.
4. **A clean merge is untested, not settled.** First `pnpm ready <KEY>` from the yokemate-pi instance root: the tree changed with the update from the base, the frozen install on it is mandatory and may not change the lockfile. Semantic conflicts — a rename, a changed contract, a side effect moved elsewhere — merge clean and only checks expose them. Search the ticket's own diff for every identifier the neighbor's PR changed; then run the project's own checks — lint, typecheck, tests, build; only commands that finish on their own, nothing long-running.

## Merge

Still per key, once its branches stand on the base and the local checks are green:

5. **Push to the same PRs.** The PR updates itself. Then `gh pr checks <url> --watch --fail-fast` per PR — the one form of waiting there is: the command finishes on its own. No sleep, no polling loops.
6. **Serialized fresh gate → merge; refusal → stop.** For each remaining OPEN PR, call `coordinator_merge` with its exact URL, current full head SHA and the repository method established in step 1. The trusted parent serializes only that repository/base's fresh gate-and-merge section, rereads the current PR target and head, and passes exactly that fresh head to GitHub's match-head merge. A PR already confirmed MERGED is complete and is not requested again. Never call `gh pr merge`, `gh api`, a merge HTTP endpoint or an internal script directly. An `open`/`unknown` result or refusal, or red you cannot make green inside the ticket's scope → do not merge: put the literal output in the report and leave the folder and remaining PRs as they stand.
7. **Finalize through the parent.** After every PR of the key is confirmed merged, call `coordinator_finish` with `outcome: "done"`. The live parent verifies every prepared PR, idempotently appends and syncs the single shipped journal outcome under the shared home lock, and removes the task folder. Never append that line or remove the folder directly.

The scope is the update and the merge: no new features, no cleanups, no plan changes. Commit messages English only; no comments in code.

## Report

Merging is not the finish. After the key is merged, call `coordinator_finish` with `outcome: "done"`; that request owns finalization and can be retried after a partial finalization. On a blocker call it with `outcome: "blocked"` and the literal failing output. The parent emits this key's terminal result and the ordered list aggregate when every sibling is terminal.

The stage does not change — no «merged» stage exists; the accepted row has already left the queue.
