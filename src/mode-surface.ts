import { herdr, herdrAsync } from "./herdr.ts";

export type Surface = "tab" | "split";

export interface SurfaceArgs {
  surface: Surface;
  model?: string;
  words: string[];
  literal: string[];
}

export function parseSurfaceArgs(argv: string[], valueOptions: readonly string[] = []): SurfaceArgs {
  const result: SurfaceArgs = { surface: "tab", model: undefined, words: [], literal: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      result.literal = argv.slice(i + 1);
      break;
    }
    if (valueOptions.includes(arg)) {
      result.words.push(arg);
      if (argv[i + 1] !== undefined && argv[i + 1] !== "--") result.words.push(argv[++i]!);
    } else if (arg === "--split") {
      result.surface = "split";
    } else if (arg === "--model") {
      if (argv[i + 1] === undefined || argv[i + 1] === "--") throw new Error("--model needs a value");
      result.model = argv[++i];
    } else {
      result.words.push(arg);
    }
  }
  return result;
}

export interface OpenedSurface {
  surface: Surface;
  paneId: string;
  tabId?: string;
  cleanup(): void;
}

export interface CloseSurfaceOutcome { state: "closed" | "failed"; reason?: string }

export async function closeModeSurface(opened: OpenedSurface, run: (args: string[]) => Promise<unknown> = herdrAsync, timeoutMs = 5000): Promise<CloseSurfaceOutcome> {
  const args = opened.surface === "tab"
    ? opened.tabId ? ["tab", "close", opened.tabId] : undefined
    : opened.paneId ? ["pane", "close", opened.paneId] : undefined;
  if (!args) return { state: "failed", reason: opened.surface === "tab" ? "review tab id is missing" : "review split pane id is missing" };
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      run(args),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`review ${opened.surface} close timed out after ${timeoutMs}ms`)), timeoutMs); }),
    ]);
    return { state: "closed" };
  } catch (error) {
    return { state: "failed", reason: error instanceof Error ? error.message : String(error) };
  } finally { clearTimeout(timer); }
}

export async function openModeSurfaceAsync(surface: Surface, parentPane: string, parentWorkspace: string, cwd: string, label: string, env: string[]): Promise<OpenedSurface> {
  if (surface === "split") {
    const { pane } = (await herdrAsync(["pane", "split", parentPane, "--direction", "down", "--cwd", cwd, ...env.flatMap((entry) => ["--env", entry])]) as { result: { pane: { pane_id: string } } }).result;
    return { surface, paneId: pane.pane_id, cleanup: () => void herdrAsync(["pane", "close", pane.pane_id]) };
  }
  const { tab, root_pane } = (await herdrAsync(["tab", "create", "--workspace", parentWorkspace, "--cwd", cwd, "--label", label, ...env.flatMap((entry) => ["--env", entry])]) as { result: { tab: { tab_id: string }; root_pane: { pane_id: string } } }).result;
  return { surface, paneId: root_pane.pane_id, tabId: tab.tab_id, cleanup: () => void herdrAsync(["tab", "close", tab.tab_id]) };
}

export function openModeSurface(
  surface: Surface,
  parentPane: string,
  parentWorkspace: string,
  cwd: string,
  label: string,
  env: string[],
  run: (args: string[]) => unknown = herdr,
): OpenedSurface {
  if (surface === "split") {
    const { pane } = (run([
      "pane", "split", parentPane, "--direction", "down", "--cwd", cwd,
      ...env.flatMap((e) => ["--env", e]),
    ]) as { result: { pane: { pane_id: string } } }).result;
    return { surface, paneId: pane.pane_id, cleanup: () => void run(["pane", "close", pane.pane_id]) };
  }
  const { tab, root_pane } = (run([
    "tab", "create", "--workspace", parentWorkspace, "--cwd", cwd, "--label", label,
    ...env.flatMap((e) => ["--env", e]),
  ]) as { result: { tab: { tab_id: string }; root_pane: { pane_id: string } } }).result;
  return { surface, paneId: root_pane.pane_id, tabId: tab.tab_id, cleanup: () => void run(["tab", "close", tab.tab_id]) };
}
