import { describe, expect, test } from "bun:test";

import { dedupeAcrossSections, parseSources, type DigestSection } from "../src/digest.ts";
import { renderDigest } from "../src/render/markdown.ts";
import type { Item } from "../src/types.ts";

function item(source: Item["source"], title: string): Item {
  return {
    id: `${source}:${title}`,
    source,
    title,
    author: "",
    timestamp: 0,
    body: "body text",
    comments: [],
    metadata: {},
  };
}

describe("parseSources", () => {
  test("defaults to HN + RSS", () => {
    expect(parseSources()).toEqual(["hackernews", "rss"]);
    expect(parseSources("")).toEqual(["hackernews", "rss"]);
  });

  test("resolves aliases and preserves order", () => {
    expect(parseSources("x,hn")).toEqual(["x", "hackernews"]);
    expect(parseSources("twitter,rss")).toEqual(["x", "rss"]);
    expect(parseSources("hn,rss,news")).toEqual(["hackernews", "rss", "news"]);
  });

  test("dedupes", () => {
    expect(parseSources("hn,hackernews,hn")).toEqual(["hackernews"]);
  });

  test("throws on unknown source", () => {
    expect(() => parseSources("reddit")).toThrow(/unknown source/);
  });
});

describe("dedupeAcrossSections", () => {
  const withUrl = (source: Item["source"], title: string, url: string): Item => ({
    ...item(source, title),
    metadata: { url },
  });

  test("drops later items sharing a url (earliest wins), keeps url-less items", () => {
    const sections: DigestSection[] = [
      {
        source: "hackernews",
        label: "Hacker News",
        items: [withUrl("hackernews", "A", "http://x/a"), withUrl("hackernews", "B", "http://x/b")],
      },
      {
        source: "rss",
        label: "RSS",
        items: [
          withUrl("rss", "A-dup", "http://x/a"),
          withUrl("rss", "C", "http://x/c"),
          item("rss", "no-url"),
        ],
      },
    ];
    const out = dedupeAcrossSections(sections);
    expect(out[0]!.items.map((i) => i.title)).toEqual(["A", "B"]);
    expect(out[1]!.items.map((i) => i.title)).toEqual(["C", "no-url"]);
  });
});

describe("renderDigest", () => {
  const sections = [
    { label: "Hacker News", items: [item("hackernews", "HN One")] },
    { label: "RSS", items: [item("rss", "Feed One")] },
  ];

  test("renders each source as an H1 with its items", () => {
    const md = renderDigest(sections, { hint: true });
    expect(md).toContain("# Hacker News");
    expect(md).toContain("## HN One");
    expect(md).toContain("# RSS");
    expect(md).toContain("## Feed One");
  });

  test("appends a single digest hint", () => {
    const md = renderDigest(sections, { hint: true });
    expect(md).toContain("for each section above");
    // one hint total
    expect(md.match(/for each section above/g)).toHaveLength(1);
  });

  test("omits empty sections and, when all empty, the hint too", () => {
    const md = renderDigest(
      [
        { label: "Hacker News", items: [item("hackernews", "HN One")] },
        { label: "X — trending", items: [] },
      ],
      { hint: true },
    );
    expect(md).toContain("# Hacker News");
    expect(md).not.toContain("# X — trending");

    const empty = renderDigest([{ label: "RSS", items: [] }], { hint: true });
    expect(empty).not.toContain("for each section above");
  });
});
