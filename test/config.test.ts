import { describe, expect, it, vi } from "vitest";
import { resolveEndpoint, DEFAULT_DAEMON_URL } from "../src/config.js";
import { jsonResponse, BASE, fixtureDir, UUID_A } from "./helpers.js";

describe("resolveEndpoint", () => {
  it("goes online when the daemon status verifies", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true, version: "9.9.9", port: 65530 }));
    const endpoint = await resolveEndpoint({
      daemonUrlFlag: BASE,
      fetchImpl: fetchMock as unknown as typeof fetch,
      scanSockets: async () => [],
    });
    expect(endpoint.mode).toBe("online");
    expect(endpoint.baseUrl).toBe(BASE);
    expect(endpoint.discoveredVia).toBe("flag");
    expect(endpoint.daemon?.version).toBe("9.9.9");
  });

  it("marks offline when nothing answers", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const endpoint = await resolveEndpoint({
      fetchImpl: fetchMock as unknown as typeof fetch,
      scanSockets: async () => [],
      env: {},
    });
    expect(endpoint.mode).toBe("offline");
    expect(endpoint.baseUrl).toBe(null);
    expect(endpoint.explicit).toBe(false);
  });

  it("keeps the explicit URL visible when it is down", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("down");
    });
    const endpoint = await resolveEndpoint({
      daemonUrlFlag: "http://127.0.0.1:9",
      fetchImpl: fetchMock as unknown as typeof fetch,
      scanSockets: async () => [],
    });
    expect(endpoint.mode).toBe("offline");
    expect(endpoint.baseUrl).toBe("http://127.0.0.1:9");
    expect(endpoint.explicit).toBe(true);
  });

  it("respects OD_DAEMON_URL from the environment", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:7777")) {
        return jsonResponse(200, { ok: true, version: "1.0.0", port: 7777 });
      }
      throw new Error("no");
    });
    const endpoint = await resolveEndpoint({
      env: { OD_DAEMON_URL: "http://127.0.0.1:7777" },
      fetchImpl: fetchMock as unknown as typeof fetch,
      scanSockets: async () => [],
    });
    expect(endpoint.mode).toBe("online");
    expect(endpoint.discoveredVia).toBe("env");
  });

  it("falls back to the default URL last", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (String(input).startsWith(DEFAULT_DAEMON_URL)) {
        return jsonResponse(200, { ok: true, version: "1.0.0", port: 7456 });
      }
      throw new Error("no");
    });
    const endpoint = await resolveEndpoint({
      fetchImpl: fetchMock as unknown as typeof fetch,
      scanSockets: async () => [],
      env: {},
    });
    expect(endpoint.mode).toBe("online");
    expect(endpoint.discoveredVia).toBe("default");
    expect(calls.some((call) => call.startsWith(DEFAULT_DAEMON_URL))).toBe(true);
  });

  it("resolves the data dir from the flag for offline reads", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("down");
    });
    const endpoint = await resolveEndpoint({
      daemonUrlFlag: "http://127.0.0.1:9",
      dataDirFlag: fixtureDir,
      fetchImpl: fetchMock as unknown as typeof fetch,
      scanSockets: async () => [],
    });
    expect(endpoint.dataDir).toBe(fixtureDir);
    expect(endpoint.dataDirVia).toBe("flag");
    expect(UUID_A).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("prefers the socket whose URL matches the daemon's own port over a proxy", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:60001")) {
        return jsonResponse(200, { ok: true, version: "1", port: 60001 });
      }
      if (url.startsWith("http://127.0.0.1:60002")) {
        // proxy forwards the daemon's status: port names the daemon, not itself
        return jsonResponse(200, { ok: true, version: "1", port: 60001 });
      }
      throw new Error("no");
    });
    const endpoint = await resolveEndpoint({
      fetchImpl: fetchMock as unknown as typeof fetch,
      scanSockets: async () => [
        { socketPath: "/tmp/a.sock", status: { url: "http://127.0.0.1:60002" } },
        { socketPath: "/tmp/b.sock", status: { url: "http://127.0.0.1:60001" } },
      ],
      env: {},
    });
    expect(endpoint.baseUrl).toBe("http://127.0.0.1:60001");
    expect(endpoint.discoveredVia).toBe("sidecar-scan");
  });
});
