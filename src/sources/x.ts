/**
 * X (Twitter) source, backed by the X API v2 with an App-only Bearer Token
 * (read-only). Reads the trending list and, for each trend, the most-engaged
 * recent posts.
 *
 * Requires `X_BEARER_TOKEN` in the environment (Bun auto-loads .env). Reads are
 * gated by the account's API tier — Free tier returns 403 for these endpoints.
 *
 * Pure parsing/normalization is separated from the network calls for testing.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Comment, Item } from "../types.ts";

const API = "https://api.x.com/2";

// ---- X API response shapes (only fields we use) ----

interface TrendsResponse {
  data?: { trend_name: string; tweet_count?: number | null }[];
}

interface SearchResponse {
  data?: {
    id: string;
    text: string;
    created_at?: string;
    author_id?: string;
    public_metrics?: {
      like_count?: number;
      retweet_count?: number;
      reply_count?: number;
    };
  }[];
  includes?: { users?: { id: string; username: string; name?: string }[] };
}

export interface Trend {
  name: string;
  tweetCount?: number;
}

export interface Post {
  id: string;
  text: string;
  author: string;
  timestamp: number;
  likes: number;
  reposts: number;
  replies: number;
}

// ---- Pure parsing / normalization ----

export function parseTrends(json: TrendsResponse, limit: number): Trend[] {
  return (json.data ?? [])
    .slice(0, limit)
    .map((t) => ({ name: t.trend_name, tweetCount: t.tweet_count ?? undefined }));
}

/** Parse a search/timeline response and resolve authors, preserving API order. */
export function parsePostsRaw(json: SearchResponse): Post[] {
  const users = new Map((json.includes?.users ?? []).map((u) => [u.id, u]));
  return (json.data ?? []).map((t) => {
    const u = t.author_id ? users.get(t.author_id) : undefined;
    const handle = u ? `@${u.username}${u.name ? ` (${u.name})` : ""}` : "@unknown";
    const m = t.public_metrics ?? {};
    return {
      id: t.id,
      text: t.text,
      author: handle,
      timestamp: t.created_at ? Math.floor(Date.parse(t.created_at) / 1000) : 0,
      likes: m.like_count ?? 0,
      reposts: m.retweet_count ?? 0,
      replies: m.reply_count ?? 0,
    };
  });
}

/** Parse a search response, then rank by engagement desc and trim to `count`. */
export function parsePosts(json: SearchResponse, count: number): Post[] {
  const posts = parsePostsRaw(json);
  posts.sort((a, b) => b.likes + b.reposts - (a.likes + a.reposts));
  return posts.slice(0, count);
}

