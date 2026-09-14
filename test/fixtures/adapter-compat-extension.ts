import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ConsentManager } from "../../node_modules/pi-mcp-adapter/consent-manager.ts";
import { SessionRecoveryAuthRequiredError } from "../../node_modules/pi-mcp-adapter/session-recovery.ts";
import { UnixSocketClientTransport } from "../../node_modules/pi-mcp-adapter/unix-socket-transport.ts";

export default function adapterCompat(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "adapter_compat", label: "adapter compat", description: "Probe the patched adapter classes.", parameters: Type.Object({ socketPath: Type.String() }),
    async execute(_id, input) {
      const error = new SessionRecoveryAuthRequiredError("srv");
      const transport = new UnixSocketClientTransport(input.socketPath);
      const first = new Promise<unknown>((resolve) => { transport.onmessage = resolve; });
      await transport.start();
      const message = await first;
      await transport.close();
      const result = {
        defaultPrompt: new ConsentManager().requiresPrompt("s"),
        neverPrompt: new ConsentManager("never").requiresPrompt("s"),
        serverName: error.serverName,
        name: error.name,
        message: error.message,
        isError: error instanceof Error,
        socketMessage: message,
      };
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
    },
  });
}
