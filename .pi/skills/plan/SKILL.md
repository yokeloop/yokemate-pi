---
name: plan
description: Take a problem or an existing ticket to a plan ready for /do, inline in the chat where it was typed — questions to the engineer in the same feed, code reconnaissance and plan-writing in subagents. Triggered by "/plan <problem>" or "/plan <KEY>".
---

# /plan — from problem or ticket to a ready plan

You drive one request to a plan `/do` executes without follow-ups, without leaving this chat: questions to the engineer land in this same feed, code reconnaissance and plan-writing run in the `plan-scout` and `plan-writer` subagents. The plan is the only thing `/do` receives: everything it gets wrong traces back to a line this conversation left soft. Do not stop halfway: a plan with «разберёмся по ходу» in it is not done.

## Where this runs

One command runs before anything else — before the tracker, before the code:

```
pnpm where plan [KEY]
```

— with the key when the input names one, without one when it is a problem statement.

- **`launch`** — the unstamped main chat: work inline right here, as below.
- **`run`** — a stamped /plan pane, raised by `/split plan`: the same work, here, ended as «In a pane» below says.
- **`refuse: …`** — print that line as it came and stop.

## Input

- `/plan <KEY>` — an existing ticket: reconnaissance → questions → plan. Start at «By ticket».
- `/plan <problem>` — no ticket yet: interview → tickets in the tracker → a plan per ticket. Start at «By problem».

## By problem

First fix the scope: which project and tracker the words point at. The engineer's own words, `pnpm on-me` and the project passports answer this — ask only when they do not.

### Interview

Every question goes into the feed as plain text — one question at a time, then stop and wait for the engineer's reply. The shape: the question on its own line, under it 2–4 options as a list, the recommended one first and labelled `(рекомендую)`, one line of reasoning under each. The remaining options are the strongest real alternatives, not strawmen. «Своё» is always possible — the options are a starting point, not a cage. Facts you established go *before* the question, in two or three lines, and the question itself stays one question — a wall of findings with a question at the end is not an interview.

Ask only where no reasonable default exists and the answer changes the ticket's scope — a handful of questions, not an interrogation. A default you picked yourself goes into the plan as an Assumption the engineer can override. The code comes first: what the repository answers is not a question — look it up, or send `plan-scout`, before asking.

Stop when the four fields are filled without guesses for every ticket of the package:

1. **Problem** — what is wrong, observably: expected against actual, facts separated from hypotheses.
2. **Cause** — why, to the depth it is actually known; investigate the code yourself when reading it settles the question faster than asking. An unverified cause is written as a hypothesis, never as a fact.
3. **Path** — the intended change, at least formally: which repositories, which direction.
4. **Done criteria** — each one names its trigger and the observable response: «когда X — Y видно на стенде». Concrete enough to run as a check at acceptance; «работает корректно» is not a criterion.

### The cut

One run covers one request of the engineer's, however many tickets it cuts into — the interview's context is exactly what makes the tickets good, and cutting it into separate runs loses it.

The cut is by atomicity: a ticket carries a description under which it can be done and deployed to production on its own. Chains are possible and are avoided — they make the work harder; when one is unavoidable, each plan's Goal names its place in the order and what it waits for.

A problem outside the engineer's request is not part of the package: say so in one line and keep it out.

### Validation

Nothing reaches the tracker before the engineer has seen it. When the interview is closed, print the whole package in one message — per ticket: the summary, then Problem, Cause, Path and Done criteria in full. The whole cut is visible at once; that is what the package is for.

Then one question in that same shape: «Заводим?» — «Заводим» / «Есть замечания». On remarks: fix what they name and print the corrected package again, still creating nothing. Only «Заводим» opens what follows.

### Tickets

