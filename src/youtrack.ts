// YouTrack REST client: the one hardwired query and status-field detection.
import type { Tracker } from "./trackers.ts";

// Hardwired: assignee plus the tracker's own resolved mark. `#Unresolved` is
// not a status filter (R2.2 forbids those) — it is the same `resolved` flag the
// sync trusts, asked of the server instead of thrown away after the fetch.
// Nothing else is ever appended.
export const QUERY = "Assignee: me #Unresolved";
export const QUERY_ALL = "Assignee: me";
export const PAGE = 50;

export interface RawIssue {
  idReadable: string;
  summary: string;
  resolved?: number | null;
  project?: { shortName?: string };
  customFields?: {
    name: string;
    $type: string;
    value?: { name?: string; localizedName?: string } | null;
  }[];
}

export const FIELDS =
  "idReadable,summary,resolved,project(shortName)," +
  "customFields(name,$type,value(name,localizedName))";

export const ISSUE_PREVIEW_FIELDS = "idReadable,summary,description";

export interface IssuePreview {
  idReadable: string;
  summary: string;
  description: string | null;
}

export type IssuePreviewFailure = "timeout" | "http" | "network" | "json";

export class IssuePreviewFetchError extends Error {
  readonly kind: IssuePreviewFailure;
  readonly status?: number;

  constructor(kind: IssuePreviewFailure, status?: number) {
    super(kind);
    this.name = "IssuePreviewFetchError";
    this.kind = kind;
    this.status = status;
  }
}

