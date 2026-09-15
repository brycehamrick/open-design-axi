import { describe, expect, it } from "vitest";
import { matchProject, displayRefFor } from "../src/project.js";
import { UUID_A, UUID_B } from "./helpers.js";

const candidates = [
  { id: UUID_A, name: "alpha-site" },
  { id: UUID_B, name: "beta-deck" },
  { id: "33333333-3333-4333-8333-333333333333", name: "alpha-site-v2" },
];

describe("matchProject", () => {
  it("matches the exact id first", () => {
    expect(matchProject(candidates, UUID_A)).toMatchObject({ id: UUID_A, via: "id" });
  });

  it("matches an exact name", () => {
    expect(matchProject(candidates, "beta-deck")).toMatchObject({ id: UUID_B, via: "name" });
  });

  it("matches a unique id prefix", () => {
    expect(matchProject(candidates, UUID_B.slice(0, 8))).toMatchObject({ id: UUID_B, via: "id-prefix" });
  });

  it("matches a unique name substring", () => {
    expect(matchProject(candidates, "beta")).toMatchObject({ id: UUID_B, via: "name-substring" });
  });

  it("reports ambiguity instead of guessing", () => {
    const result = matchProject(candidates, "alpha");
    expect("ambiguous" in result).toBe(true);
    if ("ambiguous" in result) expect(result.ambiguous.length).toBe(2);
  });

  it("reports an empty candidate set for no match", () => {
    const result = matchProject(candidates, "zzz-nothing");
    expect("ambiguous" in result).toBe(true);
    if ("ambiguous" in result) expect(result.ambiguous).toEqual([]);
  });

  describe("slug ids (non-uuid)", () => {
    const SLUG_A = "aurora-site-prod-ab12";
    const SLUG_B = "aurora-site-preview-cd34";
    const slugCandidates = [
      { id: SLUG_A, name: "Aurora Site Prod" },
      { id: SLUG_B, name: "Aurora Site Preview" },
    ];

    it("prefix-matches a unique slug id the way list views print it", () => {
      expect(matchProject(slugCandidates, "aurora-site-pre")).toMatchObject({ id: SLUG_B, via: "id-prefix" });
    });

    it("reports the matching candidates when a slug prefix is ambiguous", () => {
      const result = matchProject(slugCandidates, "aurora-site");
      expect("ambiguous" in result).toBe(true);
      if ("ambiguous" in result) expect(result.ambiguous.map((c) => c.id)).toEqual([SLUG_A, SLUG_B]);
    });

    it("still prefers an exact name over a prefix hit", () => {
      expect(matchProject(slugCandidates, "Aurora Site Preview")).toMatchObject({
        id: SLUG_B,
        via: "name",
      });
    });
  });
});

describe("displayRefFor", () => {
  const collidingSlugs = [
    { id: "aurora-labs-site-ab12", name: "Aurora Labs Site" },
    { id: "aurora-labs-deck-cd34", name: "Aurora Labs Deck" },
  ];

  it("prints the 8-char prefix when it is unique across the catalog", () => {
    expect(displayRefFor(UUID_A, [{ id: UUID_A, name: "a" }, { id: UUID_B, name: "b" }])).toBe("11111111");
  });

  it("prints the full id when the 8-char prefix is shared", () => {
    expect(displayRefFor("aurora-labs-site-ab12", collidingSlugs)).toBe("aurora-labs-site-ab12");
    expect(displayRefFor("aurora-labs-deck-cd34", collidingSlugs)).toBe("aurora-labs-deck-cd34");
  });

  it("prints ids that list views already show in full as-is", () => {
    expect(displayRefFor("aurora-l", collidingSlugs)).toBe("aurora-l");
  });

  it("without a catalog, uuid prefixes are trusted and slug ids print in full", () => {
    expect(displayRefFor(UUID_A, null)).toBe("11111111");
    expect(displayRefFor("aurora-labs-site-ab12", null)).toBe("aurora-labs-site-ab12");
  });
});
