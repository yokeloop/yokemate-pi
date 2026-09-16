import type { TestContext } from "node:test";

export function runBoundedRuntimeCase(t: TestContext, run: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const work = run(t.signal);
  t.after(async () => { await work.catch(() => {}); });
  return work;
}

export async function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([pending, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}
