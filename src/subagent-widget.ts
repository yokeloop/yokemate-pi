export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export const TASK_EXCERPT_BUDGET = 24;

export function taskExcerpt(task: string): string {
  return task.replace(/\s+/g, " ").trim().slice(0, TASK_EXCERPT_BUDGET).trimEnd();
}

export function widgetParts(running: Iterable<{ name: string; task: string; startedAt: number }>, now: number): string[] {
  return Array.from(running, (a) =>
    a.task
      ? `${a.name} ${formatElapsed(now - a.startedAt)} ${a.task}`
      : `${a.name} ${formatElapsed(now - a.startedAt)}`,
  );
}

export function composeWidgetParts<Process>(running: Iterable<readonly [Process, string]>, childrenByProcess: ReadonlyMap<Process, string[]>): string[] {
  return Array.from(running).flatMap(([process, part]) => [
    part,
    ...(childrenByProcess.get(process) ?? []).map((child) => `↳ ${child}`),
  ]);
}
