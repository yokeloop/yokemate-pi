import { readRuntimeSettings } from "./guard-policy.ts";
import { resolve } from "node:path";
import { currentControlOrigin, requestCoordinator, resolveCoordinatorParent } from "./coordinator-control.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const fail = (message: string): never => { console.error(message); process.exit(1); };
const argv = process.argv.slice(2).filter((argument) => argument !== "--");
const tickets: string[] = [];
let plan: string | undefined;
let model: string | undefined;
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--plan") plan = argv[++index] ?? fail("--plan needs a value");
  else if (argv[index] === "--model") model = argv[++index] ?? fail("--model needs a value");
  else if (argv[index]!.startsWith("--")) fail(`unknown argument ${argv[index]} — known: --plan <path>, --model <m>`);
  else tickets.push(argv[index]!);
}
if (!tickets.length) fail("usage: spawn <TICKET> [<TICKET> …] [--plan <path-to-plan.md>] [--model <m>]");
const sessionId = process.env.PI_SESSION_ID ?? fail("PI_SESSION_ID is required to route spawn to its live coordinator parent");
try {
  readRuntimeSettings(root);
  const parent = resolveCoordinatorParent(root);
  const reply = await requestCoordinator(root, { mode: "do", tickets, plan, model }, currentControlOrigin(root, sessionId), parent);
  for (const result of reply.results ?? []) console.log(result.state === "accepted" ? `${result.key} → reserved background run ${result.keyRunId}` : `refused ${result.key}: ${result.reason}`);
  if (reply.state !== "accepted" && !reply.results?.length) console.error(reply.reason ?? "coordinator launch refused");
  if (reply.state !== "accepted" || !(reply.results?.some((result) => result.state === "accepted") ?? reply.runId)) process.exitCode = 1;
} catch (error) { fail((error as Error).message); }
