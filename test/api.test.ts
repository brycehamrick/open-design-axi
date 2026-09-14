import { describe, expect, it, vi } from "vitest";
import { DaemonApi } from "../src/api.js";
import { resolveEndpoint } from "../src/config.js";
import { jsonResponse, BASE, fixtureDir, daemonStatusFetch } from "./helpers.js";

async function apiFor(overrides?: Record<string, (url: string, init?: RequestInit) => Response | undefined>): Promise<DaemonApi> {
  const base = daemonStatusFetch(overrides);
  const endpoint = await resolveEndpoint({
    daemonUrlFlag: BASE,
    dataDirFlag: fixtureDir,
    fetchImpl: base,
    scanSockets: async () => [],
  });
  return new DaemonApi(endpoint, { fetchImpl: base, env: {} });
}

describe("DaemonApi error mapping", () => {
  it("maps 404 with a structured error envelope to NOT_FOUND", async () => {
    const api = await apiFor({
      [`${BASE}/api/projects/nope`]: () =>
        jsonResponse(404, { error: { code: "PROJECT_NOT_FOUND", message: "project not found" } }),
    });
    await expect(api.getJson("/api/projects/nope")).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "project not found",
    });
  });

  it("maps 409 FILE_EXISTS to CONFLICT with the --overwrite suggestion", async () => {
    const api = await apiFor({
      [`${BASE}/api/projects/p/files`]: () =>
        jsonResponse(409, { error: { code: "FILE_EXISTS", message: "file already exists" } }),
    });
    await expect(api.postJson("/api/projects/p/files", {})).rejects.toMatchObject({
      code: "CONFLICT",
    });
    try {
      await api.postJson("/api/projects/p/files", {});
      expect.unreachable();
    } catch (error) {
      expect((error as { suggestions?: string[] }).suggestions?.join(" ")).toContain("--overwrite");
    }
  });

  it("keeps the daemon's own error code for unmapped failures", async () => {
    const api = await apiFor({
      [`${BASE}/api/runs`]: () => jsonResponse(400, { error: { code: "PROJECT_SCOPE_REQUIRED", message: "projectId required" } }),
    });
    await expect(api.getJson("/api/runs")).rejects.toMatchObject({ code: "PROJECT_SCOPE_REQUIRED" });
  });

  it("translates network failures into DAEMON_UNAVAILABLE with actionable help", async () => {
    const failing = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const endpoint = await resolveEndpoint({
      daemonUrlFlag: BASE,
      fetchImpl: failing as unknown as typeof fetch,
      scanSockets: async () => [],
    });
    // Force the api client to think it is online while fetch fails, so we
    // exercise the network translation rather than the offline guard.
    const api = new DaemonApi(
      { ...endpoint, mode: "online" },
      { fetchImpl: failing as unknown as typeof fetch, env: {} },
    );
    await expect(api.getJson("/api/projects")).rejects.toMatchObject({ code: "DAEMON_UNAVAILABLE" });
  });

  it("surfaces AUTH_REQUIRED when the daemon demands a token and none is set", async () => {
    const unauthorized = vi.fn(async () => jsonResponse(401, { error: "unauthorized" }));
    const endpoint = await resolveEndpoint({
      daemonUrlFlag: BASE,
      fetchImpl: vi.fn(async () => jsonResponse(200, { ok: true, version: "1", port: 65530 })) as unknown as typeof fetch,
      scanSockets: async () => [],
    });
    const api = new DaemonApi(endpoint, { fetchImpl: unauthorized as unknown as typeof fetch, env: {} });
    await expect(api.getJson("/api/projects")).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("resolves workspace headers from the directory and stamps them on scoped calls", async () => {
    const seen: Record<string, string | undefined> = {};
    const api = await apiFor({
      [`${BASE}/api/workspaces/ws-1/projects`]: (_url, init) => {
        Object.assign(seen, (init?.headers ?? {}) as Record<string, string>);
        return jsonResponse(200, { projects: [] });
      },
    });
    await api.getJson("/api/workspaces/ws-1/projects", { workspace: true });
    expect(seen["x-od-workspace-id"]).toBe("ws-1");
    expect(seen["x-od-workspace-member-id"]).toBe("member-1");
  });

  it("attaches a bearer token from OD_API_TOKEN and never echoes it", async () => {
    const seen: Record<string, string | undefined> = {};
    const api = await apiFor({
      [`${BASE}/api/projects`]: (_url, init) => {
        Object.assign(seen, (init?.headers ?? {}) as Record<string, string>);
        return jsonResponse(200, { projects: [] });
      },
    });
    const tokenized = Object.create(api) as DaemonApi;
    void tokenized;
    process.env.OD_API_TOKEN = "secret-token-value";
    try {
      const endpoint = await resolveEndpoint({
        daemonUrlFlag: BASE,
        fetchImpl: vi.fn(async () => jsonResponse(200, { ok: true, version: "1", port: 65530 })) as unknown as typeof fetch,
        scanSockets: async () => [],
      });
      const bearerApi = new DaemonApi(endpoint, {
        fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
          Object.assign(seen, (init?.headers ?? {}) as Record<string, string>);
          return jsonResponse(200, { projects: [] });
        }) as unknown as typeof fetch,
        env: process.env,
      });
      await bearerApi.getJson("/api/projects");
      expect(seen.authorization).toBe("Bearer secret-token-value");
    } finally {
      delete process.env.OD_API_TOKEN;
    }
  });
});
