import { describe, expect, test } from "bun:test";

import { parseConfig } from "../src/config.ts";

describe("parseConfig", () => {
  test("passes an object through", () => {
    const raw = { digest: { sources: ["hn", "rss", "news"], limit: 5 }, cache: { ttlSec: 600 } };
    expect(parseConfig(raw)).toEqual(raw);
  });

  test("non-objects fall back to empty config", () => {
    expect(parseConfig(null)).toEqual({});
    expect(parseConfig(undefined)).toEqual({});
    expect(parseConfig("nope")).toEqual({});
    expect(parseConfig(42)).toEqual({});
    expect(parseConfig([1, 2, 3])).toEqual({});
  });
});
