/**
 * RSS / Atom source. Reads feed URLs from ~/.siftly/feeds.txt (or a single URL
 * passed on the command line), parses them with fast-xml-parser, and normalizes
 * entries into Items. Newsletters that expose a feed (Substack /feed, etc.) come
 * through this same path.
 *
 * Pure parsing (`parseFeed`) is separated from the network calls for testing.
 */

import { XMLParser } from "fast-xml-parser";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Item } from "../types.ts";
import { htmlToText } from "../util/html.ts";
import { cached } from "../store/cache.ts";

const FEEDS_PATH = join(homedir(), ".siftly", "feeds.txt");

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

// ---- Value coercion helpers (feed elements vary: string | {#text} | array) ----

function xmlText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return xmlText(v[0]);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("#text" in o) return xmlText(o["#text"]);
  }
  return "";
}

/** Atom <link> may be a string, an object, or an array; prefer rel="alternate". */
function atomLink(link: unknown): string {
  if (typeof link === "string") return link;
  const arr = Array.isArray(link) ? link : [link];
  const pick =
    arr.find((l) => (l as Record<string, unknown>)?.["@_rel"] === "alternate") ??
    arr.find((l) => (l as Record<string, unknown>)?.["@_href"]);
  return pick ? String((pick as Record<string, unknown>)["@_href"] ?? "") : "";
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// ---- Pure parsing ----

interface RawEntry {
  id: string;
  title: string;
  author: string;
  dateStr: string;
  body: string;
  link: string;
  feedTitle: string;
}

function normalize(r: RawEntry): Item {
  const ms = r.dateStr ? Date.parse(r.dateStr) : NaN;
  return {
    id: r.id,
    source: "rss",
    // Titles can carry (sometimes double-)encoded entities; decode via htmlToText.
    title: htmlToText(r.title) || "(untitled)",
    author: r.author,
    timestamp: Number.isFinite(ms) ? Math.floor(ms / 1000) : 0,
    body: htmlToText(r.body),
    comments: [],
    metadata: { url: r.link || undefined, feedTitle: r.feedTitle || undefined },
  };
}

function parseRssChannel(channel: Record<string, any>): Item[] {
  const feedTitle = xmlText(channel.title);
  return toArray(channel.item).map((it: Record<string, any>) => {
    const link = xmlText(it.link);
    return normalize({
      id: xmlText(it.guid) || link,
      title: xmlText(it.title),
      author: xmlText(it["dc:creator"]) || xmlText(it.author) || feedTitle,
      dateStr: xmlText(it.pubDate) || xmlText(it["dc:date"]),
      body: xmlText(it["content:encoded"] ?? it.description),
      link,
      feedTitle,
    });
  });
}

function parseAtomFeed(feed: Record<string, any>): Item[] {
  const feedTitle = xmlText(feed.title);
  const feedAuthor = xmlText(feed.author?.name);
  return toArray(feed.entry).map((e: Record<string, any>) => {
    const link = atomLink(e.link);
    return normalize({
      id: xmlText(e.id) || link,
      title: xmlText(e.title),
      author: xmlText(e.author?.name) || feedAuthor || feedTitle,
      dateStr: xmlText(e.published) || xmlText(e.updated),
      body: xmlText(e.content ?? e.summary),
      link,
      feedTitle,
    });
  });
}

/** Parse an RSS 2.0 or Atom document into normalized Items. */
export function parseFeed(xml: string): Item[] {
  const doc = parser.parse(xml);
  if (doc?.rss?.channel) return parseRssChannel(doc.rss.channel);
  if (doc?.feed) return parseAtomFeed(doc.feed);
  throw new Error("unrecognized feed format (neither RSS nor Atom)");
}

// ---- Feed list + network ----

/** Read feed URLs from ~/.siftly/feeds.txt (one per line, '#' comments). */
export function readFeedList(): string[] {
  let text: string;
  try {
    text = readFileSync(FEEDS_PATH, "utf8");
  } catch {
    throw new Error(
      `no feed list found. Create ${FEEDS_PATH} (one feed URL per line), or pass one: siftly rss <url>`,
    );
  }
  const urls = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (!urls.length) throw new Error(`${FEEDS_PATH} has no feed URLs.`);
  return urls;
}

/** Fetch and parse a single feed. */
export async function fetchFeed(url: string): Promise<Item[]> {
  const res = await fetch(url, { headers: { "User-Agent": "siftly/0.1" } });
  if (!res.ok) throw new Error(`feed ${url} returned ${res.status}`);
  try {
    return parseFeed(await res.text());
  } catch (e) {
    throw new Error(`failed to parse ${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Fetch every feed (each cached independently so one slow/broken feed doesn't
 * block or invalidate the others), merged newest-first. Broken feeds are
 * skipped with a warning rather than failing the whole digest.
 */
export async function fetchAllFeeds(urls: string[], ttlSec: number): Promise<Item[]> {
  const perFeed = await Promise.all(
    urls.map((url) =>
      cached(`rss:${url}`, "rss", ttlSec, () => fetchFeed(url)).catch((e) => {
        console.error(`siftly: skipping ${url} (${e instanceof Error ? e.message : String(e)})`);
        return [] as Item[];
      }),
    ),
  );
  return perFeed.flat().sort((a, b) => b.timestamp - a.timestamp);
}
