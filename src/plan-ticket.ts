import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { currentControlOrigin, requestPlanControl, resolveCoordinatorParent } from "./coordinator-control.ts";
import { recordPlan } from "./plan-record.ts";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const fail = (message: string): never => { console.error(message); process.exit(1); };
const argv = process.argv.slice(2).filter((argument) => argument !== "--");
const ticket = argv[0] ?? fail("usage: plan <TICKET> <path-to-plan.md>");
const planPath = resolve(argv[1] ?? fail("usage: plan <TICKET> <path-to-plan.md>"));
if (!existsSync(planPath)) fail(`plan not found: ${planPath}`);

try {
  if (process.env.YOKEMATE_PLAN_RUN_ID) {
    const reply = await requestPlanControl(ROOT, "record-plan", { ticket, path: planPath, runId: process.env.YOKEMATE_PLAN_RUN_ID }, currentControlOrigin(ROOT), resolveCoordinatorParent(ROOT));
    if (reply.state !== "accepted") fail(reply.reason ?? "plan record refused");
    console.log(`${ticket} → planned, plan: ${planPath}`);
    console.log(`${ticket}: ${reply.runId && reply.runId !== process.env.YOKEMATE_PLAN_RUN_ID ? `background run ${reply.runId}` : reply.reason ?? "plan-only; ready for /do"}`);
  } else {
    const result = await recordPlan(ROOT, ticket, planPath);
    console.log(`${ticket} → planned${result.repeat ? " (repeat)" : ""}, plan: ${result.plan}`);
    if (result.localSync.state === "deferred" || result.localSync.state === "error") console.error(`git-sync: ${result.localSync.reason}`);
    if (result.push?.state === "deferred" || result.push?.state === "error") console.error(`git-sync: ${result.push.reason}`);
    try {
      const reply = await requestPlanControl(ROOT, "plan-recorded", { ticket, path: result.plan }, currentControlOrigin(ROOT), resolveCoordinatorParent(ROOT));
      console.log(`${ticket}: ${reply.runId ? `background run ${reply.runId}` : reply.reason ?? "plan-only; ready for /do"}`);
    } catch (error) { console.log(`${ticket}: plan recorded; no automatic do handoff: ${(error as Error).message}`); }
  }
} catch (error) { fail(error instanceof Error ? error.message : String(error)); }
