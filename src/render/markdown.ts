/**
 * Render normalized Items to markdown that reads well for both a human and a
 * coding agent (which does the actual summarizing / sentiment reading).
 */

import type { Comment, Item } from "../types.ts";

function timeAgo(unixSec: number): string {
  if (!unixSec) return "";
  const secs = Math.floor(Date.now() / 1000) - unixSec;
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "just now";
}

/** 1234 -> "1.2K", 3400000 -> "3.4M". */
function abbrev(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** seconds -> "3:45" or "1:02:03". */
function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** milliseconds -> "[3:45]" timestamp label. */
function timestamp(ms: number): string {
  return `[${formatDuration(ms / 1000)}]`;
}

/** Source-agnostic meta line: only shows fields the item actually has. */
function metaLine(item: Item): string {
  const md = item.metadata;
  const parts: string[] = [];
  if (md.points !== undefined) parts.push(`${md.points} pts`);
  if (md.views !== undefined) parts.push(`${abbrev(md.views)} views`);
  if (md.durationSec !== undefined) parts.push(formatDuration(md.durationSec));
  if (md.tweetCount !== undefined) parts.push(`${abbrev(md.tweetCount)} posts`);
  if (md.category) parts.push(md.category);
  if (md.topics?.length) parts.push(md.topics.slice(0, 4).join(", "));
  // Comment count is only meaningful where comments are actual comments (HN).
  const nc = md.numComments ?? item.comments.length;
  if (nc > 0 && item.source !== "x") parts.push(`${nc} comments`);
  if (item.author) parts.push(`by ${item.author}`);
  if (md.feedTitle && md.feedTitle !== item.author) parts.push(`via ${md.feedTitle}`);
  const t = timeAgo(item.timestamp);
  if (t) parts.push(t);
  return parts.join(" · ");
}

/** Indent multi-line comment/post text under its bullet, according to depth. */
function renderComment(c: Comment): string {
  const pad = "  ".repeat(c.depth);
  const body = c.text
    .split("\n")
    .map((line) => (line ? `${pad}  ${line}` : ""))
    .join("\n");
  let heading = `${pad}- **${c.author}:**`;
  if (c.metrics) {
    const m = c.metrics;
    const bits: string[] = [];
    if (m.likes !== undefined) bits.push(`♥ ${abbrev(m.likes)}`);
    if (m.reposts !== undefined) bits.push(`↻ ${abbrev(m.reposts)}`);
    if (bits.length) heading += ` _(${bits.join(" · ")})_`;
  }
  return `${heading}\n${body}`;
}

function renderBody(item: Item, timestamps: boolean): string {
  const segments = item.metadata.transcript;
  if (timestamps && segments?.length) {
    return segments.map((s) => `${timestamp(s.offsetMs)} ${s.text}`).join("\n");
  }
  return item.body;
}

function renderItem(item: Item, opts: { commentLimit: number; timestamps: boolean }): string {
  const lines: string[] = [];
  lines.push(`## ${item.title}`);
  lines.push("");
  lines.push(`_${metaLine(item)}_`);
  if (item.metadata.url) lines.push(`Link: ${item.metadata.url}`);
  if (item.metadata.permalink) lines.push(`Discussion: ${item.metadata.permalink}`);
  lines.push("");

  const body = renderBody(item, opts.timestamps);
  if (body) {
    lines.push(body);
    lines.push("");
  }

  const comments = item.comments.slice(0, opts.commentLimit);
  if (comments.length) {
    const label = item.source === "x" ? "Top posts" : "Comments";
    lines.push(`### ${label} (${comments.length})`);
    lines.push("");
    for (const c of comments) {
      lines.push(renderComment(c));
    }
    lines.push("");
  }

  return lines.join("\n");
}

const HINT_WITH_COMMENTS = `---

> For the agent: give me a **3-line gist**, the **key points**, and the overall
> **sentiment** of the comments for each item above.`;

const HINT_NO_COMMENTS = `---

> For the agent: give me a **3-line gist** and the **key points** of the content above.`;

export interface RenderOptions {
  /** Max comments to render per item. */
  commentLimit?: number;
  /** Append the summarization hint block for the consuming agent. */
  hint?: boolean;
  /** Render the transcript with [mm:ss] offsets (YouTube). */
  timestamps?: boolean;
  /** Optional H1 title for the whole document. */
  heading?: string;
}

export function renderMarkdown(items: Item[], opts: RenderOptions = {}): string {
  const commentLimit = opts.commentLimit ?? Infinity;
  const timestamps = opts.timestamps ?? false;
  const blocks: string[] = [];
  if (opts.heading) blocks.push(`# ${opts.heading}\n`);
  for (const item of items) {
    blocks.push(renderItem(item, { commentLimit, timestamps }));
  }
  if (opts.hint !== false) {
    const hasComments = items.some((i) => i.comments.length > 0);
    blocks.push(hasComments ? HINT_WITH_COMMENTS : HINT_NO_COMMENTS);
  }
  return blocks.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

const DIGEST_HINT = `---

> For the agent: for each section above, give me a **3-line gist** and the **key
> points**; where there are comments or posts, add the overall **sentiment**.`;

/** Render several source sections into one document (each source an H1). */
export function renderDigest(
  sections: { label: string; items: Item[] }[],
  opts: { hint?: boolean } = {},
): string {
  const blocks = sections
    .filter((s) => s.items.length)
    .map((s) => renderMarkdown(s.items, { heading: s.label, hint: false }));
  if (opts.hint !== false && blocks.length) blocks.push(DIGEST_HINT);
  return blocks.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
