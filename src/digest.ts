/**
 * Multi-source digest: pull several sources at once into one document so an
 * agent can summarize the whole thing in a single pass. This is an orchestrator
 * over the existing source fetchers — not a source itself.
 */

import type { Item } from "./types.ts";
import { cached } from "./store/cache.ts";
import { fetchTopStories } from "./sources/hackernews.ts";
import { fetchAllFeeds, readFeedList } from "./sources/rss.ts";
import { fetchNews, fetchTrendingDigest, readNewsTopics } from "./sources/x.ts";

export type DigestSource = "hackernews" | "rss" | "x" | "news";

const ALIASES: Record<string, DigestSource> = {
  hn: "hackernews",
  hackernews: "hackernews",
  rss: "rss",
  x: "x",
  twitter: "x",
  news: "news",
};

const LABELS: Record<DigestSource, string> = {
  hackernews: "Hacker News",
  rss: "RSS",
  x: "X — trending",
  news: "X News",
};

const DEFAULT_SOURCES: DigestSource[] = ["hackernews", "rss"];

/** Parse a "hn,rss,x" list into source kinds. Defaults to HN + RSS. */
export function parseSources(str?: string): DigestSource[] {
  if (!str) return [...DEFAULT_SOURCES];
  const out: DigestSource[] = [];
  for (const raw of str.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const kind = ALIASES[raw];
    if (!kind) throw new Error(`unknown source "${raw}" (use hn, rss, x)`);
    if (!out.includes(kind)) out.push(kind);
  }
  return out.length ? out : [...DEFAULT_SOURCES];
}

export interface DigestSection {
  source: DigestSource;
  label: string;
  items: Item[];
}

export interface DigestOptions {
  sources: DigestSource[];
  /** Items per source. */
  limit: number;
  /** Epoch-seconds cutoff for RSS items, or null for no filter. */
  sinceCutoff: number | null;
  ttlSec: number;
}

async function fetchOne(source: DigestSource, opts: DigestOptions): Promise<Item[]> {
  const { limit, ttlSec } = opts;

  if (source === "hackernews") {
    return cached(`hn:front_page:limit=${limit}:comments=5`, "hackernews", ttlSec, () =>
      fetchTopStories(limit, 5),
    );
  }

  if (source === "rss") {
    let items = await fetchAllFeeds(readFeedList(), ttlSec);
    if (opts.sinceCutoff !== null) {
      const cutoff = opts.sinceCutoff;
      items = items.filter((i) => i.timestamp >= cutoff);
    }
    return items.slice(0, limit);
  }

  if (source === "news") {
    const perTopic = await Promise.all(
      readNewsTopics().map((topic) =>
        cached(`x:news:q=${topic}:n=5`, "x", ttlSec, () => fetchNews(topic, { maxResults: 5 })),
      ),
    );
    // Dedupe the same story surfaced by multiple topics, keep newest first.
    const seen = new Set<string>();
    const merged = perTopic.flat().filter((it) => (seen.has(it.id) ? false : (seen.add(it.id), true)));
    merged.sort((a, b) => b.timestamp - a.timestamp);
    return merged.slice(0, limit);
  }

  // x
  const trendLimit = Math.min(limit, 5);
  return cached(`x:trends:woeid=1:trends=${trendLimit}:posts=3`, "x", ttlSec, () =>
    fetchTrendingDigest({ woeid: 1, trendLimit, postsPerTrend: 3 }),
  );
}

/**
 * Fetch every selected source concurrently, keeping the requested order. A
 * source that fails (missing feeds.txt, X 403, …) is skipped with a warning
 * rather than failing the whole digest.
 */
export async function fetchDigest(opts: DigestOptions): Promise<DigestSection[]> {
  const results = await Promise.all(
    opts.sources.map((source) =>
      fetchOne(source, opts)
        .then((items) => ({ source, items }))
        .catch((e) => {
          console.error(`siftly: skipping ${source} (${e instanceof Error ? e.message : String(e)})`);
          return { source, items: [] as Item[] };
        }),
    ),
  );
  const sections = results.map((r) => ({ source: r.source, label: LABELS[r.source], items: r.items }));
  return dedupeAcrossSections(sections);
}

/**
 * Drop items whose `metadata.url` already appeared in an earlier section (or
 * earlier in the same section) — e.g. an HN story that also shows up via an HN
 * RSS feed. Items without a url are always kept. Earliest section wins.
 */
export function dedupeAcrossSections(sections: DigestSection[]): DigestSection[] {
  const seen = new Set<string>();
  return sections.map((s) => ({
    ...s,
    items: s.items.filter((it) => {
      const url = it.metadata.url;
      if (!url) return true;
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    }),
  }));
}
