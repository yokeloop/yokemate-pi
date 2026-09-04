# PLAN-FORMAT — the shape of a plan

One format for every plan, whoever writes it — `/plan`, or `/review` (a rework plan). `/do` executes the plan literally and the reviewer compares the diff against it, so what the plan does not say is not in the ticket. The modes reference this file and do not restate it.

## Sections, in order

### Goal

What the ticket changes, in a few sentences: the problem and the intended outcome. For a rework plan — the acceptance remarks, each one the engineer's words quoted verbatim.

### Affected repositories

Every repository the ticket touches, one line each, with the part's role: `library`, `app`, or `backend`. One repository is still a line — the section never leaves the reader guessing.

### Cross-repository contract

Only when the ticket touches several repositories: the contract between parts, letter-precise — export names, API shapes, versions. A library part names the version the consuming part will ask for. Single-repository ticket — omit the section.

### Steps

An ordered list of code changes. Each step:

- names its files and functions;
- says what changes — specific enough that the executor asks nothing: where prose would be ambiguous, the exact identifier; a code fragment only where words cannot carry the shape;
- says how to prove it done: the project's own check (test, typecheck, build) or an observable fact. When the repository has a test suite and the step changes behavior, the check is a test — named, existing or new, and only where the suite already reaches that layer; a layer without coverage gets an observable fact instead, and building test infrastructure is never part of a ticket unless the ticket is about it.

Order by what unblocks what. A step is small enough to build and check alone, big enough to move the ticket. A step that mirrors an existing source («same as X») names that source's exact file — the executor copies against it and the reviewer compares against it; «same as X» without X's path is a gap.

In a rework plan, a step exists per remark: the quote, the located cause — files and lines, because a fix guessed at a symptom is not a plan item — the concrete change, and the check that proves it fixed.

### Assumptions

Choices the plan's author made without asking, for the engineer to override. An assumption names the choice and the reason — it is a decision on record, not a question in disguise.

### Out of scope

What this ticket deliberately does not change. The line that keeps `/do` from widening.

### Acceptance

What the engineer will see and check on the stand at `/review`: observable behavior with its trigger — «когда X — Y видно на стенде» — never internals, never «работает корректно». One list, used twice: `/do` proves these technically, `/review` walks them with the engineer.

## The bar

- No alternatives anywhere in the text: options live in the interview; the plan names one way.
- A plan handed to `/do` carries no open questions — `/plan` closes the forks with the engineer before the plan is written.
- Complexity must trace back to the ticket's own requirements, never to speculation about the future.
