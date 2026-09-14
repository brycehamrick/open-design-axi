import { randomUUID } from "node:crypto";
import { AxiError } from "axi-sdk-js";
import { parseCommandArgs } from "../args.js";
import { epochSeconds, selectRows, shortId, limitHelpLine } from "../format.js";
import { listProjectCandidates, matchProject } from "../project.js";
import { loadRuntime, requireOnline, requireConfirm, type Runtime } from "./shared.js";

/**
 * `projects` — list, create, delete. Default list schema is 3 fields with
 * 8-char id prefixes; `--fields` extends it, `--limit 0` shows everything.
 * Listing works online (daemon catalog, both unbound and workspace-bound)
 * and offline (local data directory).
 */

const LIST_FIELDS = ["id", "name", "updated", "created", "skill", "design_system", "full_id"];

interface ProjectRow {
  id: string;
  name: string | null;
  updated: number | null;
  created: number | null;
  skill: string | null;
  designSystem: string | null;
  fullId: string;
}

export async function projectsCommand(argv: string[]): Promise<Record<string, unknown>> {
  const sub = argv[0] === "create" || argv[0] === "delete" ? argv[0] : null;
  const rest = sub ? argv.slice(1) : argv;

  if (sub === "create") return await createProject(rest);
  if (sub === "delete") return await deleteProject(rest);
  return await listProjects(rest);
}

