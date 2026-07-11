/**
 * Hacker News source, backed by the Algolia HN Search API (free, no auth).
 *
 * - Front page listing: https://hn.algolia.com/api/v1/search?tags=front_page
 * - Single item + nested comments: https://hn.algolia.com/api/v1/items/:id
 *
 * Pure normalization (`normalizeHit`, `flattenComments`) is kept separate from
 * the network calls so it can be unit-tested against fixtures with no I/O.
 */

import type { Comment, Item } from "../types.ts";
import { htmlToText } from "../util/html.ts";

const API = "https://hn.algolia.com/api/v1";

// ---- Algolia response shapes (only the fields we use) ----

interface SearchHit {
  objectID: string;
  title: string | null;
  url: string | null;
  author: string | null;
  points: number | null;
  num_comments: number | null;
  created_at_i: number | null;
  story_text?: string | null;
}

interface SearchResponse {
  hits: SearchHit[];
}

interface ItemNode {
  id: number;
  type?: string;
  title: string | null;
  url: string | null;
  text: string | null;
  author: string | null;
  points: number | null;
  created_at_i: number | null;
  children: ItemNode[];
}

export const HN_ITEM_URL = (id: string | number) =>
  `https://news.ycombinator.com/item?id=${id}`;

// ---- Pure normalization ----

/** A front-page hit → shallow Item (no comments yet). */
export function normalizeHit(hit: SearchHit): Item {
  return {
    id: hit.objectID,
    source: "hackernews",
    title: hit.title ?? "(untitled)",
    author: hit.author ?? "",
    timestamp: hit.created_at_i ?? 0,
    body: htmlToText(hit.story_text),
    comments: [],
    metadata: {
      url: hit.url ?? undefined,
      permalink: HN_ITEM_URL(hit.objectID),
      points: hit.points ?? undefined,
      numComments: hit.num_comments ?? undefined,
    },
  };
}

/**
 * Depth-first flatten of the nested comment tree into a linear list, preserving
 * depth. Deleted/empty nodes are skipped but their children are still walked.
 * Stops once `limit` real comments have been collected.
 */
export function flattenComments(
  children: ItemNode[],
  limit = Infinity,
  depth = 0,
  out: Comment[] = [],
): Comment[] {
  for (const node of children) {
    if (out.length >= limit) break;
    const text = htmlToText(node.text);
    if (text && node.author) {
      out.push({
        id: String(node.id),
        author: node.author,
        timestamp: node.created_at_i ?? 0,
        text,
        depth,
      });
    }
    if (node.children?.length) {
      flattenComments(node.children, limit, depth + 1, out);
    }
  }
  return out;
}

/** A full item node (from /items/:id) → Item with comments filled in. */
export function normalizeItem(node: ItemNode, commentLimit = Infinity): Item {
  return {
    id: String(node.id),
    source: "hackernews",
    title: node.title ?? "(untitled)",
    author: node.author ?? "",
    timestamp: node.created_at_i ?? 0,
    body: htmlToText(node.text),
    comments: flattenComments(node.children ?? [], commentLimit),
    metadata: {
      url: node.url ?? undefined,
      permalink: HN_ITEM_URL(node.id),
      points: node.points ?? undefined,
    },
  };
}

// ---- Network ----

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HN API ${res.status} ${res.statusText} for ${url}`);
  }
  return (await res.json()) as T;
}

/** Fetch a single story with its comment tree filled in. */
export async function fetchStory(id: string, commentLimit = Infinity): Promise<Item> {
  const node = await getJson<ItemNode>(`${API}/items/${id}`);
  return normalizeItem(node, commentLimit);
}

/**
 * Fetch the current front page and hydrate the top `limit` stories with up to
 * `commentLimit` comments each.
 */
export async function fetchTopStories(
  limit = 10,
  commentLimit = 15,
): Promise<Item[]> {
  const search = await getJson<SearchResponse>(
    `${API}/search?tags=front_page&hitsPerPage=${limit}`,
  );
  const shallow = search.hits.map(normalizeHit);
  return Promise.all(
    shallow.map(async (hit) => {
      const item = await fetchStory(hit.id, commentLimit);
      // The listing hit is authoritative for the total comment count and
      // points, which the item tree doesn't carry.
      item.metadata.numComments = hit.metadata.numComments;
      item.metadata.points ??= hit.metadata.points;
      return item;
    }),
  );
}
