import { describe, expect, test } from "bun:test";

import { parseFeed } from "../src/sources/rss.ts";
import { renderMarkdown } from "../src/render/markdown.ts";

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Tech Blog</title>
    <item>
      <title>First Post</title>
      <link>https://example.com/first</link>
      <guid>https://example.com/first</guid>
      <pubDate>Sat, 11 Jul 2026 15:28:02 +0000</pubDate>
      <dc:creator>Alice</dc:creator>
      <content:encoded><![CDATA[<p>Full <a href="https://x.test">content</a> here.]]></content:encoded>
      <description>short summary</description>
    </item>
    <item>
      <title>Second Post</title>
      <link>https://example.com/second</link>
      <pubDate>Fri, 10 Jul 2026 10:00:00 +0000</pubDate>
      <description>&lt;p&gt;desc only&lt;/p&gt;</description>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Someone's Weblog</title>
  <author><name>Site Owner</name></author>
  <entry>
    <title>Atom Entry</title>
    <link href="https://example.com/atom-1" rel="alternate"/>
    <id>tag:example.com,2026:1</id>
    <published>2026-07-10T17:05:26+00:00</published>
    <summary>an atom summary</summary>
  </entry>
</feed>`;

const RSS_SINGLE = `<rss version="2.0"><channel><title>One</title>
  <item><title>Only</title><link>https://e.com/x</link><pubDate>Sat, 11 Jul 2026 00:00:00 +0000</pubDate></item>
</channel></rss>`;

describe("parseFeed - RSS", () => {
  const items = parseFeed(RSS);

  test("parses all items with source rss", () => {
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.source === "rss")).toBe(true);
  });

  test("prefers content:encoded, strips HTML, keeps link url", () => {
    const first = items[0]!;
    expect(first.title).toBe("First Post");
    expect(first.author).toBe("Alice");
    expect(first.body).toBe("Full content (https://x.test) here.");
    expect(first.metadata.url).toBe("https://example.com/first");
    expect(first.metadata.feedTitle).toBe("Tech Blog");
    expect(first.timestamp).toBe(Math.floor(Date.parse("Sat, 11 Jul 2026 15:28:02 +0000") / 1000));
  });

  test("falls back to description and feed title as author", () => {
    const second = items[1]!;
    expect(second.body).toBe("desc only");
    expect(second.author).toBe("Tech Blog"); // no dc:creator -> feed title
  });
});

describe("parseFeed - Atom", () => {
  const items = parseFeed(ATOM);

  test("resolves object link href, author, summary", () => {
    expect(items).toHaveLength(1);
    const e = items[0]!;
    expect(e.source).toBe("rss");
    expect(e.title).toBe("Atom Entry");
    expect(e.author).toBe("Site Owner");
    expect(e.metadata.url).toBe("https://example.com/atom-1");
    expect(e.body).toBe("an atom summary");
    expect(e.id).toBe("tag:example.com,2026:1");
  });
});

describe("parseFeed - single item (not an array)", () => {
  test("coerces a lone <item> into a one-element list", () => {
    const items = parseFeed(RSS_SINGLE);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("Only");
  });
});

describe("render", () => {
  test("shows 'via feedTitle' when it differs from author, no comments", () => {
    const items = parseFeed(RSS);
    const md = renderMarkdown(items, { hint: true });
    expect(md).toContain("## First Post");
    expect(md).toContain("by Alice · via Tech Blog");
    expect(md).not.toContain("comments");
    // no comments anywhere -> hint omits sentiment
    expect(md).toContain("3-line gist");
    expect(md).not.toContain("sentiment");
  });
});
