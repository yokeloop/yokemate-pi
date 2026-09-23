import type { TestContext } from "node:test";
import { RuntimeResources } from "./runtime-resources.ts";

export function runBoundedRuntimeCase(t: TestContext, run: (signal: AbortSignal, resources: RuntimeResources) => Promise<void>): Promise<void> {
  const resources = new RuntimeResources(t.signal);
  let settled = false;
  let bodyError: unknown;
  let work: Promise<void>;
  const cleanup = async () => {
    await resources.cleanup();
    if (!settled) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (!settled) {
        process.exitCode = 1;
        setImmediate(() => process.exit(1));
      }
    }
  };
  t.after(cleanup);
  try {
    work = Promise.resolve(run(resources.signal, resources));
  } catch (error) {
    work = Promise.reject(error);
  }
  work.then(() => { settled = true; }, (error) => { settled = true; bodyError = error; });
  return (async () => {
    try {
      await untilAborted(work, resources.signal);
    } catch (error) {
      bodyError = error;
    }
    await resources.cleanup();
    if (bodyError !== undefined) throw bodyError;
  })();
}

export async function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new Error("operation aborted"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([pending, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}
