import { describe, expect, it } from "vitest";
import { parseCommandArgs } from "../src/args.js";
import { AxiError } from "axi-sdk-js";

describe("parseCommandArgs", () => {
  it("parses positionals, string, boolean, and number flags", () => {
    const parsed = parseCommandArgs(
      ["alpha-site", "index.html", "--limit", "50", "--full"],
      { boolean: ["full"], number: ["limit"] },
      [{ name: "project" }, { name: "path", required: true }],
      "read",
    );
    expect(parsed.positionals).toEqual(["alpha-site", "index.html"]);
    expect(parsed.flags.limit).toBe(50);
    expect(parsed.flags.full).toBe(true);
  });

  it("rejects unknown flags by name with the valid flag list", () => {
    expect(() =>
      parseCommandArgs(["--bogus"], { boolean: ["confirm"] }, [], "projects create"),
    ).toThrowError(/unknown flag --bogus for `projects create`/);
    try {
      parseCommandArgs(["--bogus"], { boolean: ["confirm"], string: ["name"] }, [], "projects create");
      expect.unreachable();
    } catch (error) {
      const axi = error as AxiError;
      expect(axi.code).toBe("VALIDATION_ERROR");
      expect(axi.suggestions.join(" ")).toContain("--confirm");
      expect(axi.suggestions.join(" ")).toContain("--name");
      expect(axi.suggestions.join(" ")).toContain("--daemon-url");
      expect(axi.suggestions.join(" ")).toContain("--data-dir");
    }
  });

  it("rejects non-numeric values for number flags", () => {
    expect(() =>
      parseCommandArgs(["--limit", "abc"], { number: ["limit"] }, [], "projects"),
    ).toThrowError(/--limit must be a non-negative integer/);
  });

  it("rejects negative numbers for number flags", () => {
    expect(() =>
      parseCommandArgs(["--limit", "-1"], { number: ["limit"] }, [], "projects"),
    ).toThrowError();
  });

  it("requires required positionals and echoes the usage shape", () => {
    expect(() =>
      parseCommandArgs([], { boolean: ["confirm"] }, [{ name: "project", required: true }], "files"),
    ).toThrowError(/missing required argument/);
  });

  it("rejects extra positionals", () => {
    expect(() =>
      parseCommandArgs(["a", "b"], {}, [{ name: "project" }], "project"),
    ).toThrowError(/unexpected extra argument/);
  });

  it("rejects any positional when the command takes none", () => {
    expect(() => parseCommandArgs(["oops"], {}, [], "skills")).toThrowError(/unexpected argument: oops/);
  });
});
