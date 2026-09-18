import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { trackers, type Tracker } from "./trackers.ts";
import {
  fetchIssuePreview,
  IssuePreviewFetchError,
  type IssuePreview,
} from "./youtrack.ts";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const CUSTOM_TYPE = "yokemate-ticket-preview";

export type TicketPreviewLoadResult =
  | { status: "skip" }
  | { status: "success"; preview: IssuePreview }
  | { status: "error"; ticket: string; reason: string };

interface PreviewDatabase {
  prepare(sql: string): { get(value: string): unknown };
  close(): void;
}

export interface TicketPreviewDependencies {
  root?: string;
  openDatabase?: (path: string, options: { readOnly: true }) => PreviewDatabase;
  trackerRegistry?: () => Tracker[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface TicketPreviewExtensionDependencies extends TicketPreviewDependencies {
  load?: (ticket: string) => Promise<TicketPreviewLoadResult>;
}

function failure(ticket: string, reason: string): TicketPreviewLoadResult {
  return { status: "error", ticket, reason };
}

export async function loadTicketPreview(
  ticket: string,
  dependencies: TicketPreviewDependencies = {},
): Promise<TicketPreviewLoadResult> {
  const root = dependencies.root ?? ROOT;
  const openDatabase = dependencies.openDatabase ?? ((path, options) => new DatabaseSync(path, options));
  let db: PreviewDatabase | undefined;
  let row: { tracker: string } | undefined;
  let databaseFailed = false;
  try {
    db = openDatabase(join(root, "yokemate.db"), { readOnly: true });
    row = db
      .prepare("SELECT tracker FROM project WHERE tracker_key = ? LIMIT 1")
      .get(ticket.split("-")[0]!) as { tracker: string } | undefined;
  } catch {
    databaseFailed = true;
  } finally {
    try {
      db?.close();
    } catch {
      databaseFailed = true;
    }
  }
  if (databaseFailed) return failure(ticket, "не удалось прочитать паспорт проекта");
  if (!row) return failure(ticket, "паспорт проекта не найден");
  if (row.tracker === "github") return { status: "skip" };

  let tracker: Tracker | undefined;
  try {
    tracker = (dependencies.trackerRegistry ?? trackers)().find((candidate) => candidate.name === row.tracker);
  } catch {
    return failure(ticket, "конфигурация YouTrack недоступна");
  }
  if (!tracker) return failure(ticket, "конфигурация YouTrack недоступна");

  try {
    const preview = await fetchIssuePreview(
      tracker,
      ticket,
      dependencies.fetchImpl,
      dependencies.timeoutMs,
    );
    return preview
      ? { status: "success", preview }
      : failure(ticket, "задача не найдена в YouTrack");
  } catch (error) {
    if (!(error instanceof IssuePreviewFetchError))
      return failure(ticket, "не удалось связаться с YouTrack");
    if (error.kind === "timeout") return failure(ticket, "YouTrack не ответил за 5 секунд");
    if (error.kind === "http") return failure(ticket, `YouTrack вернул HTTP ${error.status ?? "ошибку"}`);
    if (error.kind === "json") return failure(ticket, "YouTrack вернул некорректный ответ");
    return failure(ticket, "не удалось связаться с YouTrack");
  }
}

export function formatTicketPreview(result: Exclude<TicketPreviewLoadResult, { status: "skip" }>): string {
  if (result.status === "error")
    return `## ${result.ticket}\n\nНе удалось загрузить описание задачи: ${result.reason}. Запуск режима продолжается.`;
  const description = result.preview.description?.trim() ? result.preview.description : "Описание отсутствует";
  return `## ${result.preview.idReadable} — ${result.preview.summary}\n\n${description}`;
}

function stampedIdentity(): { ticket: string; mode: "plan" | "review" } | undefined {
  const mode = process.env.YOKEMATE_MODE;
  const ticket = process.env.YOKEMATE_TICKET ?? "";
  if ((mode !== "plan" && mode !== "review") || process.env.YOKEMATE_ROLE !== "coordinator")
    return undefined;
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(ticket)) return undefined;
  return { ticket, mode };
}

function hasMarker(
  entries: readonly unknown[],
  ticket: string,
  mode: "plan" | "review",
): boolean {
  return entries.some((value) => {
    const entry = value as { type?: string; customType?: string; details?: { ticket?: unknown; mode?: unknown } };
    return entry.type === "custom_message" && entry.customType === CUSTOM_TYPE &&
      entry.details?.ticket === ticket && entry.details.mode === mode;
  });
}

export function registerTicketPreview(
  pi: ExtensionAPI,
  dependencies: TicketPreviewExtensionDependencies = {},
): void {
  let pending: Promise<void> | undefined;
  pi.on("session_start", async (_event, ctx) => {
    const identity = stampedIdentity();
    if (!identity) return;
    if (hasMarker(ctx.sessionManager.getEntries(), identity.ticket, identity.mode)) return;
    if (pending) return pending;
    pending = (async () => {
      const result = dependencies.load
        ? await dependencies.load!(identity.ticket)
        : await loadTicketPreview(identity.ticket, dependencies);
      if (result.status === "skip") return;
      pi.sendMessage(
        {
          customType: CUSTOM_TYPE,
          content: formatTicketPreview(result),
          display: true,
          details: identity,
        },
        { triggerTurn: false },
      );
    })();
    try {
      await pending;
    } finally {
      pending = undefined;
    }
  });
}

export default function ticketPreview(pi: ExtensionAPI): void {
  registerTicketPreview(pi);
}
