import fs from "node:fs";
import { spawn } from "node:child_process";

const [mode, target] = process.argv.slice(2);
if (mode === "detached") {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  fs.writeFileSync(target, String(child.pid));
  child.unref();
  setInterval(() => {}, 1000);
} else if (mode === "blocked") {
  for (;;) {}
} else if (mode === "socket") {
  const net = await import("node:net");
  const server = net.createServer(() => {});
  server.listen(target);
  setInterval(() => {}, 1000);
} else {
  throw new Error(`unknown fault mode ${mode}`);
}
