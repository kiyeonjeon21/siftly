import { describe, expect, test } from "bun:test";

import {
  normalizeTopicItem,
  normalizeTrendItem,
  parsePosts,
  parseTrends,
} from "../src/sources/x.ts";
import { renderMarkdown } from "../src/render/markdown.ts";

describe("parseTrends", () => {
  test("maps trend names + volume, respects limit", () => {
    const json = {
      data: [
        { trend_name: "#AI", tweet_count: 12000 },
        { trend_name: "Jayden Adams" },
        { trend_name: "#ThirdTrend" },
      ],
    };
    const trends = parseTrends(json, 2);
    expect(trends).toEqual([
      { name: "#AI", tweetCount: 12000 },
      { name: "Jayden Adams", tweetCount: undefined },
    ]);
  });
});

describe("parsePosts", () => {
  const json = {
    data: [
      {
        id: "1",
        text: "low engagement",
        author_id: "u1",
        created_at: "2026-07-11T15:40:00.000Z",
        public_metrics: { like_count: 2, retweet_count: 1, reply_count: 0 },
      },
      {
        id: "2",
        text: "high engagement",
        author_id: "u2",
        created_at: "2026-07-11T15:41:00.000Z",
        public_metrics: { like_count: 500, retweet_count: 100, reply_count: 9 },
      },
      {
        id: "3",
        text: "no author resolved",
        created_at: "2026-07-11T15:42:00.000Z",
        public_metrics: { like_count: 50, retweet_count: 0, reply_count: 0 },
      },
    ],
    includes: {
      users: [
        { id: "u1", username: "alice", name: "Alice" },
        { id: "u2", username: "bob" },
      ],
    },
  };

  test("resolves authors, sorts by engagement desc, trims to count", () => {
    const posts = parsePosts(json, 2);
    expect(posts.map((p) => p.id)).toEqual(["2", "3"]); // 600 > 50 > 3
    expect(posts[0]!.author).toBe("@bob"); // no name -> handle only
    expect(posts[0]!.likes).toBe(500);
    expect(posts[1]!.author).toBe("@unknown"); // unresolved author_id
  });

  test("author with name shows handle + name", () => {
    const posts = parsePosts(json, 3);
    const alice = posts.find((p) => p.id === "1")!;
    expect(alice.author).toBe("@alice (Alice)");
  });
});

describe("normalize + render", () => {
  const posts = parsePosts(
    {
      data: [
        {
          id: "2",
          text: "big news about AI",
          author_id: "u2",
          created_at: "2026-07-11T15:41:00.000Z",
          public_metrics: { like_count: 1500, retweet_count: 300, reply_count: 9 },
        },
      ],
      includes: { users: [{ id: "u2", username: "bob", name: "Bob" }] },
    },
    5,
  );

  test("normalizeTrendItem puts posts in comments[]", () => {
    const item = normalizeTrendItem({ name: "#AI", tweetCount: 12000 }, posts);
    expect(item.source).toBe("x");
    expect(item.id).toBe("x:ai");
    expect(item.title).toBe("#AI");
    expect(item.comments).toHaveLength(1);
    expect(item.comments[0]!.metrics).toEqual({ likes: 1500, reposts: 300, replies: 9 });
    expect(item.metadata.tweetCount).toBe(12000);
  });

  test("render shows 'Top posts', volume, and engagement", () => {
    const item = normalizeTrendItem({ name: "#AI", tweetCount: 12000 }, posts);
    const md = renderMarkdown([item], { hint: false });
    expect(md).toContain("## #AI");
    expect(md).toContain("12K posts");
    expect(md).toContain("### Top posts (1)");
    expect(md).toContain("**@bob (Bob):**");
    expect(md).toContain("♥ 1.5K");
    expect(md).toContain("↻ 300");
    expect(md).not.toContain("comments");
  });

  test("normalizeTopicItem titles the search", () => {
    const item = normalizeTopicItem("AI safety", posts);
    expect(item.id).toBe("x:query:ai-safety");
    expect(item.title).toBe("Search: AI safety");
  });
});
