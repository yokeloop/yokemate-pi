---
name: plan
description: Take a problem or an existing ticket to a plan ready for /do, in a new tab by default, or a split with --split — questions to the engineer in that surface, code reconnaissance and plan-writing in subagents. Triggered by "/plan [--split] <problem>" or "/plan [--split] <KEY> [<KEY> …]".
---

# /plan — from problem or ticket to a ready plan

You drive one request to a plan `/do` executes without follow-ups, in this mode surface: questions to the engineer land in this same feed, code reconnaissance and plan-writing run in the `plan-scout` and `plan-writer` subagents. The plan is the only thing `/do` receives: everything it gets wrong traces back to a line this conversation left soft. Do not stop halfway: a plan with «разберёмся по ходу» in it is not done. Read the effective runtime settings from the system context. A plain `/plan KEY` is always plan-only at both workflowApproval values: scout → questions → writer → record → report and stop. Only a parent-owned advance plan+do receipt, created from the engineer's same raw interactive input, can continue after the actual record. `workflowApproval=true` always stops at the ready plan; false lets the live parent handoff consume that existing receipt. Settings never authorize issue creation, scope changes, missing facts or external authentication. Explicit stop/cancel always wins.

## Where this runs

One command runs before anything else — before the tracker, before the code. In a stamped plan surface (`YOKEMATE_MODE=plan`), check its launch identity, never reconstruct it from the worker text:

```
pnpm where plan "$YOKEMATE_TICKET"
```

With no ticket stamp, run `pnpm where plan`. The optional `YOKEMATE_PLAN_LITERAL` environment value is a JSON array identifying the literal suffix of the delivered worker words. Those suffix words are note/problem context, never planning keys or launch controls, even when they look like ticket keys. Preserve them as context; for ticket-only input, take the one existing planning key from the individual ticket stamp. Mixed input remains one problem interview: its pre-literal keys are context, and its first key supplies identity/model, not a list of tickets to plan. The separator itself is not worker text.

Outside a stamped plan surface, run `pnpm where plan [KEY …]` with every named key before the first `--` in input order, excluding control values; without keys when it is only a problem statement. Keep the full input separately for the launcher.

- **`launch`** — the unstamped main chat: run `pnpm split plan <original arguments>` unchanged and return its output lines, then stop. A new tab is the default; `--split` before `--` requests a split. An explicit list of keys launches one independent surface per key in input order, each with its own model/identity and one result line. Explicit `--model` and literal context apply to every target; a failed target does not stop its siblings. No planning work happens in the main chat.
- **`run`** — the stamped /plan mode surface: do the work below, then report as «In a mode surface» says.
- **`refuse: …`** — print that line as it came and stop.

## Input

- `/plan <KEY> [<KEY> …]` — the launcher fans an explicit list out into independent workers: each surface receives only `/skill:plan <KEY>` plus shared literal context and `YOKEMATE_TICKET=<KEY>`. In this worker, take only that key through «By ticket» — reconnaissance → questions → plan → record — and send its separate outcome to the parent pane. Never process sibling keys or reconstruct a joined stamp. A refused or unavailable key gets a line naming it and the reason.
- `/plan <problem>` — no ticket yet: interview → tickets in the tracker → a plan per ticket. Start at «By problem». Mixed input (keys and problem words before the literal suffix) also starts at «By problem», with the keys as context. Single-key input with only literal context still starts at «By ticket». Keep the whole problem interview and its subsequently created ticket package in this surface; never fan it out retroactively.

## By problem

First fix the scope: which project and tracker the words point at. The engineer's own words, `pnpm on-me` and the project passports answer this — ask only when they do not.

### Interview

Every question goes into the feed as plain text — one question at a time, then stop and wait for the engineer's reply. The shape: the question on its own line, under it 2–4 options as a list, the recommended one first and labelled `(рекомендую)`, one line of reasoning under each. The remaining options are the strongest real alternatives, not strawmen. «Своё» is always possible — the options are a starting point, not a cage. Facts you established go *before* the question, in two or three lines, and the question itself stays one question — a wall of findings with a question at the end is not an interview.

Ask only where no reasonable default exists and the answer changes the ticket's scope — a handful of questions, not an interrogation. A default you picked yourself goes into the plan as an Assumption the engineer can override. The code comes first: what the repository answers is not a question — look it up, or send `plan-scout`, before asking. The scout returns by message like everywhere else: end your turn after sending it and continue the interview when its report arrives.

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

Then ask one question in that same shape: «Заводим?» — «Заводим» / «Есть замечания». On remarks: fix what they name and print the corrected package again, still creating nothing. Only explicit engineer approval opens what follows; workflowApproval does not authorize issue creation.

### Tickets

Create the package's tickets in the project's YouTrack via its MCP (`youtrack-<org>`), in the order they were confirmed — one issue per ticket, the four fields as the body; the summary is ~10 words naming the problem, not the solution. No epics, no parents, no child tasks. Name every key and its target in your reply: «YM-88 создан в youtrack-yokeloop». For a project whose passport carries `tracker` = `github`, the ticket is created with `gh issue create -R <owner>/<repo> --title "<summary>" --body "<четыре поля>"` and the key in the report is `<PREFIX>-<номер issue>`.

Then take each created ticket through «By ticket» below. The interview already answered the plan's questions, so the questions round usually comes up empty — hand `plan-scout` the four fields along with the key.

