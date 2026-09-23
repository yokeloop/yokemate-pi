import { readFileSync } from "node:fs";

export interface ProcessIdentity {
  pid: number;
  starttime: string;
}

export type ProcessObservation = "live" | "exited" | "unknown";

export interface PlanProcessObserver {
  stop(): void;
}

export interface PlanProcessObserverOptions {
  intervalMs?: number;
  probe?: (identity: ProcessIdentity) => ProcessObservation | Promise<ProcessObservation>;
  wait?: (ms: number) => Promise<void>;
}

function parseStat(stat: string): { state: string; starttime: string } | undefined {
  const close = stat.lastIndexOf(") ");
  if (close < 0) return undefined;
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  if (fields.length < 20 || !fields[0] || !fields[19]) return undefined;
  return { state: fields[0], starttime: fields[19] };
}

export function observeProcess(identity: ProcessIdentity): ProcessObservation {
  try {
    const parsed = parseStat(readFileSync(`/proc/${identity.pid}/stat`, "utf8"));
    if (!parsed) return "unknown";
    if (parsed.starttime !== identity.starttime || parsed.state === "Z" || parsed.state === "X") return "exited";
    return "live";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "exited" : "unknown";
  }
}

const defaultWait = (ms: number) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

export function observePlanProcess(
  identity: ProcessIdentity,
  onExit: () => void | Promise<void>,
  options: PlanProcessObserverOptions = {},
): PlanProcessObserver {
  const intervalMs = options.intervalMs ?? 500;
  const probe = options.probe ?? observeProcess;
  const wait = options.wait ?? defaultWait;
  let stopped = false;
  let generation = 0;

  const loop = async (ownedGeneration: number): Promise<void> => {
    while (!stopped && generation === ownedGeneration) {
      let observation: ProcessObservation = "unknown";
      try { observation = await probe(identity); } catch {}
      if (stopped || generation !== ownedGeneration) return;
      if (observation === "exited") {
        stopped = true;
        generation += 1;
        await onExit();
        return;
      }
      await wait(intervalMs);
    }
  };

  void loop(generation);
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      generation += 1;
    },
  };
}
