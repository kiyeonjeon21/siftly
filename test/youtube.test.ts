import { describe, expect, test } from "bun:test";

import { parseVideoId, watchUrl } from "../src/util/youtube-url.ts";
import {
  buildBody,
  normalizeVideo,
  parseChannelListing,
  parseJson3,
  pickLang,
  type YtMeta,
} from "../src/sources/youtube.ts";
import { renderMarkdown } from "../src/render/markdown.ts";

describe("parseVideoId", () => {
  const cases: [string, string | null][] = [
    ["https://www.youtube.com/watch?v=jNQXAC9IVRw", "jNQXAC9IVRw"],
    ["https://youtu.be/jNQXAC9IVRw", "jNQXAC9IVRw"],
    ["https://youtu.be/jNQXAC9IVRw?t=5", "jNQXAC9IVRw"],
    ["https://www.youtube.com/shorts/jNQXAC9IVRw", "jNQXAC9IVRw"],
    ["https://www.youtube.com/embed/jNQXAC9IVRw", "jNQXAC9IVRw"],
    ["https://m.youtube.com/watch?v=jNQXAC9IVRw&list=x", "jNQXAC9IVRw"],
    ["jNQXAC9IVRw", "jNQXAC9IVRw"],
    ["https://example.com/watch?v=jNQXAC9IVRw", null],
    ["not a url", null],
  ];
  for (const [input, expected] of cases) {
    test(`${input} -> ${expected}`, () => {
      expect(parseVideoId(input)).toBe(expected);
    });
  }

  test("watchUrl", () => {
    expect(watchUrl("abc12345678")).toBe("https://www.youtube.com/watch?v=abc12345678");
  });
});

describe("parseChannelListing", () => {
  test("parses id<TAB>title lines, tolerates blank lines and missing title", () => {
    expect(parseChannelListing("abc12345678\tFirst\nDEF45678901\tSecond video\n\nGHI78901234")).toEqual([
      { id: "abc12345678", title: "First" },
      { id: "DEF45678901", title: "Second video" },
      { id: "GHI78901234", title: "" },
    ]);
  });
});

describe("parseJson3", () => {
  const JSON3 = JSON.stringify({
    events: [
      { tStartMs: 1200, segs: [{ utf8: "All right, so here we are,\nin front of" }] },
      { tStartMs: 5000, segs: [{ utf8: "the " }, { utf8: "elephants" }] },
      { tStartMs: 6000, segs: [{ utf8: "  \n " }] }, // whitespace-only -> skipped
      { tStartMs: 7000 }, // no segs -> skipped
    ],
  });

  test("extracts non-empty segments with offsets, collapses whitespace", () => {
    const segs = parseJson3(JSON3);
    expect(segs).toEqual([
      { offsetMs: 1200, text: "All right, so here we are, in front of" },
      { offsetMs: 5000, text: "the elephants" },
    ]);
  });

  test("buildBody joins into flowing text", () => {
    expect(buildBody(parseJson3(JSON3))).toBe(
      "All right, so here we are, in front of the elephants",
    );
  });
});

describe("pickLang", () => {
  test("prefers manual English", () => {
    const meta = { subtitles: { de: {}, en: {} }, automatic_captions: { en: {} } } as unknown as YtMeta;
    expect(pickLang(meta)).toEqual({ lang: "en", auto: false });
  });

  test("falls back to auto when no manual", () => {
    const meta = { automatic_captions: { fr: {}, en: {}, "en-de": {} } } as unknown as YtMeta;
    expect(pickLang(meta)).toEqual({ lang: "en", auto: true });
  });

  test("avoids translated auto variants when English absent", () => {
    const meta = { language: "es", automatic_captions: { es: {}, "en-es": {} } } as unknown as YtMeta;
    expect(pickLang(meta)).toEqual({ lang: "es", auto: true });
  });

  test("null when no captions at all", () => {
    expect(pickLang({} as YtMeta)).toBeNull();
  });
});

describe("normalizeVideo + render", () => {
  const meta = {
    id: "jNQXAC9IVRw",
    title: "Me at the zoo",
    uploader: "jawed",
    view_count: 398991245,
    duration: 19,
    upload_date: "20050424",
    webpage_url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  } as YtMeta;
  const segs = [
    { offsetMs: 1200, text: "All right, so here we are" },
    { offsetMs: 65000, text: "really long trunks" },
  ];
  const item = normalizeVideo(meta, segs, { lang: "en", auto: false });

  test("maps metadata into Item", () => {
    expect(item.source).toBe("youtube");
    expect(item.author).toBe("jawed");
    expect(item.comments).toHaveLength(0);
    expect(item.metadata.views).toBe(398991245);
    expect(item.metadata.durationSec).toBe(19);
    expect(item.metadata.transcript).toHaveLength(2);
    expect(item.body).toBe("All right, so here we are really long trunks");
    // 2005-04-24 UTC
    expect(item.timestamp).toBe(Math.floor(Date.UTC(2005, 3, 24) / 1000));
  });

  test("meta line shows views/duration, not '0 comments'", () => {
    const md = renderMarkdown([item], { hint: false });
    expect(md).toContain("399M views");
    expect(md).toContain("0:19");
    expect(md).not.toContain("comments");
  });

  test("hint omits comment sentiment when there are no comments", () => {
    const md = renderMarkdown([item], { hint: true });
    expect(md).toContain("3-line gist");
    expect(md).not.toContain("sentiment");
  });

  test("--timestamps prefixes segments with [mm:ss]", () => {
    const md = renderMarkdown([item], { hint: false, timestamps: true });
    expect(md).toContain("[0:01] All right, so here we are");
    expect(md).toContain("[1:05] really long trunks");
  });

  test("default (no timestamps) renders flowing body", () => {
    const md = renderMarkdown([item], { hint: false });
    expect(md).toContain("All right, so here we are really long trunks");
    expect(md).not.toContain("[0:01]");
  });
});