Create the package's tickets in the project's YouTrack via its MCP (`youtrack-<org>`), in the order they were confirmed — one issue per ticket, the four fields as the body; the summary is ~10 words naming the problem, not the solution. No epics, no parents, no child tasks. Name every key and its target in your reply: «YM-88 создан в youtrack-yokeloop». For a project whose passport carries `tracker` = `github`, the ticket is created with `gh issue create -R <owner>/<repo> --title "<summary>" --body "<четыре поля>"` and the key in the report is `<PREFIX>-<номер issue>`.

Then take each created ticket through «By ticket» below. The interview already answered the plan's questions, so the questions round usually comes up empty — hand `plan-scout` the four fields along with the key.

## By ticket

1. **Reconnaissance** — read the ticket and its comments from the tracker yourself (`youtrack-<org>` MCP; for a github-project — `gh issue view <номер> -R <owner>/<repo> --comments`) — the subagent has no tracker access — then spawn the `plan-scout` subagent: the ticket's text and comments (or the interview's four fields, which already carry the same), the key, the project, its clone at `projects/<org>/<project>/` and its knowledge at `home/knowledge/<org>/<project>/`. It returns facts with sources, assumptions, and forks with recommendations; its final message comes back as the tool result. Not solvable with what is given → report exactly what is missing and stop; no plan gets written around a hole.
2. **Questions** — close the scout's forks with the engineer, inline, one at a time: the same question shape as the interview above. Start from the forks; a gap becomes a question only when the answer changes the implementation — everything else you close from the code yourself. Order: what blocks the contract between parts first, cosmetics last. When an answer can be found in the code faster than asked — look it up and present it as a fact with the source, not as a question. The engineer's word is input, not a hypothesis: if it diverges from what the code shows, say in one line what else will be needed — then record the decision as given. The engineer's answer ends the question: never re-ask it, never argue it back, never offer the rejected option again in a later question. The plan may only get simpler as the questions go — a question that adds a step is you widening the ticket, and scope is not yours to name. The moment the talk drifts into free-form argument, return to one question at a time. An ADR is the record of a past ticket's decision, not a rule for this one: cite it as context with its date and ticket; never argue it back at the engineer as law. Never a question: extra logs, extra checks, release, versioning, merging — nothing that does not change the solution itself.
3. **Plan** — spawn the `plan-writer` subagent: the key, the project, the scout's facts and every decision made above. It writes the plan in the shape `PLAN-FORMAT.md` defines to `home/knowledge/<org>/<project>/ai/<KEY>-<slug>/<KEY>-<slug>-plan.md` and returns the path. Read the result: an open question left in it is a defect — send it back with the decisions it missed.
4. **Record** — `pnpm plan <KEY> <plan-path>`, then one report line right here in the feed: the key, the plan's path, ready for `/do`. Inline, no `send_message` — the chat you would report to is the one you are in.

## In a pane

The `run` verdict changes only the ending. When every plan of the run is recorded, send the outcome to the pane the mode was launched from as a courtesy: one `send_message` call, the report as `text` — the address is derived, `to` is not passed. It is a few lines: the keys and their plan paths, ready for `/do`. A result of `unreachable: <reason>` → say the report in this pane — the plans are already recorded either way.

Then wait: the pane is conversational, and closing it is the engineer's — never yours, and never the main chat's (`close-mode` does not know plan).

## Glossary and ADRs — maintained inline, as decisions crystallize

Two layers, both under yokemate (never in the client repository):

- **Process words** — terms of the workflow itself → `<yokemate>/context.md`.
- **Repository words** — the product's domain terms → `home/knowledge/<org>/<project>/context.md`.

The rule for choosing the layer: a word about the *product* goes to the project file, a word about the *process* goes to the shared file. Duplication between projects is acceptable; ambiguity inside one project is not.

A decision that constrains future work (architecture, contract, irreversible choice) → one ADR in `home/knowledge/<org>/<project>/adr/NNNN-<slug>.md`: context, decision, consequences. Number sequentially.

## Outcome

Per ticket: the plan recorded, `pnpm queue` showing `planned`, one line in the feed naming the key and the plan's path. The tickets go to work only when the engineer says so — a recorded plan queues nothing.
