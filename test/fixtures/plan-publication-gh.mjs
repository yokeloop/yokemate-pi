#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.YM216_GH_STATE;
const logPath = process.env.YM216_GH_LOG;
if (!statePath || !logPath) process.exit(2);
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(statePath, "utf8"));
const log = JSON.parse(readFileSync(logPath, "utf8"));
if (args[0] === "api") {
  log.push({ args });
  writeFileSync(logPath, JSON.stringify(log));
  const page = Number(/[?&]page=(\d+)/.exec(args[1] ?? "")?.[1]);
  process.stdout.write(JSON.stringify(state.slice((page - 1) * 100, page * 100)));
} else if (args[0] === "issue" && args[1] === "comment" && args.includes("--body-file") && args.at(-1) === "-") {
  const body = readFileSync(0, "utf8");
  log.push({ args, body });
  state.push({ id: state.length + 1, body, html_url: `https://github.com/o/r/issues/2#issuecomment-${state.length + 1}` });
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(logPath, JSON.stringify(log));
  process.stdout.write("ok\n");
} else process.exit(2);