function slug(name: string): string {
  return name.replace(/^#/, "").replace(/\s+/g, "-").toLowerCase();
}

function postToComment(p: Post): Comment {
  return {
    id: p.id,
    author: p.author,
    timestamp: p.timestamp,
    text: p.text,
    depth: 0,
    metrics: { likes: p.likes, reposts: p.reposts, replies: p.replies },
  };
}

/** One trend + its top posts -> an Item (posts live in comments[]). */
export function normalizeTrendItem(trend: Trend, posts: Post[]): Item {
  return {
    id: `x:${slug(trend.name)}`,
    source: "x",
    title: trend.name,
    author: "",
    timestamp: 0,
    body: "",
    comments: posts.map(postToComment),
    metadata: { tweetCount: trend.tweetCount, query: trend.name },
  };
}

/** A free-form topic search -> a single Item. */
export function normalizeTopicItem(query: string, posts: Post[]): Item {
  return {
    id: `x:query:${slug(query)}`,
    source: "x",
    title: `Search: ${query}`,
    author: "",
    timestamp: 0,
    body: "",
    comments: posts.map(postToComment),
    metadata: { query },
  };
}

// ---- Network ----

function bearer(): string {
  const token = Bun.env.X_BEARER_TOKEN;
  if (!token) {
    throw new Error("X_BEARER_TOKEN not set (add it to .env). Needed for the X source.");
  }
  return token;
}

async function apiGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${bearer()}` } });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    if (res.status === 401) throw new Error("X API 401: invalid or expired X_BEARER_TOKEN.");
    if (res.status === 403) {
      throw new Error(
        "X API 403: your API tier may not allow this endpoint (reads need Basic tier or higher).",
      );
    }
    if (res.status === 429) throw new Error("X API 429: rate limit hit. Try again later.");
    throw new Error(`X API ${res.status}: ${detail}`);
  }
  return (await res.json()) as T;
}

export async function fetchTrends(woeid: number, limit: number): Promise<Trend[]> {
  const json = await apiGet<TrendsResponse>(`/trends/by/woeid/${woeid}`);
  return parseTrends(json, limit);
}

export async function fetchTopPosts(query: string, count: number): Promise<Post[]> {
  // Recent search only covers the last ~7 days and can't sort by popularity on
  // Basic tier, so over-fetch a wide candidate pool and rank by engagement
  // client-side. max_results must be in [10, 100].
  const maxResults = Math.min(100, Math.max(50, count));
  const json = await apiGet<SearchResponse>("/tweets/search/recent", {
    query: `${query} -is:retweet`,
    max_results: String(maxResults),
    sort_order: "relevancy",
    "tweet.fields": "public_metrics,created_at,author_id",
    expansions: "author_id",
    "user.fields": "username,name",
  });
  return parsePosts(json, count);
}

export interface DigestOptions {
  woeid: number;
  trendLimit: number;
  postsPerTrend: number;
}

/** Trending digest: trends + top posts per trend, one Item per trend. */
export async function fetchTrendingDigest(opts: DigestOptions): Promise<Item[]> {
  const trends = await fetchTrends(opts.woeid, opts.trendLimit);
  return Promise.all(
    trends.map(async (trend) => {
      const posts = await fetchTopPosts(trend.name, opts.postsPerTrend);
      return normalizeTrendItem(trend, posts);
    }),
  );
}

/** Single free-form topic search. */
export async function fetchTopic(query: string, count: number): Promise<Item> {
  const posts = await fetchTopPosts(query, count);
  return normalizeTopicItem(query, posts);
}

// ---- User timeline (a specific account's recent posts) ----

interface UserLookup {
  data?: { id: string; username: string; name?: string };
}

/** A user's recent posts -> an Item (posts in comments[], recency order). */
export function normalizeUserItem(handle: string, name: string | undefined, posts: Post[]): Item {
  return {
    id: `x:user:${handle.toLowerCase()}`,
    source: "x",
    title: name ? `@${handle} (${name})` : `@${handle}`,
    author: "",
    timestamp: 0,
    body: "",
    comments: posts.map(postToComment),
    metadata: { url: `https://x.com/${handle}`, query: `@${handle}` },
  };
}

/** Fetch a specific account's most recent original posts (newest first). */
export async function fetchUserPosts(handle: string, count: number): Promise<Item> {
  const clean = handle.replace(/^@/, "");
  const lookup = await apiGet<UserLookup>(`/users/by/username/${clean}`, {
    "user.fields": "name,username",
  });
  const user = lookup.data;
  if (!user) throw new Error(`X user not found: @${clean}`);

  const json = await apiGet<SearchResponse>(`/users/${user.id}/tweets`, {
    max_results: String(Math.min(100, Math.max(5, count))),
    "tweet.fields": "public_metrics,created_at,author_id",
    expansions: "author_id",
    "user.fields": "username,name",
    exclude: "retweets,replies",
  });
  return normalizeUserItem(clean, user.name, parsePostsRaw(json).slice(0, count));
}

// ---- News (Grok-curated news stories; the /explore/tabs/news and
//      /i/trending/<id> content, reachable with the app-only Bearer) ----

interface NewsStoryRaw {
  id: string;
  name?: string | null;
  summary?: string | null;
  category?: string | null;
  updated_at?: string | null;
  contexts?: {
    topics?: string[];
    entities?: { people?: string[]; organizations?: string[] };
  };
  cluster_posts_results?: { post_id: string }[];
}

const NEWS_FIELDS = "id,name,summary,category,contexts,keywords,updated_at,cluster_posts_results";

/** The public trend/news detail URL for a story id. */
function newsUrl(id: string): string {
  return `https://x.com/i/trending/${id}`;
}

