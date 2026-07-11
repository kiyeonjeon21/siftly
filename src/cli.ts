#!/usr/bin/env bun
/**
 * siftly CLI — thin wrapper over the source/render/cache core.
 *
 * Phase 1 commands:
 *   siftly hn [--limit N] [--comments M] [--json] [--out FILE] [--refresh] [--no-hint]
 *   siftly hn <id>            single story, deep
 */

import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";

import { cached, cacheStats, clearCache } from "./store/cache.ts";
import { fetchStory, fetchTopStories } from "./sources/hackernews.ts";
import { fetchChannel, fetchVideo, NoCaptionsError } from "./sources/youtube.ts";
import {
  fetchNews,
  fetchNewsStory,
  fetchTopic,
  fetchTrendingDigest,
  parseTrendingId,
} from "./sources/x.ts";
import { fetchAllFeeds, fetchFeed, readFeedList } from "./sources/rss.ts";
import { fetchDigest, parseSources, type DigestSource } from "./digest.ts";
import { parseVideoId } from "./util/youtube-url.ts";
import { renderDigest, renderMarkdown } from "./render/markdown.ts";
import { loadConfig } from "./config.ts";
import type { Item } from "./types.ts";

const cfg = loadConfig();
const DEFAULT_TTL_SEC = cfg.cache?.ttlSec ?? 30 * 60; // 30 min (override: config cache.ttlSec)

const USAGE = `siftly — pull content into agent-ready form, locally.

Usage:
  siftly hn [options]            Today's Hacker News front page
  siftly hn <id> [options]       A single HN story (with comment tree)
  siftly yt <url|id> [options]   A YouTube video's transcript (needs yt-dlp)
  siftly yt --channel <@handle>  Recent videos of a channel (--list for titles only)
  siftly x [options]             X trending digest (needs X_BEARER_TOKEN)
  siftly x --query "<topic>"     Top recent X posts for a topic
  siftly x --news "<topic>"      Curated X news stories for a topic
  siftly x --news-id <id|url>    A specific news story (+ the posts behind it)
  siftly rss [url] [options]     RSS/Atom feeds (~/.siftly/feeds.txt or a url)
  siftly digest [options]        Several sources at once, one document
  siftly cache stats             Show cache size / entries per source
  siftly cache clear [source]    Empty the cache (optionally one source)

Options:
  --sources LIST  digest: comma list of hn,rss,x,news (default hn,rss)
  --limit N       hn: stories (default 10); rss: items (default 20); digest: 8/source
  --comments M    hn: max comments per story (default 15)
  --timestamps    yt: prefix transcript lines with [mm:ss] offsets
  --gemini        yt: transcribe with Gemini when a video has no captions
  --channel NAME  yt: a channel's recent videos (@handle, name, or URL)
  --list          yt: with --channel, list titles/links only (no transcripts)
  --woeid N       x: trends location id (default 1 = worldwide)
  --trends K      x: number of trends (default 5)
  --posts M       x: posts per trend / topic (default 5)
  --query TOPIC   x: search a topic instead of trends
  --news TOPIC    x: curated news stories for a topic
  --news-id ID    x: a specific news story (id or /i/trending/ URL)
  --since DUR     rss: only items newer than DUR (e.g. 24h, 3d, 90m)
  --json          Output normalized Items as JSON instead of markdown
  --out FILE      Write output to FILE instead of stdout
  --refresh       Bypass the local cache and refetch
  --no-hint       Omit the trailing summarization hint (markdown only)
  -h, --help      Show this help
`;

function fail(msg: string): never {
  console.error(`siftly: ${msg}\n`);
  console.error(USAGE);
  process.exit(1);
}

async function runHn(positionals: string[], flags: Record<string, unknown>) {
  const limit = Number(flags.limit ?? cfg.hn?.limit ?? 10);
  const commentLimit = Number(flags.comments ?? cfg.hn?.comments ?? 15);
  const ttl = flags.refresh ? 0 : DEFAULT_TTL_SEC;
  const storyId = positionals[0];

  let items: Item[];
  if (storyId) {
    const item = await cached(
      `hn:item:${storyId}`,
      "hackernews",
      ttl,
      () => fetchStory(storyId),
    );
    items = [item];
  } else {
    items = await cached(
      `hn:front_page:limit=${limit}:comments=${commentLimit}`,
      "hackernews",
      ttl,
      () => fetchTopStories(limit, commentLimit),
    );
  }

  const output = flags.json
    ? JSON.stringify(items, null, 2)
    : renderMarkdown(items, {
        commentLimit,
        hint: flags["no-hint"] ? false : true,
        heading: storyId ? undefined : "Hacker News — front page",
      });

  emit(output, flags, items.length);
}

