import { describe, expect, it } from "vitest";
import { OfflineStore, safeRelPath, compileGlob, hiddenProjectEntry } from "../src/offline.js";
import { fixtureDir, UUID_A, UUID_B, RUN_OK, RUN_FAIL } from "./helpers.js";

describe("OfflineStore", () => {
  // Created lazily: the shared fixture is built in beforeAll.
  const store = (): OfflineStore => new OfflineStore(fixtureDir);

  it("lists projects with names from sqlite, newest first", async () => {
    const projects = await store().listProjects();
    expect(projects.map((p) => p.name)).toEqual(["alpha-site", "beta-deck"]);
    expect(projects[0]!.id).toBe(UUID_A);
    expect(projects[0]!.entryFile).toBe("index.html");
  });

  it("lists files while hiding dot-entries and artifact manifests", async () => {
    const files = await store().listFiles(UUID_A);
    expect(files.map((f) => f.name).sort()).toEqual(["index.html", "style.css"]);
  });

  it("reads text files and returns null for misses", async () => {
    const read = await store().readTextFile(UUID_A, "index.html");
    expect(read?.text).toContain("Fixture Hero");
    expect(await store().readTextFile(UUID_A, "missing.html")).toBe(null);
  });

  it("searches textual files case-insensitively with capped matches", async () => {
    const matches = await store().search(UUID_A, "fixture hero", null, 10);
    expect(matches.length).toBe(1);
    expect(matches[0]!.file).toBe("index.html");
    const capped = await store().search(UUID_A, "e", null, 1);
    expect(capped.length).toBe(1);
  });

  it("search honors glob filters", async () => {
    const matches = await store().search(UUID_A, "color", "*.css", 10);
    expect(matches.length).toBe(1);
    expect(matches[0]!.file).toBe("style.css");
  });

  it("reads run state and filters by project", async () => {
    const all = await store().listRuns(null);
    expect(all.length).toBe(2);
    const forA = await store().listRuns(UUID_A);
    expect(forA.map((r) => r.id)).toEqual([RUN_OK]);
    const failed = await store().getRun(RUN_FAIL);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("agent exited 1");
  });

  it("parses artifact manifests for entry discovery", async () => {
    const manifests = await store().artifactManifests(UUID_A);
    expect(manifests.length).toBe(1);
    expect(manifests[0]!.entry).toBe("index.html");
    expect(manifests[0]!.status).toBe("complete");
  });

  it("tolerates a data dir without projects", async () => {
    const empty = new OfflineStore("/nonexistent-odaxi");
    expect(await empty.listProjects()).toEqual([]);
    expect(await empty.listRuns(null)).toEqual([]);
  });
});

describe("path safety", () => {
  it("safeRelPath rejects traversal, absolute, and null bytes", () => {
    expect(safeRelPath("a/b.html")).toBe("a/b.html");
    expect(safeRelPath("../escape.html")).toBe(null);
    expect(safeRelPath("/etc/passwd")).toBe(null);
    expect(safeRelPath("a/../../x")).toBe(null);
    expect(safeRelPath("")).toBe(null);
  });

  it("hiddenProjectEntry hides dot paths and manifest sidecars", () => {
    expect(hiddenProjectEntry(".od-skills/x")).toBe(true);
    expect(hiddenProjectEntry("a/.file-versions/b")).toBe(true);
    expect(hiddenProjectEntry("index.html.artifact.json")).toBe(true);
    expect(hiddenProjectEntry("index.html")).toBe(false);
  });

  it("compileGlob matches star patterns case-insensitively", () => {
    const pattern = compileGlob("*.HTML");
    expect(pattern.test("index.html")).toBe(true);
    expect(pattern.test("a/index.html")).toBe(false);
    const deep = compileGlob("**/*");
    expect(deep.test("a/b/c.html")).toBe(true);
  });
});