/** Topics + notable people/orgs behind a story, deduped. */
function newsTopics(ctx: NewsStoryRaw["contexts"]): string[] {
  if (!ctx) return [];
  const all = [
    ...(ctx.topics ?? []),
    ...(ctx.entities?.people ?? []),
    ...(ctx.entities?.organizations ?? []),
  ].filter(Boolean);
  return [...new Set(all)];
}

// ---- Pure parsing ----

export function parseNewsStory(raw: NewsStoryRaw, comments: Comment[] = []): Item {
  const ms = raw.updated_at ? Date.parse(raw.updated_at) : NaN;
  const topics = newsTopics(raw.contexts);
  return {
    id: `x:news:${raw.id}`,
    source: "x",
    title: raw.name ?? "(untitled)",
    author: "",
    timestamp: Number.isFinite(ms) ? Math.floor(ms / 1000) : 0,
    body: raw.summary ?? "",
    comments,
    metadata: {
      url: newsUrl(raw.id),
      category: raw.category ?? undefined,
      topics: topics.length ? topics : undefined,
    },
  };
}

export function parseNewsSearch(json: { data?: NewsStoryRaw[] }): Item[] {
  return (json.data ?? []).map((s) => parseNewsStory(s));
}

/** Extract a story id from a bare number or an x.com/i/trending/<id> URL. */
export function parseTrendingId(input: string): string | null {
  const s = input.trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/\/i\/trending\/(\d+)/);
  return m ? m[1]! : null;
}

// ---- Network ----

export interface NewsOptions {
  maxResults?: number;
  maxAgeHours?: number;
}

const NEWS_TOPICS_PATH = join(homedir(), ".siftly", "news.txt");

/** Read news topics from ~/.siftly/news.txt (one per line, '#' comments). */
export function readNewsTopics(): string[] {
  let text: string;
  try {
    text = readFileSync(NEWS_TOPICS_PATH, "utf8");
  } catch {
    throw new Error(
      `no news topics. Create ${NEWS_TOPICS_PATH} (one topic per line), or use: siftly x --news "<topic>"`,
    );
  }
  const topics = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (!topics.length) throw new Error(`${NEWS_TOPICS_PATH} has no topics.`);
  return topics;
}

/** Search Grok-curated news stories for a topic. */
export async function fetchNews(query: string, opts: NewsOptions = {}): Promise<Item[]> {
  const json = await apiGet<{ data?: NewsStoryRaw[] }>("/news/search", {
    query,
    max_results: String(Math.min(100, Math.max(1, opts.maxResults ?? 10))),
    max_age_hours: String(Math.min(720, Math.max(1, opts.maxAgeHours ?? 168))),
    "news.fields": NEWS_FIELDS,
  });
  return parseNewsSearch(json);
}

/** Look up specific posts by id, ranked by engagement (reuses parsePosts). */
export async function fetchPostsByIds(ids: string[]): Promise<Post[]> {
  if (!ids.length) return [];
  const json = await apiGet<SearchResponse>("/tweets", {
    ids: ids.slice(0, 100).join(","),
    "tweet.fields": "public_metrics,created_at,author_id",
    expansions: "author_id",
    "user.fields": "username,name",
  });
  return parsePosts(json, ids.length);
}

/** A single news story; optionally enriched with the posts driving it. */
export async function fetchNewsStory(
  id: string,
  opts: { withPosts?: boolean } = {},
): Promise<Item> {
  const json = await apiGet<{ data?: NewsStoryRaw }>(`/news/${id}`, {
    "news.fields": NEWS_FIELDS,
  });
  const raw = json.data;
  if (!raw) throw new Error(`no news story found for id ${id}`);

  let comments: Comment[] = [];
  if (opts.withPosts !== false) {
    const postIds = (raw.cluster_posts_results ?? []).map((p) => p.post_id);
    // Related posts are best-effort — a lookup failure shouldn't drop the story.
    comments = await fetchPostsByIds(postIds)
      .then((posts) => posts.map(postToComment))
      .catch(() => []);
  }
  return parseNewsStory(raw, comments);
}
