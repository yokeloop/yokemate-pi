import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const [upstream, ...args] = process.argv.slice(2);
const target = process.env.YOKEMATE_SUBAGENT_TEST_TARGET;
if (target) {
  await import(pathToFileURL(target).href);
} else {
  const fault = process.env.YOKEMATE_SUBAGENT_TEST_FAULT;
  if (fault === "record_overflow") process.stdout.write("x".repeat(1024 * 1024 + 1) + "\n");
  const child = spawn(process.execPath, [upstream, ...args], { env: process.env, stdio: ["inherit", "pipe", "inherit"] });
  let pending = Buffer.alloc(0);
  child.stdout.on("data", (chunk) => {
    if (fault === "eof_without_lf") {
      pending = Buffer.concat([pending, chunk]);
      const last = pending.lastIndexOf(10);
      if (last > 0) {
        process.stdout.write(pending.subarray(0, last));
        pending = pending.subarray(last);
      }
      return;
    }
    process.stdout.write(chunk);
  });
  child.on("error", (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
  child.on("close", (code, signal) => {
    if (pending.length) process.stdout.write(pending[pending.length - 1] === 10 ? pending.subarray(0, -1) : pending);
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}
