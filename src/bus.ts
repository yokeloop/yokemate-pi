import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  allowTarget,
  bindInbox,
  closeInbox,
  ensureDir,
  ownPane,
  scanMains,
  sendReport,
  socketDir,
  type Inbox,
  type Report,
} from "./inbox.ts";

export default function bus(pi: ExtensionAPI) {
  let inbox: Inbox | undefined;

  const onReport = (r: Report): void => {
    pi.sendMessage(
      {
        customType: "yokemate-report",
        content: `[${r.mode}${r.ticket ? " " + r.ticket : ""} ${r.from}] ${r.text}`,
        display: true,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  pi.on("session_start", async (_e, ctx) => {
    const pane = ownPane(process.env);
    if (!pane) {
      ctx.ui.notify("no HERDR_PANE_ID — the yokemate inbox is not up", "warning");
      return;
    }
    const dir = socketDir(process.env, process.getuid!());
    try {
      ensureDir(dir, process.getuid!());
      inbox = await bindInbox(
        dir,
        pane,
        {
          mode: process.env.YOKEMATE_MODE ?? "main",
          ticket: process.env.YOKEMATE_TICKET ?? null,
          cwd: ctx.cwd,
          pid: process.pid,
        },
        onReport,
      );
    } catch (e) {
      ctx.ui.notify(`yokemate inbox is not up: ${(e as Error).message}`, "warning");
    }
  });

  pi.on("session_shutdown", () => {
    if (!inbox) return;
    closeInbox(socketDir(process.env, process.getuid!()), inbox);
    inbox = undefined;
  });

  pi.registerTool({
    name: "send_message",
    label: "Send message",
    description:
      "Отчёт назад в панель, которая тебя запустила. Результат `delivered` — доставлено; " +
      "`unreachable: <причина>` — доставки не было, скажи отчёт в своей панели.",
    parameters: Type.Object({
      text: Type.String({ description: "Текст отчёта" }),
      to: Type.Optional(
        Type.String({
          description:
            "pane id получателя; из панели не нужен — адрес выводится из YOKEMATE_PARENT_PANE",
        }),
      ),
    }),
    async execute(_id, params) {
      const r = await sendReport(process.env, process.getuid!(), params.text, params.to);
      return { content: [{ type: "text", text: r.line }], details: undefined };
    },
  });

  pi.on("tool_call", (event) => {
    if (event.toolName !== "send_message") return;
    const to = (event.input as { to?: string }).to;
    const dir = socketDir(process.env, process.getuid!());
    const mains = scanMains(dir, ownPane(process.env)).map((c) => c.pane);
    const v = allowTarget(process.env, to, mains);
    if (!v.ok) return { block: true, reason: v.reason };
  });
}
