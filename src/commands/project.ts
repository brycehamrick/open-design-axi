import { collapseHomeDirectory } from "../util.js";
import { parseCommandArgs } from "../args.js";
import { epochSeconds, isoSeconds } from "../format.js";
import { resolveProject } from "../project.js";
import { loadRuntime, requireOfflineStore } from "./shared.js";

/**
 * `project <id|name>` — combined detail view (principle 4): project record,
 * resolved entry file, file/byte aggregates, preview URL, and next steps in
 * one call instead of list → get → files round trips.
 */
export async function projectCommand(argv: string[]): Promise<Record<string, unknown>> {
  const { positionals, flags } = parseCommandArgs(argv, {}, [{ name: "project" }], "project");
  const runtime = await loadRuntime(flags);
  const resolved = await resolveProject(positionals[0], { api: runtime.api, offline: runtime.offline });

  const out: Record<string, unknown> = {
    project: resolved.name ?? "(unnamed)",
    id: resolved.id,
  };
  const help: string[] = [];

  if (!runtime.api.offline) {
    const data = (await runtime.api.getJson(`/api/projects/${encodeURIComponent(resolved.id)}`, {
      workspace: true,
    })) as {
      project?: {
        metadata?: { kind?: string; entryFile?: string };
        skillId?: string | null;
        designSystemId?: string | null;
        createdAt?: number;
        updatedAt?: number;
      };
      resolvedDir?: string;
    };
    const project = data?.project ?? {};
    const files = (await runtime.api.getJson(`/api/projects/${encodeURIComponent(resolved.id)}/files`, {
      workspace: true,
    })) as { files?: Array<{ name: string; size: number; kind: string }> };
    const fileList = files.files ?? [];
    const totalBytes = fileList.reduce((sum, file) => sum + (file.size ?? 0), 0);

    const entry =
      resolved.activeFileName ??
      project.metadata?.entryFile ??
      fileList.find((file) => file.kind === "html")?.name ??
      null;

    out.kind = project.metadata?.kind ?? null;
    out.skill = project.skillId ?? null;
    out.design_system = project.designSystemId ?? null;
    out.files = `${fileList.length} (${formatBytes(totalBytes)})`;
    out.entry = entry;
    out.updated = project.updatedAt ? `${epochSeconds(project.updatedAt)} (${isoSeconds(project.updatedAt)})` : null;
    if (data?.resolvedDir) out.resolved_dir = collapseHomeDirectory(data.resolvedDir);
    if (entry) {
      out.preview_url = `${runtime.api.baseUrl}/api/projects/${encodeURIComponent(resolved.id)}/raw/${encodePath(entry)}`;
      help.push(`Run \`open-design-axi read ${resolved.displayRef} ${entry}\` to view the entry file`);
      help.push(`Run \`open-design-axi artifact ${resolved.displayRef}\` to pull the full bundle`);
    } else {
      help.push("No entry file yet — generate one with `run start <id|name> --prompt \"...\" --confirm`");
    }
    help.push(`Run \`open-design-axi run start ${resolved.displayRef} --prompt "<brief>" --confirm\` to iterate`);
  } else {
    requireOfflineStore(runtime);
    const offlineProject = (await runtime.offline.listProjects()).find((p) => p.id === resolved.id) ?? null;
    const files = await runtime.offline.listFiles(resolved.id);
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const manifests = await runtime.offline.artifactManifests(resolved.id);
    const entry =
      offlineProject?.entryFile ??
      manifests.find((m) => m.status === "complete")?.entry ??
      files.find((file) => file.kind === "html")?.name ??
      null;

    out.mode = "offline";
    out.kind = null;
    out.files = `${files.length} (${formatBytes(totalBytes)})`;
    out.entry = entry;
    out.updated = offlineProject?.updatedAt ? `${epochSeconds(offlineProject.updatedAt)} (${isoSeconds(offlineProject.updatedAt)})` : null;
    out.resolved_dir = collapseHomeDirectory(await runtime.offline.projectDir(resolved.id));
    if (entry) {
      help.push(`Run \`open-design-axi read ${resolved.displayRef} ${entry}\` (offline read)`);
      help.push(`Run \`open-design-axi artifact ${resolved.displayRef}\` to pull the full bundle (offline)`);
    }
    help.push("Start the OpenDesign app for live preview URLs and generation runs");
  }

  out.help = help.slice(0, 3);
  return out;
}

export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
