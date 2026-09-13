import { resolve } from "node:path";
import { processStarttime, requestCoordinator, resolveCoordinatorParent } from "./coordinator-control.ts";
import { splitDoRequest } from "./coordinator-launch.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const fail = (message: string): never => { console.error(message); process.exit(1); };
const argv = process.argv.slice(2).filter((arg) => arg !== "--");
const tickets: string[] = [];
let plan: string | undefined;
let model: string | undefined;
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--plan") plan = argv[++index] ?? fail("--plan needs a value");
  else if (argv[index] === "--model") model = argv[++index] ?? fail("--model needs a value");
  else if (argv[index].startsWith("--")) fail(`unknown argument ${argv[index]} — known: --plan <path>, --model <m>`);
  else tickets.push(argv[index]);
}
if (!tickets.length) fail("usage: spawn <TICKET> [<TICKET> …] [--plan <path-to-plan.md>] [--model <m>]");
const sessionId = process.env.PI_SESSION_ID ?? fail("PI_SESSION_ID is required to route spawn to its live coordinator parent");
try {
  const requests = splitDoRequest({ mode: "do", tickets, plan, model });
  const parent = resolveCoordinatorParent(root);
  let accepted = false;
  for (const request of requests) {
    const ticket = request.tickets[0]!;
    try {
      const reply = await requestCoordinator(root, request, { sessionId, pid: process.pid, starttime: processStarttime(process.pid) ?? fail("cannot read CLI process starttime"), cwd: root, pane: process.env.HERDR_PANE_ID, parentPane: process.env.YOKEMATE_PARENT_PANE, mode: process.env.YOKEMATE_MODE, ticket: process.env.YOKEMATE_TICKET, role: process.env.YOKEMATE_ROLE }, parent);
      if (reply.state !== "accepted" || !reply.runId) throw new Error(reply.reason ?? "coordinator launch was not accepted");
      console.log(`${ticket} → background run ${reply.runId}`);
      accepted = true;
    } catch (error) { console.log(`refused ${ticket}: ${(error as Error).message}`); }
  }
  if (!accepted) process.exitCode = 1;
} catch (error) { fail((error as Error).message); }
