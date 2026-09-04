// The herdr calls the orchestrator makes: raise a tab or split a pane, put an
// agent in it, find it again, close it. Every mode's surface is created here
// (mode-tab, spawn) and closed here, so the rules about what dies when live in
// one file.

import { execFileSync } from "node:child_process";

/** One herdr command, its JSON answer parsed. Output is captured, never
 * inherited: herdr's errors belong in the thrown error, not in the chat. */
export function herdr(args: string[]): unknown {
  return JSON.parse(execFileSync("herdr", args, { encoding: "utf8", stdio: "pipe" }));
}

/** Sleep on the calling thread — these launchers are synchronous throughout. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A tab is found by the label its launch gave it — the same string on both
 * sides, because herdr's tab list carries no other name. Mode tabs are labelled
 * `<TICKET> <mode>`, the task tab of /do is labelled `<TICKET>`.
 */
export function findOpenTab(
  tabs: { label?: string; tab_id: string }[],
  label: string,
): string | undefined {
  return tabs.find((t) => t.label === label)?.tab_id;
}

/**
 * A mode already running is found by its agent's name — the one string that
 * holds whether the mode took a tab of its own (ship, /do) or a split of the
 * main chat's pane (review, worklog). Returns the pane it sits in.
 */
export function findRunningAgent(
  agents: { name?: string; pane_id: string }[],
  agentName: string,
): string | undefined {
  return agents.find((a) => a.name === agentName)?.pane_id;
}

/**
 * Start the agent in a pane herdr has just created. `tab create` returns before
 * the pane's shell reaches its prompt, and `agent start` refuses such a pane
 * outright (`agent_pane_busy`) — its own `--timeout` covers only agent readiness
 * after that check. So the busy refusal is retried; anything else is a real
 * failure and is thrown at once, so the caller can take its fresh tab down.
 *
 * `extraAgentArgs` go to the agent binary after the fixed ones — the engineer's
 * model choice (`--model <m>`) travels here.
 */
export function startAgent(
  agentName: string,
  paneId: string,
  displayName: string,
  extraAgentArgs: string[] = [],
  run: (args: string[]) => void = (args) => void herdr(args),
  tries = 20,
  waitMs = 250,
): void {
  for (let i = 1; ; i++) {
    try {
      run([
        "agent", "start", agentName, "--kind", "claude", "--pane", paneId, "--",
        "--name", displayName, "--dangerously-skip-permissions", ...extraAgentArgs,
      ]);
      return;
    } catch (e) {
      // herdr reports the refusal as JSON; which stream it lands on is its
      // business, so the whole failure is searched, message and both streams.
      const err = e as Error & { stdout?: string; stderr?: string };
      const said = `${err.message}${err.stdout ?? ""}${err.stderr ?? ""}`;
      if (i === tries || !said.includes("agent_pane_busy")) throw e;
      pause(waitMs);
    }
  }
}

/**
 * Close a tab that has finished — the orchestrator does this for /ship and
 * /do, whose tabs report and have nothing left to say. Returns the id it
 * closed, or undefined when no such tab is open: a tab the engineer already
 * closed by hand is not an error.
 *
 * /review and /worklog are not closed here — they sit in a split of the main
 * chat's pane, and both end in a conversation with the engineer, who is the
 * only one who knows it is over.
 */
export function closeTab(
  label: string,
  run: (args: string[]) => unknown = herdr,
): string | undefined {
  const listed = run(["tab", "list"]) as { result: { tabs: { label?: string; tab_id: string }[] } };
  const id = findOpenTab(listed.result.tabs, label);
  if (id) run(["tab", "close", id]);
  return id;
}
