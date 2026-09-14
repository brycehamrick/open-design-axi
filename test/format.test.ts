import { describe, expect, it } from "vitest";
import { shortId, truncate, selectRows, epochSeconds, kindForPath } from "../src/format.js";

describe("shortId", () => {
  it("shortens uuids to 8 chars and leaves short ids alone", () => {
    expect(shortId("1a2b3c4d-0000-4000-8000-1a2b3c4d5e6f")).toBe("1a2b3c4d");
    expect(shortId("abc")).toBe("abc");
    expect(shortId(null)).toBe(null);
  });
});

describe("truncate", () => {
  it("passes short text through untouched", () => {
    expect(truncate("hello", 10, "chars")).toEqual({ text: "hello", hint: null });
  });
  it("truncates with a total-size hint and --full escape mention", () => {
    const result = truncate("x".repeat(900), 400, "chars");
    expect(result.text.length).toBe(400);
    expect(result.hint).toContain("900 chars total");
    expect(result.hint).toContain("--full");
  });
  it("returns everything when escape is full", () => {
    expect(truncate("x".repeat(900), 400, "full").hint).toBe(null);
  });
});

describe("selectRows", () => {
  const items = [{ a: 1, b: "x", c: 3 }, { a: 2, b: "y", c: 4 }];
  const mapper = (item: { a: number; b: string; c: number }) => item;

  it("uses the minimal default schema", () => {
    const result = selectRows(items, ["a", "b"], {}, ["a", "b", "c"], mapper);
    expect(result.rows).toEqual([{ a: 1, b: "x" }, { a: 2, b: "y" }]);
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("--fields swaps the schema and unknown fields fail with the available list", () => {
    expect(selectRows(items, ["a"], { fields: "c" }, ["a", "b", "c"], mapper).rows).toEqual([{ c: 3 }, { c: 4 }]);
    try {
      selectRows(items, ["a"], { fields: "zzz" }, ["a", "b", "c"], mapper);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("unknown --fields: zzz");
      expect(((error as { suggestions?: string[] }).suggestions ?? []).join(" ")).toContain(
        "available fields: a, b, c",
      );
    }
  });

  it("--limit caps with truncated accounting; 0 means all", () => {
    const capped = selectRows(items, ["a"], { limit: 1 }, ["a"], mapper);
    expect(capped.shown).toBe(1);
    expect(capped.total).toBe(2);
    expect(capped.truncated).toBe(true);
    const all = selectRows(items, ["a"], { limit: 0 }, ["a"], mapper);
    expect(all.truncated).toBe(false);
    expect(all.shown).toBe(2);
  });
});

describe("timestamps and kinds", () => {
  it("converts epoch ms to seconds", () => {
    expect(epochSeconds(1789337733574)).toBe(1789337733);
    expect(epochSeconds(null)).toBe(null);
  });
  it("maps extensions to kinds", () => {
    expect(kindForPath("a/b.HTML")).toBe("html");
    expect(kindForPath("logo.png")).toBe("image");
    expect(kindForPath("notes")).toBe("text");
  });
});
