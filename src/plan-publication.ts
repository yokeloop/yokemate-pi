import { sha256 } from "./subagent-runs.ts";
import type { PublicationError, PublicationKind, PublicationRow } from "./plan-publication-state.ts";
import { assertMandatoryBoundary } from "./workflow-boundaries.ts";

export const COMMENT_BUDGET = 24_576;
const markerPrefix = "<!-- yokemate-plan-publication:";
const separator = "\n\n---\n\n";
const placeholder = /^(?:<[^>]+>|\$\{[^}]+\}|\$[A-Z][A-Z0-9_]*|\[REDACTED\])$/;

export class PublicationFailure extends Error {
  code: PublicationError;
  constructor(code: PublicationError) { super(code); this.code = code; }
}

export interface PublicationFrameInput {
  target: string;
  targetHash: string;
  canonicalUrl: string;
  ticket: string;
  run: string;
  kind: PublicationKind;
  hash: string;
  bytes: Buffer;
  knowledgePath?: string;
  provenance?: {
    source: "engineer-accepted-input";
    incident: string;
    candidate: string;
    sourceRun: string;
    failureHash: string;
    payloadHash: string;
    skipped: string;
    preserved: string;
    reason: string;
  };
}
export interface PublicationPart { part: number; total: number; bytes: number; chunkHash: string; fragment: Buffer; body: string; run: string }
export interface RemoteComment { id: string; text: string; url?: string }
export interface PublicationAdapter { list(): Promise<RemoteComment[]>; add(body: string): Promise<void> }
export interface PublishResult { complete: boolean; error?: PublicationError; parts: number; revision: string }

export function normalizeScoutMarkdown(value: string): Buffer {
  return Buffer.from(value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"), "utf8");
}

function secretValue(value: string): boolean {
  let clean = value.trim().replace(/[,;]\s*$/, "").trim();
  if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) clean = clean.slice(1, -1).trim();
  return clean.length > 0 && !placeholder.test(clean);
}

function rejectSecretValues(text: string, pattern: RegExp): void {
  for (const match of text.matchAll(pattern)) if (secretValue(match[1]!)) throw new PublicationFailure("unsafe_document");
}

