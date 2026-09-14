import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sidecarStatus, sidecarSocketDir } from "../src/sidecar.js";

describe("sidecar IPC discovery", () => {
  let dir: string;
  let server: Server;

  beforeAll(async () => {
    dir = join(tmpdir(), `od-sidecar-test-${process.pid}`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    // A minimal stand-in for the daemon's JSON IPC sidecar: one frame per
    // connection, {ok,result} reply.
    server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        buffer = buffer.slice(newline + 1);
        socket.end(`${JSON.stringify({
          ok: true,
          result: { state: "running", url: "http://127.0.0.1:60001", pid: 11 },
        })}\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(join(dir, "probe.sock"), resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  it("speaks the newline-delimited JSON status protocol", async () => {
    const status = await sidecarStatus(join(dir, "probe.sock"));
    expect(status).toEqual({ state: "running", url: "http://127.0.0.1:60001", pid: 11 });
  });

  it("returns null for unreachable sockets instead of throwing", async () => {
    expect(await sidecarStatus(join(dir, "missing.sock"), 200)).toBe(null);
  });

  it("enumerates socket files and keeps the ones that answer", async () => {
    const entries = readdirSync(dir).filter((entry) => entry.endsWith(".sock"));
    expect(entries).toEqual(["probe.sock"]);
    const statuses = await Promise.all(entries.map((entry) => sidecarStatus(join(dir, entry), 300)));
    expect(statuses.filter((status) => status != null)).toHaveLength(1);
  });

  it("derives the platform socket directory under tmpdir", () => {
    const dirName = sidecarSocketDir("darwin");
    expect(dirName).toMatch(/od-sidecar-\d+$/);
    expect(sidecarSocketDir("win32")).toBe(null);
  });
});
