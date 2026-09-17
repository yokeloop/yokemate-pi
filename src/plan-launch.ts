import { join } from "node:path";
import { herdrAsync, startAgentAsync } from "./herdr.ts";
import { openModeSurfaceAsync, type Surface } from "./mode-surface.ts";

export interface PlanLaunchTarget { ticket: string; workerWords: string[] }
export interface PlanLaunchRequest { targets: PlanLaunchTarget[]; surface: Surface; model?: string; literal: string[]; parentPane: string; parentWorkspace: string }
export interface PlanLaunchFacts { paneId: string; tabId?: string; agentName: string; model: string }

const sanitize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");

export async function launchPlanKey(root: string, request: PlanLaunchRequest, target: PlanLaunchTarget, keyRunId: string, model: string, bind: (pane: string) => Promise<void>): Promise<PlanLaunchFacts> {
  const label = `${target.ticket} plan`;
  const agentName = `${sanitize(label).slice(0, 23)}-${keyRunId.replaceAll("-", "").slice(0, 8)}`;
  const env = [
    "YOKEMATE_MODE=plan",
    `YOKEMATE_TICKET=${target.ticket}`,
    `YOKEMATE_PARENT_PANE=${request.parentPane}`,
    "YOKEMATE_ROLE=coordinator",
    `YOKEMATE_PLAN_RUN_ID=${keyRunId}`,
    `YOKEMATE_RUN_ID=${keyRunId}`,
    ...(request.literal.length ? [`YOKEMATE_PLAN_LITERAL=${JSON.stringify(request.literal)}`] : []),
  ];
  const opened = await openModeSurfaceAsync(request.surface, request.parentPane, request.parentWorkspace, root, label, env);
  try {
    await bind(opened.paneId);
    await startAgentAsync(agentName, opened.paneId, `${label} [${keyRunId.replaceAll("-", "").slice(0, 8)}]`, ["--model", model, "--skill", join(root, ".pi", "skills")]);
    await herdrAsync(["agent", "prompt", agentName, `/skill:plan ${target.workerWords.join(" ")}`]);
    return { paneId: opened.paneId, tabId: opened.tabId, agentName, model };
  } catch (error) {
    try { opened.cleanup(); } catch {}
    throw error;
  }
}
