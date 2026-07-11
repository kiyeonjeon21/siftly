/**
 * Local fetch cache backed by SQLite (bun:sqlite, no install).
 *
 * Stores normalized payloads (JSON) keyed by an arbitrary string, so re-running
 * a command within its TTL skips the network and returns instantly — the same
 * content an agent can re-read cheaply.
 *
 * DB lives at ~/.siftly/siftly.db (outside any project tree).
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".siftly");
const DB_PATH = join(DIR, "siftly.db");

let db: Database | null = null;

function connect(): Database {
  if (db) return db;
  mkdirSync(DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.run("PRAGMA journal_mode = WAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS cache (
      key        TEXT PRIMARY KEY,
      source     TEXT NOT NULL,
      payload    TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    )
  `);
  return db;
}

interface Row {
  payload: string;
  fetched_at: number;
}

/**
 * Return the cached payload for `key` if present and younger than `ttlSec`
 * seconds; otherwise `null`. `ttlSec <= 0` always misses.
 */
export function get<T>(key: string, ttlSec: number): T | null {
  if (ttlSec <= 0) return null;
  const row = connect()
    .query<Row, [string]>("SELECT payload, fetched_at FROM cache WHERE key = ?")
    .get(key);
  if (!row) return null;
  const ageSec = Math.floor(Date.now() / 1000) - row.fetched_at;
  if (ageSec > ttlSec) return null;
  return JSON.parse(row.payload) as T;
}

/** Upsert a payload under `key`. */
export function set(key: string, source: string, payload: unknown): void {
  connect().run(
    `INSERT INTO cache (key, source, payload, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       source = excluded.source,
       payload = excluded.payload,
       fetched_at = excluded.fetched_at`,
    [key, source, JSON.stringify(payload), Math.floor(Date.now() / 1000)],
  );
}

/**
 * Get-or-fetch helper: returns the cached value when fresh, otherwise runs
 * `fetcher`, caches the result, and returns it. Pass `ttlSec = 0` to force a
 * refresh.
 */
export async function cached<T>(
  key: string,
  source: string,
  ttlSec: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const hit = get<T>(key, ttlSec);
  if (hit !== null) return hit;
  const fresh = await fetcher();
  set(key, source, fresh);
  return fresh;
}

/** Delete all cached entries, or only those for one source. Returns rows removed. */
export function clearCache(source?: string): number {
  const db = connect();
  const res = source
    ? db.query("DELETE FROM cache WHERE source = ?").run(source)
    : db.query("DELETE FROM cache").run();
  return res.changes;
}

export interface CacheStats {
  rows: number;
  /** Oldest entry's fetched_at (epoch seconds), or null when empty. */
  oldest: number | null;
  bySource: Record<string, number>;
}

export function cacheStats(): CacheStats {
  const db = connect();
  const rows = (db.query("SELECT COUNT(*) AS n FROM cache").get() as { n: number }).n;
  const oldest = (db.query("SELECT MIN(fetched_at) AS m FROM cache").get() as { m: number | null }).m;
  const bySource: Record<string, number> = {};
  const grouped = db
    .query("SELECT source, COUNT(*) AS n FROM cache GROUP BY source")
    .all() as { source: string; n: number }[];
  for (const r of grouped) bySource[r.source] = r.n;
  return { rows, oldest, bySource };
}
