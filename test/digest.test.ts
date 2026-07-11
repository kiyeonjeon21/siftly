import { describe, expect, test } from "bun:test";

import { parseSources } from "../src/digest.ts";
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
  });

  test("dedupes", () => {
    expect(parseSources("hn,hackernews,hn")).toEqual(["hackernews"]);
  });

  test("throws on unknown source", () => {
    expect(() => parseSources("reddit")).toThrow(/unknown source/);
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
