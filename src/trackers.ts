// YouTrack instance registry. Tokens live in .env.local (R0.11), never in code.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface Tracker {
  kind: "youtrack";
  /** Org alias used across yokemate: acme-eu | acme | yokeloop */
  name: string;
  baseUrl: string;
  token: string;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvLocal(): Record<string, string> {
  const env: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(join(ROOT, ".env.local"), "utf8");
  } catch {
    throw new Error(
      "no .env.local in yokemate root — create it with YT_<NAME>_URL / YT_<NAME>_TOKEN pairs",
    );
  }
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

/** All configured YouTrack instances, derived from YT_<NAME>_URL keys. */
export function trackers(): Tracker[] {
  const env = loadEnvLocal();
  const list: Tracker[] = [];
  for (const key of Object.keys(env)) {
    const m = key.match(/^YT_([A-Z0-9_]+)_URL$/);
    if (!m) continue;
    // The name is the organization's, and orgs carry dashes (`acme-eu`). Env keys
    // cannot, so the underscore stands in for one: YT_ACME_EU_URL → acme-eu (R0.12).
    const name = m[1].toLowerCase().replace(/_/g, "-");
    const token = env[`YT_${m[1]}_TOKEN`];
    if (!token) {
      throw new Error(`YT_${m[1]}_URL is set but YT_${m[1]}_TOKEN is missing in .env.local`);
    }
    list.push({ kind: "youtrack", name, baseUrl: env[key].replace(/\/$/, ""), token });
  }
  return list;
}