export async function fetchIssuePreview(
  t: Tracker,
  key: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<IssuePreview | null> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new IssuePreviewFetchError("timeout"));
    }, timeoutMs);
  });
  const request = (async (): Promise<IssuePreview | null> => {
    let res: Response;
    try {
      res = await fetchImpl(
        `${t.baseUrl}/api/issues/${encodeURIComponent(key)}?fields=${encodeURIComponent(ISSUE_PREVIEW_FIELDS)}`,
        {
          headers: { Authorization: `Bearer ${t.token}`, Accept: "application/json" },
          signal: controller.signal,
        },
      );
    } catch {
      throw new IssuePreviewFetchError("network");
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new IssuePreviewFetchError("http", res.status);
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      throw new IssuePreviewFetchError("json");
    }
    if (
      typeof raw !== "object" || raw === null ||
      typeof (raw as { idReadable?: unknown }).idReadable !== "string" ||
      typeof (raw as { summary?: unknown }).summary !== "string"
    ) throw new IssuePreviewFetchError("json");
    const description = (raw as { description?: unknown }).description;
    if (description !== undefined && description !== null && typeof description !== "string")
      throw new IssuePreviewFetchError("json");
    return {
      idReadable: (raw as { idReadable: string }).idReadable,
      summary: (raw as { summary: string }).summary,
      description: typeof description === "string" ? description : null,
    };
  })();
  try {
    return await Promise.race([request, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Fetch every page of `Assignee: me` from one instance (R2.3). */
export async function fetchAll(
  t: Tracker,
  fetchImpl: typeof fetch = fetch,
  query: string = QUERY,
  fields: string = FIELDS,
): Promise<RawIssue[]> {
  const all: RawIssue[] = [];
  for (let skip = 0; ; skip += PAGE) {
    const url =
      `${t.baseUrl}/api/issues?query=${encodeURIComponent(query)}` +
      `&fields=${encodeURIComponent(fields)}&$skip=${skip}&$top=${PAGE}`;
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${t.token}`, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(
        `${t.name}: HTTP ${res.status} from ${t.baseUrl} — ` +
          (res.status === 401
            ? `token rejected; refresh YT_${t.name.toUpperCase()}_TOKEN in .env.local`
            : `check YT_${t.name.toUpperCase()}_URL in .env.local`),
      );
    }
    const page = (await res.json()) as RawIssue[];
    all.push(...page);
    if (page.length < PAGE) return all;
  }
}

/** Fetch one issue by readable id; null when it does not exist. */
export async function fetchIssue(
  t: Tracker,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RawIssue | null> {
  const url =
    `${t.baseUrl}/api/issues/${encodeURIComponent(key)}` +
    // FIELDS as it stands, nothing appended: YouTrack keeps only the last
    // `customFields` spec in a query and silently drops the earlier one, so a
    // second spec does not add a field — it takes the values' names away.
    `?fields=${encodeURIComponent(FIELDS)}`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${t.token}`, Accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${t.name}: HTTP ${res.status} fetching ${key}`);
  return (await res.json()) as RawIssue;
}

const meCache = new Map<string, string>();

/** The instance's own idea of who "me" is — logins differ across instances. */
export async function myLogin(t: Tracker, fetchImpl: typeof fetch = fetch): Promise<string> {
  const hit = meCache.get(t.name);
  if (hit) return hit;
  const res = await fetchImpl(`${t.baseUrl}/api/users/me?fields=login`, {
    headers: { Authorization: `Bearer ${t.token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${t.name}: HTTP ${res.status} resolving me`);
  const login = ((await res.json()) as { login: string }).login;
  meCache.set(t.name, login);
  return login;
}

export const STATE_FIELDS = "idReadable,summary,resolved,customFields(name,$type,value(login))";

/**
 * What the sync needs to know about the queue's tickets (R3.5), one query per
 * tracker: `issue id: K1, K2, …`. "Closed" is the tracker's own resolved mark —
 * a `Done` status with no resolved timestamp (the AEU quirk) keeps the row,
 * by rule: we never interpret status names. A ticket absent from the answer is
 * absent from the map — that is what "missing" looks like.
 */
export async function ticketStates(
  t: Tracker,
  keys: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, { resolved: boolean; assignedToMe: boolean; title: string }>> {
  const out = new Map<string, { resolved: boolean; assignedToMe: boolean; title: string }>();
  if (keys.length === 0) return out;
  const raw = await fetchAll(t, fetchImpl, `issue id: ${keys.join(", ")}`, STATE_FIELDS);
  const me = await myLogin(t, fetchImpl);
  for (const issue of raw) {
    const assignee = (
      issue.customFields as { $type: string; value?: { login?: string } | null }[] | undefined
    )?.find((cf) => /^SingleUserIssueCustomField$/.test(cf.$type))?.value?.login;
    out.set(issue.idReadable, {
      resolved: issue.resolved != null,
      assignedToMe: assignee === me,
      title: issue.summary,
    });
  }
  return out;
}

// Status comes from the field whose TYPE is a state field — the NAME varies per
// project (State, Stage, …), so we search by type and report what was picked
// (R2.4). The value is printed literally, never translated.
export function pickStatus(raw: RawIssue): { status: string; name: string; field: string } {
  for (const cf of raw.customFields ?? []) {
    if (STATE_FIELD.test(cf.$type)) {
      const v = cf.value;
      return { status: v?.localizedName ?? v?.name ?? "—", name: v?.name ?? "—", field: cf.name };
    }
  }
  return { status: "—", name: "—", field: "?" };
}

const STATE_FIELD = /^State(Machine)?IssueCustomField$/;

export interface StageField {
  /** What this project calls it: Stage in ACME, State almost everywhere else. */
  field: string;
  /** Every value on offer; `label` is what on-me prints, `name` what the API stores. */
  values: { name: string; label: string }[];
}

/**
 * The stage enum of one project, read through one of its issues (the admin API
 * needs rights a work token does not have). Values differ per project and are
 * never mapped between them (R2.4) — this only reports what is on offer.
 */
export async function stageField(
  t: Tracker,
  issueId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StageField | null> {
  const res = await fetchImpl(
    `${t.baseUrl}/api/issues/${encodeURIComponent(issueId)}/customFields` +
      `?fields=name,$type,projectCustomField(bundle(values(name,localizedName,archived)))&$top=100`,
    { headers: { Authorization: `Bearer ${t.token}`, Accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`${t.name}: HTTP ${res.status} reading stages of ${issueId}`);
  const cfs = (await res.json()) as {
    name: string;
    $type: string;
    projectCustomField?: {
      bundle?: { values?: { name: string; localizedName?: string | null; archived?: boolean }[] };
    };
  }[];
  for (const cf of cfs) {
    if (!STATE_FIELD.test(cf.$type)) continue;
    return {
      field: cf.name,
      values: (cf.projectCustomField?.bundle?.values ?? [])
        .filter((v) => !v.archived)
        .map((v) => ({ name: v.name, label: v.localizedName ?? v.name })),
    };
  }
  return null;
}

/**
 * Every enum value a project actually offers, read through one of its issues:
 * the admin API needs rights a work token does not have, an issue does not.
 * Keyed by field name, because the name of the "subsystem" field is a per-
 * tracker convention (acme calls it Subsystem) and we never assume it.
 */
export async function enumValues(
  t: Tracker,
  projectKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, string[]>> {
  const H = { Authorization: `Bearer ${t.token}`, Accept: "application/json" };
  const probe = (await (
    await fetchImpl(
      `${t.baseUrl}/api/issues?query=${encodeURIComponent(`project: ${projectKey}`)}` +
        `&fields=idReadable&$top=1`,
      { headers: H },
    )
  ).json()) as { idReadable: string }[];
  if (probe.length === 0) return new Map();
  const res = await fetchImpl(
    `${t.baseUrl}/api/issues/${probe[0].idReadable}/customFields` +
      `?fields=name,projectCustomField(bundle(values(name,archived)))&$top=100`,
    { headers: H },
  );
  if (!res.ok) throw new Error(`${t.name}: HTTP ${res.status} reading ${projectKey} fields`);
  const cfs = (await res.json()) as {
    name: string;
    projectCustomField?: { bundle?: { values?: { name: string; archived?: boolean }[] } };
  }[];
  const out = new Map<string, string[]>();
  for (const cf of cfs) {
    const vals = (cf.projectCustomField?.bundle?.values ?? [])
      .filter((v) => !v.archived)
      .map((v) => v.name);
    if (vals.length) out.set(cf.name, vals);
  }
  return out;
}

/** Every value an issue carries across its custom fields, names only. */
export function valueNames(raw: RawIssue): string[] {
  const out: string[] = [];
  for (const cf of raw.customFields ?? []) {
    const v = cf.value as unknown;
    for (const one of Array.isArray(v) ? v : [v]) {
      const name = (one as { name?: string } | null)?.name;
      if (name) out.push(name);
    }
  }
  return out;
}
