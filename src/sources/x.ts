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

/** Parse a search response, resolve authors, and sort by engagement desc. */
export function parsePosts(json: SearchResponse, count: number): Post[] {
  const users = new Map((json.includes?.users ?? []).map((u) => [u.id, u]));
  const posts: Post[] = (json.data ?? []).map((t) => {
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
