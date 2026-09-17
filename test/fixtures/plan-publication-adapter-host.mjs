import fs from "node:fs";
import { PlanPublicationMcp } from "../../src/plan-publication-mcp.ts";

export default function (pi) {
  const runtime = new PlanPublicationMcp(pi, process.env.YM216_ROOT);
  pi.on("session_start", async (_event, ctx) => {
    runtime.setContext(ctx);
    if (process.env.YM216_RETRY_CONNECT) {
      try { await runtime.youTrackAdapter("youtrack-fixture", "YM-216"); } catch {}
    }
    const { adapter, canonicalUrl } = await runtime.youTrackAdapter("youtrack-fixture", "YM-216");
    const before = await adapter.list();
    await adapter.add("Unicode 🙂 publication");
    const after = await adapter.list();
    fs.writeFileSync(process.env.YM216_RESULT, JSON.stringify({ canonicalUrl, before: before.length, after: after.length, tail: after.at(-1)?.text }));
  });
  pi.on("session_shutdown", async () => runtime.shutdown());
}
