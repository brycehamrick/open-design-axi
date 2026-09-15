import { describe, expect, it, vi, afterEach } from "vitest";
import { encode } from "@toon-format/toon";
import { projectsCommand } from "../src/commands/projects.js";
import { filesCommand } from "../src/commands/files.js";
import { readCommand } from "../src/commands/read.js";
import { searchCommand } from "../src/commands/search.js";
import { artifactCommand } from "../src/commands/artifact.js";
import { runsCommand } from "../src/commands/runs.js";
import { writeCommand, deleteFileCommand } from "../src/commands/write.js";
import { runCommand } from "../src/commands/run.js";
import { projectCommand } from "../src/commands/project.js";
import { BASE, UUID_A, UUID_B, fixtureDir, jsonResponse, daemonStatusFetch } from "./helpers.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const online = (): string[] => ["--daemon-url", BASE, "--data-dir", fixtureDir];
const offline = (): string[] => ["--daemon-url", "http://127.0.0.1:9", "--data-dir", fixtureDir];

function stubFetch(overrides: Record<string, (url: string, init?: RequestInit) => Response | undefined>): void {
  vi.stubGlobal("fetch", daemonStatusFetch(overrides));
}

afterEach(() => vi.unstubAllGlobals());

describe("projects", () => {
  it("lists with minimal schema, count aggregate, and next-step help", async () => {
    stubFetch({});
    const out = await projectsCommand(online());
    expect(out.count).toBe(1);
    expect(out.projects).toEqual([{ id: "11111111", name: "alpha-site", updated: 1700000100 }]);
    expect((out.help as string[]).join(" ")).toContain("project <id|name>");
  });

  it("emits a definitive zero state with creation help", async () => {
    stubFetch({
      [`${BASE}/api/projects`]: () => jsonResponse(200, { projects: [] }),
      [`${BASE}/api/workspaces/ws-1/projects`]: () => jsonResponse(200, { projects: [] }),
    });
    const out = await projectsCommand(online());
    expect(out.projects).toBe("0 projects found");
    expect((out.help as string[]).join(" ")).toContain("projects create");
  });

  it("lists offline from the data directory", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("down");
    });
    const out = await projectsCommand(offline());
    expect(out.count).toBe(2);
    expect(JSON.stringify(out.projects)).toContain("alpha-site");
    expect(JSON.stringify(out.projects)).toContain("beta-deck");
  });

  it("create is gated behind --confirm with a would-change preview", async () => {
    stubFetch({});
    await expect(projectsCommand(["create", "--name", "x", ...online()])).rejects.toMatchObject({
      code: "CONFIRM_REQUIRED",
    });
  });

  describe("ref resolution", () => {
    const slugProjects = {
      projects: [
        { id: "aurora-site-prod-ab12", name: "Aurora Site Prod" },
        { id: "aurora-site-preview-cd34", name: "Aurora Site Preview" },
      ],
    };

    it("resolves a copied 8-char slug-id prefix instead of NOT_FOUND", async () => {
      stubFetch({
        [`${BASE}/api/projects`]: () => jsonResponse(200, slugProjects),
        [`${BASE}/api/projects/aurora-site-prod-ab12$`]: () =>
          jsonResponse(200, { project: { metadata: { entryFile: "index.html" } } }),
        [`${BASE}/api/projects/aurora-site-prod-ab12/files`]: () => jsonResponse(200, { files: [] }),
      });
      const out = await projectCommand(["aurora-site-pro", ...online()]);
      expect(out.id).toBe("aurora-site-prod-ab12");
    });

    it("an ambiguous prefix lists the matching projects instead of a bare NOT_FOUND", async () => {
      stubFetch({ [`${BASE}/api/projects`]: () => jsonResponse(200, slugProjects) });
      await expect(projectCommand(["aurora-site", ...online()])).rejects.toThrow(
        /ambiguous across 2 projects: aurora-s Aurora Site Prod; aurora-s Aurora Site Preview/,
      );
      await expect(projectCommand(["aurora-site", ...online()])).rejects.toMatchObject({
        code: "AMBIGUOUS",
      });
    });

    it("help lines print a paste-safe ref when printed prefixes collide", async () => {
      const colliding = {
        projects: [
          { id: "aurora-labs-site-ab12", name: "Aurora Labs Site" },
          { id: "aurora-labs-deck-cd34", name: "Aurora Labs Deck" },
        ],
      };
      stubFetch({
        [`${BASE}/api/projects`]: () => jsonResponse(200, colliding),
        [`${BASE}/api/projects/aurora-labs-deck-cd34$`]: () =>
          jsonResponse(200, { project: { metadata: { entryFile: "DESIGN.md" } } }),
        [`${BASE}/api/projects/aurora-labs-deck-cd34/files`]: () =>
          jsonResponse(200, { files: [] }),
      });
      const out = await projectCommand(["Deck", ...online()]);
      expect(out.id).toBe("aurora-labs-deck-cd34");
      const help = (out.help as string[]).join(" ");
      expect(help).toContain("aurora-labs-deck-cd34");
      expect(help).not.toContain("read aurora-l ");
    });
  });
});

