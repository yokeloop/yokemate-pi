import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

export interface CommandResult { exit: number; output: string }

export function shipLockPath(root: string, remote: string, base: string): string {
  const key = createHash("sha256").update(`${remote}\0${base}`).digest("hex");
  return join(root, ".yoke", "ship-merge-locks", `${key}.lock`);
}

export async function runWithShipLock(root: string, remote: string, base: string, command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<CommandResult> {
  const lock = shipLockPath(root, remote, base);
  mkdirSync(join(lock, ".."), { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn("flock", ["--exclusive", lock, command, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ exit: code ?? (signal ? 1 : 0), output }));
  });
}