async function runYt(positionals: string[], flags: Record<string, unknown>) {
  const ttl = flags.refresh ? 0 : DEFAULT_TTL_SEC;
  const gemini = !!flags.gemini;

  if (typeof flags.channel === "string") {
    const chan = flags.channel;
    const limit = Number(flags.limit ?? 5);
    const list = !!flags.list;
    let items: Item[];
    try {
      items = await cached(
        `yt:channel:${chan}:n=${limit}${list ? ":list" : ""}`,
        "youtube",
        ttl,
        () => fetchChannel(chan, { limit, gemini, list }),
      );
    } catch (err) {
      console.error(`siftly: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
    const output = flags.json
      ? JSON.stringify(items, null, 2)
      : renderMarkdown(items, {
          hint: flags["no-hint"] ? false : true,
          timestamps: !!flags.timestamps,
          heading: `YouTube — ${chan}`,
        });
    emit(output, flags, items.length);
    return;
  }

  const input = positionals[0];
  if (!input) fail("yt requires a YouTube URL or video id (or --channel <handle>)");
  const videoId = parseVideoId(input);
  if (!videoId) fail(`not a recognizable YouTube URL or video id: "${input}"`);

  let item: Item;
  try {
    item = await cached(`yt:${videoId}`, "youtube", ttl, () => fetchVideo(videoId, { gemini }));
  } catch (err) {
    if (err instanceof NoCaptionsError) {
      console.error(
        "siftly: no captions available for this video. Retry with --gemini to transcribe it (needs GEMINI_API_KEY).",
      );
      process.exit(2);
    }
    throw err;
  }

  const output = flags.json
    ? JSON.stringify([item], null, 2)
    : renderMarkdown([item], {
        hint: flags["no-hint"] ? false : true,
        timestamps: !!flags.timestamps,
      });

  emit(output, flags, 1);
}

async function runX(flags: Record<string, unknown>) {
  const ttl = flags.refresh ? 0 : DEFAULT_TTL_SEC;
  const posts = Number(flags.posts ?? 5);
  const hint = flags["no-hint"] ? false : true;

  let items: Item[];
  let heading: string | undefined;
  try {
    if (typeof flags["news-id"] === "string") {
      const id = parseTrendingId(flags["news-id"]);
      if (!id) fail(`not a valid news id or x.com/i/trending URL: "${flags["news-id"]}"`);
      const item = await cached(`x:news:id=${id}`, "x", ttl, () => fetchNewsStory(id));
      items = [item];
    } else if (typeof flags.news === "string") {
      const q = flags.news;
      const maxResults = Number(flags.posts ?? 10);
      items = await cached(`x:news:q=${q}:n=${maxResults}`, "x", ttl, () =>
        fetchNews(q, { maxResults }),
      );
      heading = `X News — ${q}`;
    } else if (typeof flags.query === "string") {
      const q = flags.query;
      const item = await cached(`x:query:${q}:posts=${posts}`, "x", ttl, () => fetchTopic(q, posts));
      items = [item];
    } else {
      const woeid = Number(flags.woeid ?? cfg.x?.woeid ?? 1);
      const trendLimit = Number(flags.trends ?? 5);
      items = await cached(
        `x:trends:woeid=${woeid}:trends=${trendLimit}:posts=${posts}`,
        "x",
        ttl,
        () => fetchTrendingDigest({ woeid, trendLimit, postsPerTrend: posts }),
      );
      heading = `X — trending (woeid ${woeid})`;
    }
  } catch (err) {
    console.error(`siftly: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const output = flags.json
    ? JSON.stringify(items, null, 2)
    : renderMarkdown(items, { hint, heading });

  emit(output, flags, items.length);
}

/** "24h" | "3d" | "90m" -> cutoff epoch seconds, or null if unparseable. */
function parseSince(s: string): number | null {
  const m = s.match(/^(\d+)\s*([hdm])$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const secs = unit === "d" ? 86400 : unit === "h" ? 3600 : 60;
  return Math.floor(Date.now() / 1000) - n * secs;
}

async function runRss(positionals: string[], flags: Record<string, unknown>) {
  const ttl = flags.refresh ? 0 : DEFAULT_TTL_SEC;
  const limit = Number(flags.limit ?? cfg.rss?.limit ?? 20);
  const single = positionals[0];

  let items: Item[];
  try {
    if (single) {
      items = await cached(`rss:${single}`, "rss", ttl, () => fetchFeed(single));
      items = [...items].sort((a, b) => b.timestamp - a.timestamp);
    } else {
      items = await fetchAllFeeds(readFeedList(), ttl);
    }
  } catch (err) {
    console.error(`siftly: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  if (typeof flags.since === "string") {
    const cutoff = parseSince(flags.since);
    if (cutoff === null) fail(`invalid --since "${flags.since}" (use e.g. 24h, 3d, 90m)`);
    items = items.filter((i) => i.timestamp >= cutoff);
  }
  items = items.slice(0, limit);

  const output = flags.json
    ? JSON.stringify(items, null, 2)
    : renderMarkdown(items, {
        hint: flags["no-hint"] ? false : true,
        heading: single ? undefined : "RSS — latest",
      });

  emit(output, flags, items.length);
}

async function runDigest(flags: Record<string, unknown>) {
  const ttl = flags.refresh ? 0 : DEFAULT_TTL_SEC;
  const limit = Number(flags.limit ?? cfg.digest?.limit ?? 8);

  let sources: DigestSource[];
  try {
    const sourcesArg =
      typeof flags.sources === "string" ? flags.sources : cfg.digest?.sources?.join(",");
    sources = parseSources(sourcesArg);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  let sinceCutoff: number | null = null;
  if (typeof flags.since === "string") {
    sinceCutoff = parseSince(flags.since);
    if (sinceCutoff === null) fail(`invalid --since "${flags.since}" (use e.g. 24h, 3d, 90m)`);
  }

  const sections = await fetchDigest({ sources, limit, sinceCutoff, ttlSec: ttl });

  const output = flags.json
    ? JSON.stringify(sections.flatMap((s) => s.items), null, 2)
    : renderDigest(sections, { hint: flags["no-hint"] ? false : true });

  const count = sections.reduce((n, s) => n + s.items.length, 0);
  emit(output, flags, count);
}

function runCache(rest: string[]) {
  const sub = rest[0];
  if (sub === "stats") {
    const s = cacheStats();
    const lines = [`cache: ${s.rows} entr${s.rows === 1 ? "y" : "ies"}`];
    if (s.oldest) lines.push(`oldest: ${new Date(s.oldest * 1000).toISOString()}`);
    for (const [src, n] of Object.entries(s.bySource)) lines.push(`  ${src}: ${n}`);
    console.log(lines.join("\n"));
  } else if (sub === "clear") {
    const n = clearCache(rest[1]);
    console.error(`siftly: cleared ${n} cache entr${n === 1 ? "y" : "ies"}${rest[1] ? ` for ${rest[1]}` : ""}`);
  } else {
    fail("usage: siftly cache <stats | clear [source]>");
  }
}

function emit(output: string, flags: Record<string, unknown>, count: number) {
  if (typeof flags.out === "string") {
    writeFileSync(flags.out, output);
    console.error(`siftly: wrote ${count} item(s) to ${flags.out}`);
  } else {
    console.log(output);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      limit: { type: "string" },
      comments: { type: "string" },
      timestamps: { type: "boolean" },
      gemini: { type: "boolean" },
      channel: { type: "string" },
      list: { type: "boolean" },
      woeid: { type: "string" },
      trends: { type: "string" },
      posts: { type: "string" },
      query: { type: "string" },
      news: { type: "string" },
      "news-id": { type: "string" },
      since: { type: "string" },
      sources: { type: "string" },
      json: { type: "boolean" },
      out: { type: "string" },
      refresh: { type: "boolean" },
      "no-hint": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  const [command, ...rest] = positionals;

  if (values.help || !command) {
    console.log(USAGE);
    process.exit(0);
  }

  switch (command) {
    case "hn":
      await runHn(rest, values);
      break;
    case "yt":
      await runYt(rest, values);
      break;
    case "x":
      await runX(values);
      break;
    case "rss":
      await runRss(rest, values);
      break;
    case "digest":
      await runDigest(values);
      break;
    case "cache":
      runCache(rest);
      break;
    default:
      fail(`unknown command "${command}"`);
  }
}

main().catch((err) => {
  console.error(`siftly: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
