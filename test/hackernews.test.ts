import { describe, expect, test } from "bun:test";

import {
  flattenComments,
  normalizeHit,
  normalizeItem,
} from "../src/sources/hackernews.ts";
import { renderMarkdown } from "../src/render/markdown.ts";
import { htmlToText } from "../src/util/html.ts";

// A trimmed Algolia /items/:id response.
const ITEM_FIXTURE = {
  id: 100,
  type: "story",
  title: "Show HN: siftly",
  url: "https://example.com/siftly",
  text: "<p>Body with an <a href=\"https://x.test\">link</a> &amp; entity.",
  author: "alice",
  points: 42,
  created_at_i: 1_700_000_000,
  children: [
    {
      id: 101,
      title: null,
      url: null,
      text: "<p>Great idea &#x27;nuff said",
      author: "bob",
      points: null,
      created_at_i: 1_700_000_100,
      children: [
        {
          id: 102,
          title: null,
          url: null,
          text: "agreed &gt; expectations",
          author: "carol",
          points: null,
          created_at_i: 1_700_000_200,
          children: [],
        },
      ],
    },
    {
      id: 103,
      title: null,
      url: null,
      text: null, // deleted node — skipped, but children still walked
      author: null,
      points: null,
      created_at_i: 1_700_000_300,
      children: [
        {
          id: 104,
          title: null,
          url: null,
          text: "reply under a deleted parent",
          author: "dave",
          points: null,
          created_at_i: 1_700_000_400,
          children: [],
        },
      ],
    },
  ],
};

describe("htmlToText", () => {
  test("decodes entities and keeps link urls", () => {
    expect(htmlToText('<p>hi <a href="https://x.test">y</a> &amp; z')).toBe(
      "hi y (https://x.test) & z",
    );
  });

  test("empty input is empty string", () => {
    expect(htmlToText(null)).toBe("");
    expect(htmlToText(undefined)).toBe("");
  });
});

describe("flattenComments", () => {
  test("depth-first, preserves depth, skips deleted but walks children", () => {
    const flat = flattenComments(ITEM_FIXTURE.children as never);
    expect(flat.map((c) => c.author)).toEqual(["bob", "carol", "dave"]);
    expect(flat.map((c) => c.depth)).toEqual([0, 1, 1]);
    expect(flat[1]?.text).toBe("agreed > expectations");
  });

  test("respects the limit", () => {
    const flat = flattenComments(ITEM_FIXTURE.children as never, 2);
    expect(flat).toHaveLength(2);
  });
});

describe("normalizeItem", () => {
  test("maps fields and normalizes body html", () => {
    const item = normalizeItem(ITEM_FIXTURE as never);
    expect(item.id).toBe("100");
    expect(item.source).toBe("hackernews");
    expect(item.title).toBe("Show HN: siftly");
    expect(item.author).toBe("alice");
    expect(item.body).toBe("Body with an link (https://x.test) & entity.");
    expect(item.metadata.points).toBe(42);
    expect(item.metadata.permalink).toBe(
      "https://news.ycombinator.com/item?id=100",
    );
    expect(item.comments).toHaveLength(3);
  });
});

describe("normalizeHit", () => {
  test("shallow item has no comments and carries metadata", () => {
    const item = normalizeHit({
      objectID: "200",
      title: "A link post",
      url: "https://link.test",
      author: "eve",
      points: 10,
      num_comments: 5,
      created_at_i: 1_700_000_000,
    } as never);
    expect(item.comments).toHaveLength(0);
    expect(item.metadata.url).toBe("https://link.test");
    expect(item.metadata.numComments).toBe(5);
  });
});

describe("renderMarkdown", () => {
  const item = normalizeItem(ITEM_FIXTURE as never);

  test("includes title, meta, body, comments", () => {
    const md = renderMarkdown([item], { hint: false });
    expect(md).toContain("## Show HN: siftly");
    expect(md).toContain("42 pts");
    expect(md).toContain("**bob:**");
    expect(md).toContain("Link: https://example.com/siftly");
  });

  test("hint toggles", () => {
    expect(renderMarkdown([item], { hint: true })).toContain("3-line gist");
    expect(renderMarkdown([item], { hint: false })).not.toContain("3-line gist");
  });

  test("commentLimit caps rendered comments", () => {
    const md = renderMarkdown([item], { hint: false, commentLimit: 1 });
    expect(md).toContain("### Comments (1)");
    expect(md).toContain("**bob:**");
    expect(md).not.toContain("**carol:**");
  });
});