describe("files", () => {
  it("lists files with a byte aggregate and glob filter", async () => {
    stubFetch({
      [`${BASE}/api/projects/${UUID_A}/files`]: () =>
        jsonResponse(200, {
          files: [
            { name: "index.html", size: 100, kind: "html", mtime: 1700000000000 },
            { name: "style.css", size: 40, kind: "text", mtime: 1700000000000 },
          ],
        }),
    });
    const out = await filesCommand([UUID_A.slice(0, 8), ...online()]);
    expect(out.count).toBe(2);
    expect(out.bytes).toBe("140 B");
    expect(JSON.stringify(out.files)).toContain("index.html");
    const cssOnly = await filesCommand([UUID_A.slice(0, 8), "--glob", "*.css", ...online()]);
    expect(cssOnly.count).toBe(1); // the CLI filters the fetched rows by glob
  });

  it("offline listing hides dot entries and manifests", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("down");
    });
    const out = await filesCommand([UUID_A, ...offline()]);
    expect(out.count).toBe(2);
    expect(JSON.stringify(out.files)).not.toContain("artifact.json");
    expect(JSON.stringify(out.files)).not.toContain(".file-versions");
  });
});

describe("read", () => {
  it("windows content with a next-window hint", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line-${i + 1}`);
    stubFetch({
      [`${BASE}/api/projects/${UUID_A}/raw/index.html`]: () =>
        new Response(lines.join("\n"), { headers: { "content-type": "text/html" } }),
    });
    const out = await readCommand([UUID_A.slice(0, 8), "index.html", "--limit", "10", ...online()]);
    expect(out).toContain("lines: 1-10 of 30");
    expect(out).toContain("use --offset 10 for the next window");
    expect(out).toContain("line-1\n");
    expect(out).not.toContain("line-11\n");
  });

  it("--full disables the window", async () => {
    stubFetch({
      [`${BASE}/api/projects/${UUID_A}/raw/index.html`]: () =>
        new Response("one\ntwo", { headers: { "content-type": "text/html" } }),
    });
    const out = await readCommand([UUID_A.slice(0, 8), "index.html", "--full", ...online()]);
    expect(out).toContain("lines: 1-2 of 2");
    expect(out).not.toContain("next window");
  });

  it("rejects path traversal before any request", async () => {
    await expect(readCommand([UUID_A, "../etc/passwd", ...online()])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});

describe("search", () => {
  it("returns matches with count and context help online", async () => {
    stubFetch({
      [`${BASE}/api/projects/${UUID_A}/search`]: () =>
        jsonResponse(200, { matches: [{ file: "index.html", line: 3, snippet: "Fixture Hero" }] }),
    });
    const out = await searchCommand([UUID_A.slice(0, 8), "hero", ...online()]);
    expect(out.count).toBe(1);
    expect(JSON.stringify(out.matches)).toContain("index.html");
  });

  it("emits a definitive zero state", async () => {
    stubFetch({
      [`${BASE}/api/projects/${UUID_A}/search`]: () => jsonResponse(200, { matches: [] }),
    });
    const out = await searchCommand([UUID_A.slice(0, 8), "zzz", ...online()]);
    expect(out.matches).toContain("0 matches");
  });

  it("searches offline from disk", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("down");
    });
    const out = await searchCommand([UUID_A, "color", ...offline()]);
    expect(out.count).toBe(1);
  });
});

describe("artifact", () => {
  it("auto-bundles the entry plus referenced siblings", async () => {
    stubFetch({
      [`${BASE}/api/projects/${UUID_A}$`]: () =>
        jsonResponse(200, { project: { metadata: { entryFile: "index.html" } } }),
      [`${BASE}/api/projects/${UUID_A}/raw/index.html`]: () =>
        new Response('<link rel="stylesheet" href="style.css">', { headers: { "content-type": "text/html" } }),
      [`${BASE}/api/projects/${UUID_A}/raw/style.css`]: () =>
        new Response("h1{color:red}", { headers: { "content-type": "text/css" } }),
    });
    const out = await artifactCommand([UUID_A.slice(0, 8), ...online()]);
    expect(out).toContain("entry: index.html");
    expect(out).toContain("index.html,text/html,");
    expect(out).toContain("style.css,text/css,");
    expect(out).toContain("h1{color:red}");
  });

  it("offline bundling works from the fixture dir", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("down");
    });
    const out = await artifactCommand([UUID_A, ...offline()]);
    expect(out).toContain("entry: index.html");
    expect(out).toContain("style.css");
  });
});

describe("runs", () => {
  it("lists newest-first with status filter validation", async () => {
    stubFetch({
      [`${BASE}/api/runs?projectId=${UUID_A}`]: () =>
        jsonResponse(200, {
          runs: [{ id: "aaaabbbb-1111", status: "failed", agentId: "opencode", updatedAt: 2 }],
        }),
    });
    const out = await runsCommand([UUID_A.slice(0, 8), ...online()]);
    expect(out.count).toBe(1);
    expect(JSON.stringify(out.runs)).toContain("failed");
    await expect(runsCommand([UUID_A.slice(0, 8), "--status", "bogus", ...online()])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("offline run history comes from state.json files", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("down");
    });
    const out = await runsCommand([UUID_A, ...offline()]);
    expect(out.count).toBe(1);
    expect(JSON.stringify(out.runs)).toContain("succeeded");
  });
});

describe("mutation gates", () => {
  it("write requires content source, confirm, and a daemon", async () => {
    await expect(writeCommand([UUID_A, "x.html", ...online()])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    stubFetch({});
    const srcFile = join(fixtureDir, "..", "write-src.html");
    await writeFile(srcFile, "<p>x</p>");
    await expect(writeCommand([UUID_A, "x.html", "--file", srcFile, ...online()])).rejects.toMatchObject({
      code: "CONFIRM_REQUIRED",
    });
    vi.stubGlobal("fetch", async () => {
      throw new Error("down");
    });
    await expect(
      writeCommand([UUID_A, "x.html", "--stdin", "--confirm", ...offline()]),
    ).rejects.toMatchObject({ code: "DAEMON_UNAVAILABLE" });
  });

  it("write reports the daemon-sanitized name in output and follow-up help", async () => {
    stubFetch({
      [`${BASE}/api/projects/${UUID_A}/files`]: () =>
        jsonResponse(200, { file: { name: "sub/_x.html", size: 12 }, version: { version: 7 } }),
    });
    const srcFile = join(fixtureDir, "..", "write-src.html");
    await writeFile(srcFile, "<p>x</p>");
    const out = (await writeCommand([
      UUID_A,
      "sub/.x.html",
      "--file",
      srcFile,
      "--confirm",
      ...online(),
    ])) as Record<string, unknown>;
    expect(out.written).toBe("sub/_x.html");
    expect(out.requested).toBe("sub/.x.html");
    const help = (out.help as string[]).join(" ");
    expect(help).toContain("read 11111111 sub/_x.html");
    expect(help).toContain("raw/sub/_x.html");
    expect(help).not.toContain(".x.html");
    expect(help).toContain("leading-dot");
  });

  it("delete file gate", async () => {
    stubFetch({});
    await expect(deleteFileCommand([UUID_A, "x.html", ...online()])).rejects.toMatchObject({
      code: "CONFIRM_REQUIRED",
    });
  });

  it("run start requires --prompt then --confirm", async () => {
    stubFetch({});
    await expect(runCommand(["start", UUID_A, ...online()], undefined)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(
      runCommand(["start", UUID_A, "--prompt", "make a hero", ...online()], undefined),
    ).rejects.toMatchObject({ code: "CONFIRM_REQUIRED" });
  });

  it("run cancel on a terminal run is an idempotent no-op", async () => {
    stubFetch({
      [`${BASE}/api/runs/terminal-run`]: () =>
        jsonResponse(200, { id: "terminal-run", status: "succeeded", projectId: UUID_A }),
    });
    const out = (await runCommand(["cancel", "terminal-run", "--confirm", ...online()], undefined)) as Record<string, unknown>;
    expect(out.note).toContain("no-op");
  });

  it("rejects unknown run subcommands with the valid set", async () => {
    await expect(runCommand(["explode"], undefined)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("TOON rendering sanity", () => {
  it("list outputs stay compact (3-field rows, no verbose JSON)", async () => {
    stubFetch({});
    const out = await projectsCommand(online());
    const text = encode(out);
    expect(text).toContain("projects[1]{id,name,updated}:");
    const rowLine = text.split("\n").find((line) => line.startsWith("  ")) ?? "";
    expect(rowLine).not.toContain("{");
    expect(text).not.toContain(UUID_B);
  });
});
