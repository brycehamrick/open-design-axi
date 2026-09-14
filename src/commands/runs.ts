import { AxiError } from "axi-sdk-js";
import { parseCommandArgs } from "../args.js";
import { epochSeconds, selectRows, shortId, limitHelpLine } from "../format.js";
import { resolveProject } from "../project.js";
import { loadRuntime, requireOfflineStore } from "./shared.js";

/**
 * `runs [<id|name>]` — generation run history, newest first. Online this is
 * `GET /api/runs?projectId=` (the daemon requires a project scope once any
 * workspace-bound run exists); offline it reads `runs/<id>/state.json`.
 */

export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "canceled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

const LIST_FIELDS = ["id", "status", "agent", "project", "updated", "error", "full_id"];

interface RunRow {
  id: string;
  status: string | null;
  agent: string | null;
  project: string | null;
  updated: number | null;
  error: string | null;
  fullId: string;
}

export async function runsCommand(argv: string[]): Promise<Record<string, unknown>> {
  const { positionals, flags } = parseCommandArgs(
    argv,
    { string: ["fields", "status"], number: ["limit"], defaults: { limit: 20 } },
    [{ name: "project" }],
    "runs",
  );
  if (flags.status != null && !RUN_STATUSES.includes(flags.status as RunStatus)) {
    throw new AxiError(
      `invalid --status "${flags.status}"; expected one of: ${RUN_STATUSES.join(", ")}`,
      "VALIDATION_ERROR",
      ["Run `open-design-axi runs --help` for usage"],
    );
  }

  const runtime = await loadRuntime(flags);
  const rows: RunRow[] = [];

  if (!runtime.api.offline) {
    let projectId: string | null = null;
    let projectName: string | null = null;
    if (positionals[0] != null) {
      const resolved = await resolveProject(positionals[0], { api: runtime.api, offline: runtime.offline });
      projectId = resolved.id;
      projectName = resolved.name;
    }
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    if (flags.status != null) params.set("status", String(flags.status));
    const data = (await runtime.api.getJson(`/api/runs?${params.toString()}`, { workspace: true })) as {
      runs?: Array<{
        id: string;
        status?: string | null;
        agentId?: string | null;
        projectId?: string | null;
        updatedAt?: number;
        error?: string | null;
      }>;
    };
    for (const run of data.runs ?? []) {
      rows.push({
        id: run.id,
        status: run.status ?? null,
        agent: run.agentId ?? null,
        project: run.projectId ? shortId(run.projectId) : null,
        updated: run.updatedAt ?? null,
        error: run.error ?? null,
        fullId: run.id,
      });
    }
    void projectName;
  } else {
    requireOfflineStore(runtime);
    let projectId: string | null = null;
    if (positionals[0] != null) {
      const resolved = await resolveProject(positionals[0], { api: runtime.api, offline: runtime.offline });
      projectId = resolved.id;
    }
    for (const run of await runtime.offline.listRuns(projectId)) {
      rows.push({
        id: run.id,
        status: run.status,
        agent: run.agentId,
        project: run.projectId ? shortId(run.projectId) : null,
        updated: run.updatedAt,
        error: run.error,
        fullId: run.id,
      });
    }
  }

  const filtered = flags.status != null ? rows.filter((row) => row.status === flags.status) : rows;
  if (filtered.length === 0) {
    const scope = positionals[0] != null ? ` for ${positionals[0]}` : "";
    return {
      runs: `0 runs${scope}${runtime.api.offline ? " (offline)" : ""}`,
      help: ['Run `open-design-axi run start <id|name> --prompt "<brief>" --confirm` to start one'],
    };
  }

  const selection = selectRows(
    filtered,
    ["id", "status", "agent"],
    { fields: flags.fields as string | undefined, limit: flags.limit as number | undefined },
    LIST_FIELDS,
    (row) => ({
      id: shortId(row.id) ?? row.id,
      status: row.status ?? "unknown",
      agent: row.agent,
      project: row.project,
      updated: epochSeconds(row.updated),
      error: row.error != null ? `${row.error.slice(0, 100)}${row.error.length > 100 ? "…" : ""}` : null,
      full_id: row.fullId,
    }),
  );

  const out: Record<string, unknown> = {
    count: selection.total,
    runs: selection.rows,
  };
  const hint = limitHelpLine("runs", selection.shown, selection.total, flags.limit as number);
  out.help = [
    ...(hint ? [hint] : []),
    "Run `open-design-axi run view <run-id>` for one run's detail",
  ];
  return out;
}
