#!/usr/bin/env bun
/**
 * siftly MCP server — exposes the sources as tools so any MCP host (Claude
 * Desktop / Claude Code / Cursor) can pull agent-ready content and summarize it
 * itself. Local stdio transport, single user; secrets come from the environment
 * (Bun auto-loads .env). This is a thin adapter over the existing core — every
 * tool reuses the same fetch functions, renderer, and cache as the CLI.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { cached } from "./store/cache.ts";
import { fetchStory, fetchTopStories } from "./sources/hackernews.ts";
import { fetchVideo, NoCaptionsError } from "./sources/youtube.ts";
import { fetchNews, fetchNewsStory, fetchTopic, parseTrendingId } from "./sources/x.ts";
import { fetchAllFeeds, fetchFeed, readFeedList } from "./sources/rss.ts";
import { fetchDigest, parseSources } from "./digest.ts";
import { parseVideoId } from "./util/youtube-url.ts";
import { renderDigest, renderMarkdown } from "./render/markdown.ts";
import type { Item } from "./types.ts";

const DEFAULT_TTL_SEC = 30 * 60;

/** "24h" | "3d" | "90m" -> cutoff epoch seconds, or null. */
function parseSince(s: string): number | null {
  const m = s.match(/^(\d+)\s*([hdm])$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const secs = unit === "d" ? 86400 : unit === "h" ? 3600 : 60;
  return Math.floor(Date.now() / 1000) - n * secs;
}

const server = new McpServer({ name: "siftly", version: "0.1.0" });

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (s: string): Result => ({ content: [{ type: "text", text: s }] });
const fail = (msg: string): Result => ({ content: [{ type: "text", text: `Error: ${msg}` }], isError: true });

/** Register a read-only tool; wrap the handler so errors surface as isError. */
function tool(
  name: string,
  description: string,
  inputSchema: z.ZodRawShape,
  handler: (args: Record<string, unknown>) => Promise<string>,
): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    async (args) => {
      try {
        return text(await handler(args as Record<string, unknown>));
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
}

const formatField = {
  format: z.enum(["markdown", "json"]).optional().describe("Output format (default markdown)"),
};
const asJson = (a: Record<string, unknown>) => a.format === "json";
const num = (v: unknown, d: number) => (typeof v === "number" ? v : d);

// ---- digest ----
tool(
  "siftly_digest",
  "Pull several sources at once (Hacker News, RSS, and optionally X) into one agent-ready document. Best for a daily 'what's happening' briefing to summarize in a single pass.",
  {
    sources: z.string().optional().describe("Comma list of hn,rss,x,news (default: hn,rss)"),
    limit: z.number().int().positive().optional().describe("Items per source (default 8)"),
    since: z.string().optional().describe("Only RSS items newer than this, e.g. 24h, 3d, 90m"),
    ...formatField,
  },
  async (a) => {
    const sources = parseSources(typeof a.sources === "string" ? a.sources : undefined);
    const sinceCutoff = typeof a.since === "string" ? parseSince(a.since) : null;
    const sections = await fetchDigest({
      sources,
      limit: num(a.limit, 8),
      sinceCutoff,
      ttlSec: DEFAULT_TTL_SEC,
    });
    return asJson(a)
      ? JSON.stringify(sections.flatMap((s) => s.items), null, 2)
      : renderDigest(sections, { hint: false });
  },
);

// ---- hacker news ----
tool(
  "siftly_hackernews",
  "Today's Hacker News front page (or one story by id) with comment trees, ready to summarize.",
  {
    limit: z.number().int().positive().optional().describe("Number of stories (default 10)"),
    story_id: z.string().optional().describe("Fetch a single story by its HN id"),
    comments: z.number().int().nonnegative().optional().describe("Max comments per story (default 15)"),
    ...formatField,
  },
  async (a) => {
    const commentLimit = num(a.comments, 15);
    let items: Item[];
    if (typeof a.story_id === "string") {
      const id = a.story_id;
      items = [await cached(`hn:item:${id}`, "hackernews", DEFAULT_TTL_SEC, () => fetchStory(id))];
    } else {
      const limit = num(a.limit, 10);
      items = await cached(
        `hn:front_page:limit=${limit}:comments=${commentLimit}`,
        "hackernews",
        DEFAULT_TTL_SEC,
        () => fetchTopStories(limit, commentLimit),
      );
    }
    return asJson(a)
      ? JSON.stringify(items, null, 2)
      : renderMarkdown(items, {
          commentLimit,
          hint: false,
          heading: a.story_id ? undefined : "Hacker News — front page",
        });
  },
);

// ---- youtube ----
tool(
  "siftly_youtube",
  "Extract a YouTube video's transcript plus metadata from a URL or id. Falls back to Gemini transcription only when asked and the video has no captions.",
  {
    url: z.string().describe("YouTube URL or 11-char video id"),
    timestamps: z.boolean().optional().describe("Prefix transcript lines with [mm:ss]"),
    gemini: z.boolean().optional().describe("Transcribe with Gemini if the video has no captions"),
    ...formatField,
  },
  async (a) => {
    const id = parseVideoId(String(a.url));
    if (!id) throw new Error(`not a recognizable YouTube URL or id: "${a.url}"`);
    let item: Item;
    try {
      item = await cached(`yt:${id}`, "youtube", DEFAULT_TTL_SEC, () =>
        fetchVideo(id, { gemini: a.gemini === true }),
      );
    } catch (e) {
      if (e instanceof NoCaptionsError) {
        throw new Error("no captions available; call again with gemini: true to transcribe it");
      }
      throw e;
    }
    return asJson(a)
      ? JSON.stringify([item], null, 2)
      : renderMarkdown([item], { hint: false, timestamps: a.timestamps === true });
  },
);

// ---- x news ----
tool(
  "siftly_x_news",
  "Curated X (Twitter) news stories: search by topic, or fetch one story by id / x.com/i/trending URL (which also returns the posts driving it).",
  {
    topic: z.string().optional().describe("Search curated news for this topic"),
    id: z.string().optional().describe("A news story id or x.com/i/trending/<id> URL"),
    ...formatField,
  },
  async (a) => {
    let items: Item[];
    if (typeof a.id === "string") {
      const id = parseTrendingId(a.id);
      if (!id) throw new Error(`not a valid news id or x.com/i/trending URL: "${a.id}"`);
      items = [await cached(`x:news:id=${id}`, "x", DEFAULT_TTL_SEC, () => fetchNewsStory(id))];
    } else if (typeof a.topic === "string") {
      const q = a.topic;
      items = await cached(`x:news:q=${q}:n=10`, "x", DEFAULT_TTL_SEC, () => fetchNews(q));
    } else {
      throw new Error("provide either 'topic' or 'id'");
    }
    return asJson(a) ? JSON.stringify(items, null, 2) : renderMarkdown(items, { hint: false });
  },
);

// ---- x search ----
tool(
  "siftly_x_search",
  "Top recent X (Twitter) posts for a topic, ranked by engagement (last ~7 days).",
  {
    query: z.string().describe("Search topic"),
    posts: z.number().int().positive().optional().describe("Number of posts (default 5)"),
    ...formatField,
  },
  async (a) => {
    const q = String(a.query);
    const posts = num(a.posts, 5);
    const item = await cached(`x:query:${q}:posts=${posts}`, "x", DEFAULT_TTL_SEC, () =>
      fetchTopic(q, posts),
    );
    return asJson(a) ? JSON.stringify([item], null, 2) : renderMarkdown([item], { hint: false });
  },
);

// ---- rss ----
tool(
  "siftly_rss",
  "RSS/Atom feed items — a single feed URL, or all feeds from ~/.siftly/feeds.txt merged newest-first.",
  {
    url: z.string().optional().describe("A single feed URL (omit to use ~/.siftly/feeds.txt)"),
    since: z.string().optional().describe("Only items newer than this, e.g. 24h, 3d"),
    limit: z.number().int().positive().optional().describe("Max items (default 20)"),
    ...formatField,
  },
  async (a) => {
    const limit = num(a.limit, 20);
    let items: Item[];
    if (typeof a.url === "string") {
      const url = a.url;
      items = await cached(`rss:${url}`, "rss", DEFAULT_TTL_SEC, () => fetchFeed(url));
      items = [...items].sort((x, y) => y.timestamp - x.timestamp);
    } else {
      items = await fetchAllFeeds(readFeedList(), DEFAULT_TTL_SEC);
    }
    if (typeof a.since === "string") {
      const cutoff = parseSince(a.since);
      if (cutoff !== null) items = items.filter((i) => i.timestamp >= cutoff);
    }
    items = items.slice(0, limit);
    return asJson(a)
      ? JSON.stringify(items, null, 2)
      : renderMarkdown(items, { hint: false, heading: a.url ? undefined : "RSS — latest" });
  },
);

export async function startMcpServer(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

// Allow running this file directly (`bun run src/mcp.ts`) as well as via `siftly mcp`.
if (import.meta.main) await startMcpServer();
