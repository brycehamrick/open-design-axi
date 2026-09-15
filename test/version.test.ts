import { describe, expect, it } from "vitest";
import { tryFastPath } from "axi-sdk-js/fast-path";
import { VERSION } from "../src/version.js";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

describe("version fast path", () => {
  it("handles bare -v, -V, and --version, nothing else", () => {
    for (const flag of ["-v", "-V", "--version"]) {
      const writes: string[] = [];
      expect(tryFastPath([flag], { version: VERSION, stdout: { write: (c) => writes.push(c) } })).toBe(true);
      expect(writes.join("")).toBe(`${VERSION}\n`);
    }
    expect(tryFastPath(["projects"], { version: VERSION, stdout: { write: () => undefined } })).toBe(false);
    expect(tryFastPath(["--version", "--json"], { version: VERSION, stdout: { write: () => undefined } })).toBe(false);
  });

  it("the built bin answers --version quickly without importing the graph", () => {
    const bin = fileURLToPath(new URL("../bin/open-design-axi.js", import.meta.url));
    const started = process.hrtime.bigint();
    const out = execFileSync(process.execPath, [bin, "--version"], { encoding: "utf8" }).trim();
    const elapsedMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
    expect(out).toBe(VERSION);
    // generous CI ceiling: the guard is that the fast path exists, and the
    // parity test above covers semantics; 1500ms covers cold CI filesystems
    expect(elapsedMs).toBeLessThan(1500);
  });

  it("VERSION matches package.json so releases can't drift from --version", async () => {
    const { readFile } = await import("node:fs/promises");
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });
});
