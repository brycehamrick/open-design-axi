import { describe, expect, it } from "vitest";
import { matchProject } from "../src/project.js";
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
});
