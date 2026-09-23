---
name: grill-docs
description: Resolve planning ambiguities against project sources and preserve only explicitly authorized terminology and architectural decisions.
---

# Grill with docs during planning

This skill is a docs-aware phase of the existing `/plan` workflow. The plan worker owns the conversation and every documentation write. Return the resolved decisions to `/plan`; do not start another workflow.

## Establish the facts

Read the glossary, applicable ADRs, affected code, and the history of the affected files. Missing documentation is not a blocker. Separate current facts, past decisions, and proposals. Anything established by those sources is presented as a fact with its exact path and section or code location, not as a question.

Use the engineer's requested behavior as input. If it differs from the code, name the additional change needed to produce that behavior instead of disputing the answer. Present an applicable ADR as past context with its path, date, and ticket, never as a prohibition. Do not restore a rejected alternative later.

Ask only about a material unresolved term, a conflict between the requested behavior and a documented decision, or a behavior boundary that changes the implementation within the given scope. Probe those gaps with concrete scenarios. Do not widen the scope or invent questions for documentation. When there are no open questions, ask no questions; present the concise implementation approach and wait for its mandatory fresh interactive approval before the plan writer.

## Ask in the current surface

Ask in plain text, one question at a time, and wait for the answer. Offer 2–4 real options with the recommended option first and explain its reason; a free-form answer is always allowed. Sources and established facts precede the question. The engineer's answer closes it unless a new source reveals a genuinely new material gap.

## Distinguish decisions from permission

A resolved answer is a planning decision, not permission to edit documentation. An agent recommendation or the engineer merely naming a rule also grants no write authority. Propose the exact glossary entry or ADR content and write it only after the engineer's explicit instruction or permission to write. Once that authority is given, do not ask for it again. Whether or not a documentation write is authorized, pass the resolved decision into the plan.

## Glossary placement

Keep glossary entries short and free of implementation detail.

- Product or repository terms go to `home/knowledge/<org>/<project>/context.md`.
- Workflow process terms go to `<yokemate>/context.md`.

Create files and directories lazily, only for authorized content. Do not create empty glossary files, empty ADR directories, or placeholder documents.

## ADR threshold and placement

Offer an ADR only when all three criteria hold at the same time:

1. Hard to reverse: changing the decision later has meaningful cost.
2. Surprising without context: a future reader would not understand the choice from the result alone.
3. Real trade-off: genuine alternatives were compared and one was selected for reasons.

If any criterion is absent, keep the decision in the plan and do not create an ADR. An ADR is never mandatory for a ticket.

With explicit write permission, use the next free sequential path `home/knowledge/<org>/<project>/adr/NNNN-<slug>.md`. Record the date, ticket, context, decision, reasons, and consequences. When a new authorized decision conflicts with an older ADR, create a new ADR that links to the old one instead of silently rewriting history.

## Handoff

Return to the plan worker:

- final decisions and resolved conflicts;
- canonical term definitions;
- assumptions;
- exact paths and sections read;
- exact paths actually written, separately from sources merely consulted.

A local glossary or ADR write is not publication or synchronization. Continue the existing `/plan` flow with this handoff.
