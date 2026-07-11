/**
 * Optional per-user defaults, read from ~/.siftly/config.json. Precedence is
 * always: CLI flag > config value > built-in default. Missing/invalid config
 * simply falls back to an empty object (all built-in defaults).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  digest?: { sources?: string[]; limit?: number };
  hn?: { limit?: number; comments?: number };
  x?: { woeid?: number };
  rss?: { limit?: number };
  cache?: { ttlSec?: number };
}

const CONFIG_PATH = join(homedir(), ".siftly", "config.json");

/** Coerce arbitrary parsed JSON into a Config (objects pass through, else {}). */
export function parseConfig(raw: unknown): Config {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Config) : {};
}

let loaded: Config | null = null;

export function loadConfig(): Config {
  if (loaded) return loaded;
  try {
    loaded = parseConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
  } catch {
    loaded = {};
  }
  return loaded;
}
