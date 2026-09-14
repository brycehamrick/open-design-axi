import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { DatabaseSync } from "node:sqlite";

/** Deterministic ids/names — no real user data ever enters fixtures. */
export const UUID_A = "11111111-1111-4111-8111-111111111111";
export const UUID_B = "22222222-2222-4222-8222-222222222222";
export const RUN_OK = "33333333-3333-4333-8333-333333333333";
export const RUN_FAIL = "44444444-4444-4444-8444-444444444444";

export let fixtureDir: string;

export async function buildFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "odaxi-test-"));
  const dataDir = join(root, "data");
  const projectA = join(dataDir, "projects", UUID_A);
  const projectB = join(dataDir, "projects", UUID_B);
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });
  await mkdir(join(projectA, ".file-versions", "abc"), { recursive: true });
  await mkdir(join(dataDir, "runs", RUN_OK), { recursive: true });
  await mkdir(join(dataDir, "runs", RUN_FAIL), { recursive: true });

  await writeFile(
    join(projectA, "index.html"),
    '<!doctype html>\n<html><head><link rel="stylesheet" href="style.css"></head>\n<body><h1 class="hero">Fixture Hero</h1></body></html>\n',
  );
  await writeFile(join(projectA, "style.css"), "h1 { color: #0f172a; }\n");
  await writeFile(
    join(projectA, "index.html.artifact.json"),
    JSON.stringify({
      version: 1,
      kind: "html",
      title: "index.html",
      entry: "index.html",
      renderer: "html",
      status: "complete",
      exports: ["html"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  await writeFile(join(projectA, ".file-versions", "abc", "old.html"), "<p>stale</p>");
  await writeFile(join(projectB, "deck.html"), "<p>deck body</p>");

  const db = new DatabaseSync(join(dataDir, "app.sqlite"));
  db.exec(
    "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, skill_id TEXT, design_system_id TEXT, pending_prompt TEXT, metadata_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, custom_instructions TEXT, applied_plugin_snapshot_id TEXT)",
  );
  const insert = db.prepare(
    "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
  );
  insert.run(UUID_A, "alpha-site", 1_700_000_000_000, 1_700_000_100_000);
  insert.run(UUID_B, "beta-deck", 1_700_000_000_000, 1_700_000_050_000);
  db.close();

  await writeFile(
    join(dataDir, "runs", RUN_OK, "state.json"),
    JSON.stringify({
      id: RUN_OK,
      status: "succeeded",
      projectId: UUID_A,
      agentId: "opencode",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_200_000,
      artifactPaths: ["index.html"],
    }),
  );
  await writeFile(
    join(dataDir, "runs", RUN_FAIL, "state.json"),
    JSON.stringify({
      id: RUN_FAIL,
      status: "failed",
      projectId: UUID_B,
      agentId: "amr",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_150_000,
      error: "agent exited 1",
    }),
  );
  return dataDir;
}

beforeAll(async () => {
  fixtureDir = await buildFixture();
});

afterAll(async () => {
  if (fixtureDir) await rm(join(fixtureDir, ".."), { recursive: true, force: true }).catch(() => undefined);
});

/** A fetch stub that models a daemon: online at BASE, everything else offline.
 *  Override keys are prefix matches; suffix `$` means exact match. */
export const BASE = "http://127.0.0.1:65530";

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function daemonStatusFetch(overrides: Record<string, (url: string, init?: RequestInit) => Response | undefined> = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.split("?")[0] ?? url;
    for (const [rawKey, handler] of Object.entries(overrides)) {
      const exact = rawKey.endsWith("$");
      const key = exact ? rawKey.slice(0, -1) : rawKey;
      const hit = exact ? path === key : url.startsWith(key);
      if (hit) {
        const resp = handler(url, init);
        if (resp) return resp;
      }
    }
    if (url === `${BASE}/api/daemon/status`) {
      return jsonResponse(200, { ok: true, version: "0.22.2", port: 65530, pid: 123 });
    }
    if (url === `${BASE}/api/active`) return jsonResponse(200, { active: false });
    if (url === `${BASE}/api/projects`) return jsonResponse(200, { projects: [] });
    if (url === `${BASE}/api/workspace/directory`) {
      return jsonResponse(200, {
        items: [
          {
            workspaceId: "ws-1",
            workspaceName: "fixture",
            workspaceType: "personal",
            workspaceMemberId: "member-1",
            role: "owner",
            memberStatus: "active",
            lifecycleState: "active",
          },
        ],
        activeWorkspaceId: null,
      });
    }
    if (url === `${BASE}/api/workspaces/ws-1/projects`) {
      return jsonResponse(200, {
        projects: [
          {
            id: UUID_A,
            name: "alpha-site",
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_100_000,
            project: { skillId: null, designSystemId: null },
          },
        ],
      });
    }
    throw new Error(`unmocked fetch in test: ${url}`);
  }) as unknown as typeof fetch;
}
