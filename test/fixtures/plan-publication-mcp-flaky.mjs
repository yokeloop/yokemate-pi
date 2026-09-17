import { existsSync, writeFileSync } from "node:fs";

const marker = process.env.YM216_CONNECT_MARKER;
if (!marker) process.exit(2);
if (!existsSync(marker)) {
  writeFileSync(marker, "failed-once");
  await new Promise((resolve) => setTimeout(resolve, 250));
  process.exit(1);
}
await import("./plan-publication-mcp-server.mjs");
