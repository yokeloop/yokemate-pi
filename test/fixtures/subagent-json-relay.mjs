import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [upstream, ...args] = process.argv.slice(2);
const target = process.env.YOKEMATE_SUBAGENT_TEST_TARGET;
if (target) {
  await import(pathToFileURL(target).href);
} else {
  const fault = process.env.YOKEMATE_SUBAGENT_TEST_FAULT;
  const stdoutHash = createHash("sha256");
  let stdoutBytes = 0;
  let record = Buffer.alloc(0);
  const emit = (value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    stdoutHash.update(bytes);
    stdoutBytes += bytes.length;
    record = Buffer.concat([record, bytes]);
    const lastLf = record.lastIndexOf(10);
    if (lastLf >= 0) record = record.subarray(lastLf + 1);
    process.stdout.write(bytes);
  };
  if (fault === "record_overflow") emit("x".repeat(1024 * 1024 + 1) + "\n");
  const child = spawn(process.execPath, [upstream, ...args], { env: process.env, stdio: ["inherit", "pipe", "inherit"] });
  let pending = Buffer.alloc(0);
  child.stdout.on("data", (chunk) => {
    if (fault === "eof_without_lf") {
      pending = Buffer.concat([pending, chunk]);
      const last = pending.lastIndexOf(10);
      if (last > 0) {
        emit(pending.subarray(0, last));
        pending = pending.subarray(last);
      }
      return;
    }
    emit(chunk);
  });
  child.on("error", (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
  child.on("close", (code, signal) => {
    if (pending.length) emit(pending[pending.length - 1] === 10 ? pending.subarray(0, -1) : pending);
    const manifestDir = process.env.YOKEMATE_SUBAGENT_TEST_MANIFEST_DIR;
    if (manifestDir) writeFileSync(join(manifestDir, `${process.pid}.json`), JSON.stringify({ fault, stdoutBytes, stdoutHash: stdoutHash.digest("hex"), partialBytes: record.length, partialHash: createHash("sha256").update(record).digest("hex") }), { mode: 0o600 });
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}
