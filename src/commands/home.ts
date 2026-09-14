import { shortId, epochSeconds } from "../format.js";
import { listProjectCandidates, fetchActiveContext } from "../project.js";
import type { Runtime } from "./shared.js";
import { DaemonApi } from "../api.js";

/**
 * Content-first home view (AXI principles 8 + 4): live daemon/project/run
 * state plus next-step help, online or offline. The SDK prepends
 * `bin`/`description`, so the hook-installed session-start view and this
 * output stay identical.
 */
export async function homeView(runtime: Runtime): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const help: string[] = [];

  if (!runtime.api.offline) {
    const version = runtime.api.version ? `, v${runtime.api.version}` : "";
    out.daemon = `online at ${runtime.endpoint.baseUrl}${version} (via ${runtime.endpoint.discoveredVia})`;
  } else if (runtime.endpoint.baseUrl) {
    out.daemon = `offline — unreachable at ${runtime.endpoint.baseUrl}; reading local data`;
  } else {
    out.daemon = "offline — daemon not found; start the OpenDesign app for live data";
  }

  if (!runtime.api.offline) {
    const active = await fetchActiveContext(runtime.api);
    out.active = active
      ? `${active.projectName ?? active.projectId} (${shortId(active.projectId)})${active.fileName ? ` · ${active.fileName}` : ""}`
      : "none";
    const projects = await listProjectCandidates(runtime.api).catch(() => []);
    const rows = projects.slice(0, 10).map((p) => ({
      id: shortId(p.id) ?? p.id,
      name: p.name ?? "(unnamed)",
    }));
    out.count = projects.length;
    out.projects = rows;
    const runs = await recentRuns(runtime.api, 3);
    if (runs.length > 0) {
      out.runs = runs.map((run) => ({
        id: shortId(run.id) ?? run.id,
        status: run.status,
        project: run.projectLabel,
      }));
    }
    help.push("Run `open-design-axi project <id|name>` to inspect a project");
    help.push("Run `open-design-axi artifact <id|name>` to pull a full design bundle");
    if (projects.length === 0) {
      help.push("Run `open-design-axi projects create --name \"<name>\" --confirm` to create one");
    }
  } else if (runtime.offline) {
    const projects = await runtime.offline.listProjects();
    out.count = projects.length;
    out.projects = projects.slice(0, 10).map((p) => ({
      id: shortId(p.id) ?? p.id,
      name: p.name ?? "(unnamed)",
      updated: epochSeconds(p.updatedAt),
    }));
    const runs = await runtime.offline.listRuns(null);
    if (runs.length > 0) {
      out.runs = runs.slice(0, 3).map((run) => ({
        id: shortId(run.id) ?? run.id,
        status: run.status ?? "unknown",
        project: shortId(run.projectId) ?? "-",
      }));
    }
    help.push("Run `open-design-axi project <id|name>` to inspect a project (offline read)");
    help.push("Start the OpenDesign app to enable writes and generation runs");
  } else {
    out.count = 0;
    out.projects = [];
    out.note = "0 projects found; set OD_DATA_DIR or --data-dir to read offline";
    help.push("Start the OpenDesign app, or pass --data-dir <path> to your OpenDesign data directory");
  }

  out.help = help.slice(0, 3);
  return out;
}

interface RunRow {
  id: string;
  status: string | null;
  projectLabel: string | null;
}

async function recentRuns(api: DaemonApi, limit: number): Promise<RunRow[]> {
  try {
    const data = (await api.getJson("/api/runs")) as {
      runs?: Array<{ id: string; status?: string | null; projectId?: string | null }>;
    };
    return (data.runs ?? []).slice(0, limit).map((run) => ({
      id: run.id,
      status: run.status ?? "unknown",
      projectLabel: shortId(run.projectId ?? null) ?? "-",
    }));
  } catch {
    return [];
  }
}