export function assertPublishable(bytes: Buffer): void {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new PublicationFailure("unsafe_document"); }
  if (!text.trim()) throw new PublicationFailure("unsafe_document");
  const unconditional = [
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/i,
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|perm:[A-Za-z0-9_-]{16,})\b/,
  ];
  if (unconditional.some((pattern) => pattern.test(text))) throw new PublicationFailure("unsafe_document");
  rejectSecretValues(text, /^(?:Authorization|Proxy-Authorization)\s*:\s*(?:Bearer|Basic)\s+([^\s]+)\s*$/gim);
  for (const match of text.matchAll(/^(?:Cookie|Set-Cookie)\s*:\s*(.+?)\s*$/gim)) {
    const header = match[1]!.trim();
    if (placeholder.test(header)) continue;
    for (const item of header.split(";")) {
      const equals = item.indexOf("=");
      if (equals < 0 || secretValue(item.slice(equals + 1))) throw new PublicationFailure("unsafe_document");
    }
  }
  for (const match of text.matchAll(/https?:\/\/([^\s/@]+)@/gim)) {
    for (const part of match[1]!.split(":")) if (secretValue(part)) throw new PublicationFailure("unsafe_document");
  }
  rejectSecretValues(text, /[?&](?:access_token|refresh_token|api_key|apikey|token|password|secret|client_secret)=([^&#\s]+)/gim);
  rejectSecretValues(text, /["'](?:token|api_key|apikey|password|secret|client_secret|access_token|refresh_token)["']\s*:\s*((?:"[^"]*")|(?:'[^']*'))/gim);
  const assignment = /^\s*(?:(?:export\s+)?(?:const|let|var)\s+|[-*]\s*)?["']?(?:token|api_key|apikey|password|secret|client_secret|access_token|refresh_token)["']?\s*[:=]\s*(.+?)\s*$/gim;
  rejectSecretValues(text, assignment);
}

function marker(input: PublicationFrameInput, part: number, total: number, fragment: Buffer): string {
  const common = { target: input.targetHash, ticket: input.ticket, run: input.run, kind: input.kind, hash: input.hash, part, total, bytes: fragment.length, chunkHash: sha256(fragment) };
  return `${markerPrefix}${JSON.stringify(input.provenance ? { v: 2, ...common, provenance: input.provenance } : { v: 1, ...common })} -->`;
}

function frame(input: PublicationFrameInput, part: number, total: number, fragment: Buffer): string {
  const lines = [
    marker(input, part, total, fragment),
    `${input.ticket} · ${input.kind} · revision ${input.hash} · part ${part}/${total}`,
    `target: ${input.canonicalUrl}`,
    `run: ${input.run}`,
  ];
  if (input.provenance) lines.push(`source: ${input.provenance.source}`, `incident: ${input.provenance.incident}`, `candidate: ${input.provenance.candidate}`, `source-run: ${input.provenance.sourceRun}`, "failure-category: failed-transport-envelope", `failure-hash: ${input.provenance.failureHash}`, "status: audit-preserved; plan-only");
  if (input.kind === "plan") {
    if (!input.knowledgePath) throw new PublicationFailure("artifact_invalid");
    lines.push(`knowledge: ${input.knowledgePath}`, "record: planned (successful local record)");
  }
  return `${lines.join("\n")}${separator}${fragment.toString("utf8")}`;
}

function scalarBoundaries(bytes: Buffer, start: number): number[] {
  const result: number[] = [];
  let index = start;
  while (index < bytes.length) {
    const byte = bytes[index]!;
    index += byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
    if (index <= bytes.length) result.push(index);
  }
  return result;
}

function splitWithTotal(input: PublicationFrameInput, total: number): PublicationPart[] {
  const parts: PublicationPart[] = [];
  let start = 0;
  while (start < input.bytes.length) {
    const boundaries = scalarBoundaries(input.bytes, start);
    let low = 0;
    let high = boundaries.length - 1;
    let accepted = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const end = boundaries[middle]!;
      const fragment = input.bytes.subarray(start, end);
      if (Buffer.byteLength(frame(input, parts.length + 1, total, fragment)) <= COMMENT_BUDGET) { accepted = middle; low = middle + 1; }
      else high = middle - 1;
    }
    if (accepted < 0) throw new PublicationFailure("size");
    let end = boundaries[accepted]!;
    if (end < input.bytes.length) {
      const newline = input.bytes.lastIndexOf(10, end - 1);
      if (newline >= start) end = newline + 1;
    }
    if (end <= start) end = boundaries[accepted]!;
    const fragment = input.bytes.subarray(start, end);
    const body = frame(input, parts.length + 1, total, fragment);
    if (Buffer.byteLength(body) > COMMENT_BUDGET) throw new PublicationFailure("size");
    parts.push({ part: parts.length + 1, total, bytes: fragment.length, chunkHash: sha256(fragment), fragment, body, run: input.run });
    start = end;
  }
  return parts;
}

export function splitPublication(input: PublicationFrameInput): PublicationPart[] {
  assertPublishable(input.bytes);
  if (sha256(input.bytes) !== input.hash || !/^[a-f0-9]{64}$/.test(input.targetHash)) throw new PublicationFailure("artifact_invalid");
  let total = 1;
  for (let attempt = 0; attempt < 20; attempt++) {
    const parts = splitWithTotal(input, total);
    if (parts.length === total) return parts;
    total = parts.length;
  }
  throw new PublicationFailure("size");
}

interface ParsedPart {
  target: string;
  ticket: string;
  run: string;
  kind: PublicationKind;
  hash: string;
  part: number;
  total: number;
  bytes: number;
  chunkHash: string;
  fragment: Buffer;
  body: string;
  provenance?: PublicationFrameInput["provenance"];
}

function parseOwnComment(text: string): ParsedPart | null | "malformed" {
  const firstEnd = text.indexOf("\n");
  const first = firstEnd < 0 ? text : text.slice(0, firstEnd);
  if (!first.startsWith(markerPrefix)) return null;
  const match = /^<!-- yokemate-plan-publication:(\{.*\}) -->$/.exec(first);
  if (!match) return "malformed";
  let value: Record<string, unknown>;
  try { value = JSON.parse(match[1]!); } catch { return "malformed"; }
  const keys = value.v === 2 ? ["v", "target", "ticket", "run", "kind", "hash", "part", "total", "bytes", "chunkHash", "provenance"] : ["v", "target", "ticket", "run", "kind", "hash", "part", "total", "bytes", "chunkHash"];
  if (JSON.stringify(Object.keys(value)) !== JSON.stringify(keys) || ![1, 2].includes(value.v as number) || typeof value.target !== "string" || !/^[a-f0-9]{64}$/.test(value.target) || typeof value.ticket !== "string" || typeof value.run !== "string" || !["scout", "plan"].includes(String(value.kind)) || typeof value.hash !== "string" || !/^[a-f0-9]{64}$/.test(value.hash) || !Number.isInteger(value.part) || !Number.isInteger(value.total) || !Number.isInteger(value.bytes) || typeof value.chunkHash !== "string") return "malformed";
  let provenance: PublicationFrameInput["provenance"];
  if (value.v === 2) {
    const item = value.provenance as Record<string, unknown> | null;
    const pkeys = ["source", "incident", "candidate", "sourceRun", "failureHash", "payloadHash", "skipped", "preserved", "reason"];
    if (!item || JSON.stringify(Object.keys(item)) !== JSON.stringify(pkeys) || item.source !== "engineer-accepted-input" || pkeys.slice(1).some((key) => typeof item[key] !== "string") || !/^[a-f0-9]{64}$/.test(String(item.failureHash)) || !/^[a-f0-9]{64}$/.test(String(item.payloadHash))) return "malformed";
    provenance = item as unknown as NonNullable<PublicationFrameInput["provenance"]>;
  }
  const split = text.indexOf(separator, firstEnd);
  if (split < 0) return "malformed";
  let fragment = Buffer.from(text.slice(split + separator.length), "utf8");
  let body = text;
  if (fragment.length + 1 === value.bytes) {
    const restored = Buffer.concat([fragment, Buffer.from("\n")]);
    if (sha256(restored) === value.chunkHash) {
      fragment = restored;
      body += "\n";
    }
  }
  if (fragment.length !== value.bytes || sha256(fragment) !== value.chunkHash) return "malformed";
  return { target: value.target, ticket: value.ticket, run: value.run, kind: value.kind as PublicationKind, hash: value.hash, part: value.part as number, total: value.total as number, bytes: value.bytes as number, chunkHash: value.chunkHash, fragment, body, ...(provenance ? { provenance } : {}) };
}

export function reconcilePublication(input: PublicationFrameInput, comments: RemoteComment[]): { complete: boolean; parts: PublicationPart[]; missing: PublicationPart[] } {
  const parsed: ParsedPart[] = [];
  for (const comment of comments) {
    const item = parseOwnComment(comment.text);
    if (item === "malformed") throw new PublicationFailure("remote_conflict");
    if (item) parsed.push(item);
  }
  const provenanceMatches = (item: ParsedPart): boolean => input.provenance ? !!item.provenance && JSON.stringify(item.provenance) === JSON.stringify(input.provenance) : item.provenance === undefined;
  const revision = parsed.filter((item) => item.target === input.targetHash && item.ticket === input.ticket && item.kind === input.kind && item.hash === input.hash && provenanceMatches(item));
  const runs = new Set(revision.map((item) => item.run));
  if (runs.size > 1) throw new PublicationFailure("remote_conflict");
  const run = revision[0]?.run ?? input.run;
  const parts = splitPublication({ ...input, run });
  const total = new Set(revision.map((item) => item.total));
  if (total.size > 1 || (revision.length && !total.has(parts.length))) throw new PublicationFailure("remote_conflict");
  const byPart = new Map<number, ParsedPart[]>();
  for (const item of revision) {
    if (item.part < 1 || item.part > parts.length) throw new PublicationFailure("remote_conflict");
    const values = byPart.get(item.part) ?? [];
    values.push(item);
    byPart.set(item.part, values);
  }
  for (const expected of parts) {
    const values = byPart.get(expected.part) ?? [];
    if (new Set(values.map((item) => item.body)).size > 1 || values.some((item) => item.body !== expected.body)) throw new PublicationFailure("remote_conflict");
  }
  const missing = parts.filter((part) => !byPart.has(part.part));
  if (!missing.length) {
    const reconstructed = Buffer.concat(parts.map((part) => part.fragment));
    if (sha256(reconstructed) !== input.hash || !reconstructed.equals(input.bytes)) throw new PublicationFailure("remote_conflict");
  }
  return { complete: missing.length === 0, parts, missing };
}

const localPublicationFailures = new Set<PublicationError>(["artifact_invalid", "unsafe_document", "binding_changed"]);

export async function publishDocument(row: PublicationRow, bytes: Buffer, adapter: PublicationAdapter, options: { canonicalUrl: string; knowledgePath?: string; verifyBinding?: () => void | Promise<void> }): Promise<PublishResult> {
  assertMandatoryBoundary("workflow.external-auth", typeof adapter.list === "function" && typeof adapter.add === "function", "publication adapter is not authenticated");
  assertMandatoryBoundary("workflow.audit", row.source_kind === "normal-transport" || !!row.incident_id, "recovered publication has no incident provenance");
  const provenance = row.source_kind === "engineer-accepted-input"
    ? { source: "engineer-accepted-input" as const, incident: row.incident_id!, candidate: row.candidate_id!, sourceRun: row.source_run_id!, failureHash: row.failure_hash!, payloadHash: row.payload_hash!, skipped: row.skipped_json!, preserved: row.preserved_json!, reason: row.incident_reason! }
    : undefined;
  if (row.source_kind === "engineer-accepted-input" && Object.values(provenance!).some((value) => !value)) throw new PublicationFailure("artifact_invalid");
  const input: PublicationFrameInput = { target: row.target, targetHash: row.target_hash, canonicalUrl: options.canonicalUrl, ticket: row.ticket, run: row.run_id, kind: row.kind, hash: row.content_hash, bytes, knowledgePath: options.knowledgePath, provenance };
  try {
    assertPublishable(bytes);
    await options.verifyBinding?.();
    let comments = await adapter.list();
    let state = reconcilePublication(input, comments);
    for (const part of state.missing) {
      await options.verifyBinding?.();
      try { await adapter.add(part.body); }
      catch (error) {
        const code = error instanceof PublicationFailure ? error.code : "unavailable";
        if (localPublicationFailures.has(code)) throw error;
        comments = await adapter.list();
        state = reconcilePublication(input, comments);
        if (!state.missing.some((item) => item.part === part.part)) continue;
        return { complete: false, error: code, parts: state.parts.length, revision: row.content_hash };
      }
    }
    await options.verifyBinding?.();
    comments = await adapter.list();
    state = reconcilePublication(input, comments);
    await options.verifyBinding?.();
    return state.complete
      ? { complete: true, parts: state.parts.length, revision: row.content_hash }
      : { complete: false, error: "incomplete_listing", parts: state.parts.length, revision: row.content_hash };
  } catch (error) {
    if (error instanceof PublicationFailure && localPublicationFailures.has(error.code)) throw error;
    return { complete: false, error: error instanceof PublicationFailure ? error.code : "unavailable", parts: 0, revision: row.content_hash };
  }
}