## By ticket

1. **Reconnaissance** — read the ticket and its comments from the tracker yourself (`youtrack-<org>` MCP; for a github-project — `gh issue view <номер> -R <owner>/<repo> --comments`) — the subagent has no tracker access — then spawn the `plan-scout` subagent: the ticket's text and comments (or the interview's four fields), the key, the project, its clone at `projects/<org>/<project>/` and its knowledge at `home/knowledge/<org>/<project>/`. For a problem-created package, pass `ticket: <created-key>` in every scout tool item; never infer it from prose or batch order. The tool returns at once. Accept only the correlated terminal envelope whose payload is valid, whose ticket/task hash match, and whose publication reference says `complete`; a textual `[subagent plan-scout]` prefix is not acceptance. The full report is the hash-checked artifact named by the envelope, not its bounded preview. It has already been published in the source task before you continue to Questions. A failed transport, missing/tampered artifact, or pending publication stops only this key: name the target, safe reason and durable pending status; never duplicate the comment manually through MCP. Not solvable with what is given → report exactly what is missing and stop; no plan gets written around a hole.
2. **Questions** — close the scout's forks with the engineer, inline, one at a time: the same question shape as the interview above. Start from the forks; a gap becomes a question only when the answer changes the implementation — everything else you close from the code yourself. Order: what blocks the contract between parts first, cosmetics last. When an answer can be found in the code faster than asked — look it up and present it as a fact with the source, not as a question. The engineer's word is input, not a hypothesis: if it diverges from what the code shows, say in one line what else will be needed — then record the decision as given. The engineer's answer ends the question: never re-ask it, never argue it back, never offer the rejected option again in a later question. The plan may only get simpler as the questions go — a question that adds a step is you widening the ticket, and scope is not yours to name. The moment the talk drifts into free-form argument, return to one question at a time. An ADR is the record of a past ticket's decision, not a rule for this one: cite it as context with its date and ticket; never argue it back at the engineer as law. Never a question: extra logs, extra checks, release, versioning, merging — nothing that does not change the solution itself.
3. **Plan** — spawn the `plan-writer` subagent with the key, project, the full verified scout artifact, every decision and the original ticket. It writes the plan in the shape `PLAN-FORMAT.md` defines to `home/knowledge/<org>/<project>/ai/<KEY>-<slug>/<KEY>-<slug>-plan.md` and returns only the path. The tool returns at once. Accept only its correlated valid terminal envelope. Read the saved plan yourself, verify its ordered form and decisions, and fix any open question through the writer before Record; the writer never publishes its draft.
4. **Record** — `pnpm plan <KEY> <plan-path>`. This preflights the accepted scout publication, records the exact reviewed bytes, then publishes the separate full plan with knowledge path, revision and successful-record status. Retain the key, target and path for the outcome report. Exit zero and «ready» are valid only when both publications are remotely complete. A post-CAS failure is reported literally as locally recorded/planned with publication pending; do not say ready and do not start automatic do. Without advance authority, or when `workflowApproval=true`, a fully published plan is ready for `/do`. With an existing advance receipt and false, report the actual run ID or literal refusal. Never call `pnpm spawn`, add authority flags, or duplicate comments manually.

The four steps above run to their end even when the engineer types into the feed midway: answer what they asked, then take up the same step and say which one you are returning to — «отвечаю и возвращаюсь к шагу 2, вопросы». Only a message aimed at the planning itself — stop, another ticket, a decision changed — replaces the step instead of resuming it. A flow that ends on a stray question leaves no plan, no `planned` row, and nothing in the feed saying so.

## In a mode surface

When every plan of the run is recorded, send the outcome to the pane the mode was launched from as a courtesy: one `send_message` call, the report as `text` — the address is derived, `to` is not passed. It is a few lines: the keys and their plan paths, ready for `/do`. A result of `unreachable: <reason>` → say the report in this pane — the plans are already recorded either way.

Then wait: the mode surface (default tab or explicit split) is conversational, and closing it is the engineer's — never yours, and never the main chat's (`close-mode` does not know plan).

## Glossary and ADRs — maintained inline, as decisions crystallize

Two layers, both under yokemate (never in the client repository):

- **Process words** — terms of the workflow itself → `<yokemate>/context.md`.
- **Repository words** — the product's domain terms → `home/knowledge/<org>/<project>/context.md`.

The rule for choosing the layer: a word about the *product* goes to the project file, a word about the *process* goes to the shared file. Duplication between projects is acceptable; ambiguity inside one project is not.

A decision that constrains future work (architecture, contract, irreversible choice) → one ADR in `home/knowledge/<org>/<project>/adr/NNNN-<slug>.md`: context, decision, consequences. Number sequentially.

## Outcome

One report in the feed after the run, for this worker’s key (or one line per ticket created by its problem interview in order): key — publication target — plan path, or key — refusal/pending reason. Every successful ticket has both complete tracker publications, its exact plan recorded, and `pnpm queue` showing `planned`. A locally recorded plan with pending publication is named that way and is not ready for do. A ready plan is not do approval. An explicit subsequent `/do` or unambiguous natural-language approval creates a fresh parent-owned receipt on the current recorded plan; changed content or scope requires new approval. Publication can resume after restart, but authority cannot: without a live fresh parent receipt no automatic do starts.