async function listProjects(argv: string[]): Promise<Record<string, unknown>> {
  const { flags } = parseCommandArgs(
    argv,
    { string: ["fields"], number: ["limit"], defaults: { limit: 50 } },
    [],
    "projects",
  );
  const runtime = await loadRuntime(flags);
  const rows: ProjectRow[] = [];

  if (!runtime.api.offline) {
    for (const candidate of await listProjectCandidates(runtime.api)) {
      rows.push({
        id: candidate.id,
        name: candidate.name,
        updated: null,
        created: null,
        skill: null,
        designSystem: null,
        fullId: candidate.id,
      });
    }
    // Workspace-bound rows carry timestamps + skill/design-system inline.
    const workspaceId = await firstWorkspaceId(runtime);
    if (workspaceId) {
      const data = (await runtime.api
        .getJson(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects`, { workspace: true })
        .catch(() => null)) as {
        projects?: Array<{
          id: string;
          createdAt?: number;
          updatedAt?: number;
          project?: { skillId?: string | null; designSystemId?: string | null };
        }>;
      } | null;
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const item of data?.projects ?? []) {
        const row = byId.get(item.id);
        if (!row) continue;
        row.updated = item.updatedAt ?? row.updated;
        row.created = item.createdAt ?? row.created;
        row.skill = item.project?.skillId ?? row.skill;
        row.designSystem = item.project?.designSystemId ?? row.designSystem;
      }
    }
    rows.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  } else if (runtime.offline) {
    for (const project of await runtime.offline.listProjects()) {
      rows.push({
        id: project.id,
        name: project.name,
        updated: project.updatedAt,
        created: project.createdAt,
        skill: project.skillId,
        designSystem: project.designSystemId,
        fullId: project.id,
      });
    }
  } else {
    throw new AxiError(
      "daemon offline and no local data directory resolved; nothing to list",
      "DAEMON_UNAVAILABLE",
      ["Start the OpenDesign app, or pass --data-dir <path> / OD_DATA_DIR"],
    );
  }

  if (rows.length === 0) {
    return {
      projects: `0 projects found${runtime.api.offline ? " (offline)" : ""}`,
      help: ["Run `open-design-axi projects create --name \"<name>\" --confirm` to create one"],
    };
  }

  const selection = selectRows(
    rows,
    ["id", "name", "updated"],
    { fields: flags.fields as string | undefined, limit: flags.limit as number | undefined },
    LIST_FIELDS,
    (row) => ({
      id: shortId(row.id) ?? row.id,
      name: row.name ?? "(unnamed)",
      updated: epochSeconds(row.updated),
      created: epochSeconds(row.created),
      skill: row.skill,
      design_system: row.designSystem,
      full_id: row.fullId,
    }),
  );

  const out: Record<string, unknown> = {
    count: selection.total,
    projects: selection.rows,
  };
  const hint = limitHelpLine("projects", selection.shown, selection.total, flags.limit as number);
  out.help = [
    ...(hint ? [hint] : []),
    "Run `open-design-axi project <id|name>` to inspect one",
  ];
  return out;
}

async function firstWorkspaceId(runtime: Runtime): Promise<string | null> {
  try {
    const data = (await runtime.api.getJson("/api/workspace/directory")) as {
      items?: Array<{ workspaceId: string; workspaceType?: string; memberStatus?: string; lifecycleState?: string }>;
    };
    const active = (data.items ?? []).filter(
      (item) => item.memberStatus === "active" && item.lifecycleState === "active",
    );
    const selected = active.find((item) => item.workspaceType === "personal") ?? active[0];
    return selected?.workspaceId ?? null;
  } catch {
    return null;
  }
}

async function createProject(argv: string[]): Promise<Record<string, unknown>> {
  const { flags } = parseCommandArgs(
    argv,
    { string: ["name", "skill", "design-system"], boolean: ["confirm"] },
    [],
    "projects create",
  );
  const name = typeof flags.name === "string" ? flags.name.trim() : "";
  if (!name) {
    throw new AxiError("--name is required", "VALIDATION_ERROR", [
      'Run `open-design-axi projects create --name "<name>" --confirm`',
    ]);
  }
  const skill = typeof flags.skill === "string" && flags.skill.length > 0 ? flags.skill : null;
  const designSystem =
    typeof flags["design-system"] === "string" && flags["design-system"].length > 0
      ? flags["design-system"]
      : null;

  requireConfirm(
    { project: name, skill: skill ?? "none", design_system: designSystem ?? "none" },
    'projects create --name "<name>"',
    flags.confirm,
  );

  const runtime = await loadRuntime(flags);
  requireOnline(runtime, "create a project");

  const id = slugifyProjectId(name);
  const body: Record<string, unknown> = { id, name, skipDiscoveryBrief: true };
  if (skill) body.skillId = skill;
  if (designSystem) body.designSystemId = designSystem;

  let created: { project?: { id?: string; name?: string } };
  try {
    created = (await runtime.api.postJson("/api/projects", body, { workspace: true })) as typeof created;
  } catch (error) {
    if (String(error).includes("WORKSPACE_")) {
      // A headerless create is always legal; the daemon lazy-adopts the
      // project into the workspace on the next list.
      created = (await runtime.api.postJson("/api/projects", body)) as typeof created;
    } else {
      throw error;
    }
  }

  return {
    created: created?.project?.name ?? name,
    id: created?.project?.id ?? id,
    help: [
      'Run `open-design-axi run start <id|name> --prompt "<brief>" --confirm` to generate the first artifact',
      "Run `open-design-axi write <id|name> <path> --stdin --confirm` to add a file",
    ],
  };
}

async function deleteProject(argv: string[]): Promise<Record<string, unknown>> {
  const { positionals, flags } = parseCommandArgs(
    argv,
    { boolean: ["confirm"] },
    [{ name: "project", required: true }],
    "projects delete",
  );
  const runtime = await loadRuntime(flags);
  requireOnline(runtime, "delete a project");

  const ref = positionals[0]!;
  const candidates = await listProjectCandidates(runtime.api);
  const matched = matchProject(candidates, ref);
  const target = concludeMatch(matched, ref);

  requireConfirm(
    {
      project: target.name ?? target.id,
      id: target.id,
      irreversible: "deletes the project row and its files on disk",
    },
    `projects delete ${ref}`,
    flags.confirm,
  );

  await runtime.api.deleteJson(`/api/projects/${encodeURIComponent(target.id)}`, { workspace: true });
  return {
    deleted: target.name ?? target.id,
    id: target.id,
  };
}

export function concludeMatch(
  matched: ReturnType<typeof matchProject>,
  ref: string,
): { id: string; name: string | null } {
  if ("ambiguous" in matched) {
    const candidates = matched.ambiguous;
    if (candidates.length === 0) {
      throw new AxiError(
        `no project matches "${ref}"`,
        "NOT_FOUND",
        ["Run `open-design-axi projects` to list ids and names"],
      );
    }
    const list = candidates
      .slice(0, 5)
      .map((c) => `${c.id.slice(0, 8)} ${c.name ?? "(unnamed)"}`)
      .join("; ");
    throw new AxiError(
      `"${ref}" is ambiguous across ${candidates.length} projects: ${list}`,
      "AMBIGUOUS",
      ["Use the full id or a unique name substring"],
    );
  }
  return { id: matched.id, name: matched.name };
}

function slugifyProjectId(name: string): string {
  const base =
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) ||
    "project";
  return `${base}-${randomUUID().replace(/-/g, "").slice(0, 4)}`;
}
