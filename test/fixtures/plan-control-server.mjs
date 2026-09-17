import { createServer } from "node:net";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const socket = process.env.PLAN_CONTROL_SOCKET;
const root = process.env.PLAN_CONTROL_ROOT;
if (!socket || !root) process.exit(2);
const starttime = readFileSync(`/proc/${process.pid}/stat`, "utf8").slice(readFileSync(`/proc/${process.pid}/stat`, "utf8").lastIndexOf(") ") + 2).split(" ")[19];
mkdirSync(dirname(socket), { recursive: true });
rmSync(socket, { force: true });
const server = createServer((connection) => {
  let buffer = "";
  connection.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const request = JSON.parse(buffer.slice(0, newline));
    let reply;
    if (request.operation === "attach-origin") reply = { requestId: request.requestId, state: "accepted", originId: "fixture-origin" };
    else if (request.operation === "prepare-plan-publication") reply = {
      requestId: request.requestId, state: "accepted", reason: "prepared",
      publicationId: Number(process.env.PLAN_PUBLICATION_ID), recordId: Number(process.env.PLAN_RECORD_ID),
      snapshotPath: process.env.PLAN_SNAPSHOT, scoutPublication: Number(process.env.PLAN_SCOUT_ID),
      target: "fixture-target", revision: process.env.PLAN_REVISION,
    };
    else if (request.operation === "plan-recorded") reply = { requestId: request.requestId, state: "accepted", publication: "complete", target: "fixture-target", revision: process.env.PLAN_REVISION, reason: "plan-only; ready for /do" };
    else reply = { requestId: request.requestId, state: "refused", reason: "unsupported fixture operation" };
    connection.end(JSON.stringify(reply) + "\n");
  });
});
server.listen(socket, () => {
  writeFileSync(`${socket}.json`, JSON.stringify({ root, sessionId: "parent", runtimeId: "runtime", pid: process.pid, starttime, cwd: root }), { mode: 0o600 });
  process.stdout.write("ready\n");
});
const stop = () => server.close(() => { rmSync(socket, { force: true }); rmSync(`${socket}.json`, { force: true }); process.exit(0); });
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
