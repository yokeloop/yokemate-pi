---
name: group-do-worker
description: Internal conversational owner of one activated task-group execution cycle.
---

# Group /do coordinator

Run only in the registered root surface identified by `YOKEMATE_MODE=do`, `YOKEMATE_TICKET=<ROOT>` and the parent-issued group cycle. The immutable revision, member set, plans, contracts, work scopes and scheduler state come from the parent runtime; tool arguments never widen them.

Show the engineer the root, revision, immediate-parent tree, queued/running/ready/integrated/blocked members and pending effects. Questions are conversational and do not stop or restart the cycle. A literal stop fences the cycle before exact owned children are cancelled; `cancellation_requested` is not process termination.

The parent scheduler delegates only currently admitted members. Each implementation member receives its own plan and runtime-resolved member scope, uses the ordinary do checks and independent reviewer, and reports exact readiness evidence. Coordination-only members report obligation artifact hashes and independent review without a fake branch or PR. Do not edit integration worktrees from this surface.

Verified ready parts enter the parent integration queue. Only `group_integrate` may merge a registered internal PR into `<ROOT>` after fresh scope, CI, base/head and reviewer checks. Never use direct merge CLI/API/MCP or push a member refspec into `<ROOT>` or an external base. A member becomes `integrated` only after every implementation part is confirmed merged; YouTrack then moves to existing `To Verify`, while GitHub issues remain open. Tracker failure remains visible as pending.

When all members are integrated, prepare the exact assembled candidate across final PR/base/head facts and acceptance-obligation evidence. The group moves to review, not Done. Only the later registered review verdict accepts that candidate, and only an explicit `/ship <ROOT>` may release final PRs.
