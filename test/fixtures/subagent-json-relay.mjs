import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [upstream, ...args] = process.argv.slice(2);
const target = process.env.YOKEMATE_SUBAGENT_TEST_TARGET;
if (target) {
  await import(pathToFileURL(target).href);
} else if (process.env.YOKEMATE_ROLE === "coordinator" && process.env.YM204_FIXTURE_SCENARIO === "child_aggregate") {
  process.argv = [process.execPath, upstream, ...args];
  await import(pathToFileURL(upstream).href);
} else {
  const fault = process.env.YOKEMATE_SUBAGENT_TEST_FAULT;
  const manifestDir = process.env.YOKEMATE_SUBAGENT_TEST_MANIFEST_DIR;
  const stdoutHash = createHash("sha256");
  let stdoutBytes = 0;
  let recordChunks = [];
  let recordBytes = 0;
  let recordHash = createHash("sha256");
  let recordOverflow = false;
  let records = 0;
  let maxRecordBytes = 0;
  let maxNonAggregateRecordBytes = 0;
  const summaries = [];
  let child;

  const facts = () => ({
    relayPid: process.pid,
    upstreamPid: child?.pid,
    upstream,
    role: process.env.YOKEMATE_ROLE,
    runId: process.env.YOKEMATE_RUN_ID,
    fault,
    stdoutBytes,
    stdoutHash: stdoutHash.copy().digest("hex"),
    records,
    maxRecordBytes,
    maxNonAggregateRecordBytes,
    summaries,
    partialBytes: recordBytes,
    partialHash: recordHash.copy().digest("hex"),
  });
  const writeFacts = (suffix = "") => {
    if (manifestDir) writeFileSync(join(manifestDir, `${process.pid}${suffix}.json`), JSON.stringify(facts()), { mode: 0o600 });
  };
  const resetRecord = () => {
    recordChunks = [];
    recordBytes = 0;
    recordHash = createHash("sha256");
    recordOverflow = false;
  };
  const consume = (bytes) => {
    if (!bytes.length) return;
    recordBytes += bytes.length;
    recordHash.update(bytes);
    if (!recordOverflow && recordBytes <= 1024 * 1024) recordChunks.push(Buffer.from(bytes));
    else {
      recordOverflow = true;
      recordChunks = [];
    }
  };
  const finishRecord = () => {
    records++;
    let lineBytes = recordBytes;
    let line;
    if (!recordOverflow) {
      line = Buffer.concat(recordChunks);
      if (line.at(-1) === 13) {
        line = line.subarray(0, -1);
        lineBytes--;
      }
    }
    maxRecordBytes = Math.max(maxRecordBytes, lineBytes);
    let aggregate = false;
    if (line) {
      try {
        const event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
        if (event?.type === "agent_end" && event.messagesSummary) {
          aggregate = true;
          summaries.push({ sequence: records, bytes: lineBytes, hash: createHash("sha256").update(line).digest("hex"), messagesSummary: event.messagesSummary, willRetry: event.willRetry });
          writeFacts("-checkpoint");
        }
      } catch {}
    }
    if (!aggregate) maxNonAggregateRecordBytes = Math.max(maxNonAggregateRecordBytes, lineBytes);
    resetRecord();
  };
  const observe = (bytes) => {
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline;
      consume(bytes.subarray(start, end));
      if (newline < 0) break;
      finishRecord();
      start = newline + 1;
    }
  };
  const emit = (value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    stdoutHash.update(bytes);
    stdoutBytes += bytes.length;
    observe(bytes);
    const writable = process.stdout.write(bytes);
    if (!writable) child?.stdout.pause();
    return writable;
  };
  process.stdout.on("drain", () => child?.stdout.resume());
  if (fault === "record_overflow") emit("x".repeat(1024 * 1024 + 1) + "\n");
  child = spawn(process.execPath, [upstream, ...args], { env: process.env, stdio: ["inherit", "pipe", "inherit"] });
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
  child.on("close", async (code, signal) => {
    if (pending.length) emit(pending[pending.length - 1] === 10 ? pending.subarray(0, -1) : pending);
    if (process.stdout.writableNeedDrain) await new Promise((resolve) => process.stdout.once("drain", resolve));
    writeFacts();
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
