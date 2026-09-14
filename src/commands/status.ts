import { collapseHomeDirectory } from "../util.js";
import type { Runtime } from "./shared.js";

/** Daemon health + discovery diagnostics. */
export async function statusView(runtime: Runtime): Promise<Record<string, unknown>> {
  const endpoint = runtime.endpoint;
  const out: Record<string, unknown> = {
    daemon: endpoint.mode === "online" ? "online" : "offline",
  };
  if (endpoint.baseUrl) {
    out.url = endpoint.baseUrl;
    out.discovered_via = endpoint.discoveredVia;
  }
  if (endpoint.daemon) {
    out.version = endpoint.daemon.version ?? null;
    out.pid = endpoint.daemon.pid ?? null;
  }
  out.data_dir = endpoint.dataDir ? collapseHomeDirectory(endpoint.dataDir) : null;
  out.data_dir_via = endpoint.dataDirVia;
  out.api_token = process.env.OD_API_TOKEN ? "set (bearer)" : "none (loopback default)";

  if (!runtime.api.offline) {
    const projects = await runtime.api
      .getJson("/api/projects")
      .then((d) => (d as { projects?: unknown[] }).projects?.length ?? 0)
      .catch(() => null);
    out.unbound_projects = projects;
  } else if (runtime.offline) {
    out.offline_projects = (await runtime.offline.listProjects()).length;
  }
  out.offline_reads = runtime.offline != null ? "available" : "unavailable (no data dir resolved)";

  out.help = runtime.api.offline
    ? [
        "Start the OpenDesign desktop app to bring the daemon online",
        "Run `open-design-axi projects` for the offline project list",
      ]
    : ["Run `open-design-axi projects` to list projects", "Run `open-design-axi project <id|name>` to inspect one"];
  return out;
}
