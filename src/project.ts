import { AxiError } from "axi-sdk-js";
import type { DaemonApi } from "./api.js";
import type { OfflineStore } from "./offline.js";

/**
 * Project resolution: accept a full UUID, an 8-char id prefix (what list
 * views print), an exact name, or a unique name substring. When the caller
 * omits the reference (or passes "active"), resolve the daemon's active
 * context — the project the user has open in the app right now.
 */

export interface ProjectCandidate {
  id: string;
  name: string | null;
}

export interface ResolvedProject {
  id: string;
  name: string | null;
  via: "id" | "id-prefix" | "name" | "name-substring" | "active";
  activeFileName: string | null;
}

export interface ActiveContext {
  projectId: string;
  projectName: string | null;
  fileName: string | null;
}

export async function fetchActiveContext(api: DaemonApi): Promise<ActiveContext | null> {
  try {
    const data = (await api.getJson("/api/active")) as
      | { active: false }
      | { active: true; projectId: string; projectName: string | null; fileName: string | null };
    if (data == null || data.active !== true) return null;
    return {
      projectId: String(data.projectId),
      projectName: data.projectName ?? null,
      fileName: data.fileName ?? null,
    };
  } catch {
    return null;
  }
}

export async function listProjectCandidates(api: DaemonApi): Promise<ProjectCandidate[]> {
  const unbound = await api.getJson("/api/projects").catch(() => ({ projects: [] }));
  const candidates: ProjectCandidate[] = (
    (unbound as { projects?: Array<{ id: string; name: string }> }).projects ?? []
  ).map((p) => ({ id: p.id, name: typeof p.name === "string" ? p.name : null }));

  const firstWorkspace = await currentWorkspaceId(api);
  if (firstWorkspace) {
    const data = (await api
      .getJson(`/api/workspaces/${encodeURIComponent(firstWorkspace)}/projects`, { workspace: true })
      .catch(() => ({ projects: [] }))) as {
      projects?: Array<{ id: string; name: string; project?: { name?: string } }>;
    };
    const seen = new Set(candidates.map((c) => c.id));
    for (const p of data.projects ?? []) {
      if (seen.has(p.id)) continue;
      candidates.push({ id: p.id, name: p.name ?? p.project?.name ?? null });
      seen.add(p.id);
    }
  }
  return candidates;
}

async function currentWorkspaceId(api: DaemonApi): Promise<string | null> {
  try {
    const data = (await api.getJson("/api/workspace/directory")) as {
      items?: Array<{
        workspaceId: string;
        workspaceType?: string;
        memberStatus?: string;
        lifecycleState?: string;
      }>;
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

export function matchProject(candidates: ProjectCandidate[], ref: string): ResolvedProject | { ambiguous: ProjectCandidate[] } {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    return { ambiguous: [] };
  }
  const byId = candidates.find((c) => c.id.toLowerCase() === trimmed.toLowerCase());
  if (byId) return project(byId, "id");

  const byName = candidates.filter((c) => c.name != null && c.name.toLowerCase() === trimmed.toLowerCase());
  if (byName.length === 1) return project(byName[0]!, "name");
  if (byName.length > 1) return { ambiguous: byName };

  if (isUuidLike(trimmed)) {
    const byPrefix = candidates.filter((c) => c.id.toLowerCase().startsWith(trimmed.toLowerCase()));
    if (byPrefix.length === 1) return project(byPrefix[0]!, "id-prefix");
    if (byPrefix.length > 1) return { ambiguous: byPrefix };
  }

  const bySubstring = candidates.filter(
    (c) => c.name != null && c.name.toLowerCase().includes(trimmed.toLowerCase()),
  );
  if (bySubstring.length === 1) return project(bySubstring[0]!, "name-substring");
  if (bySubstring.length > 1) return { ambiguous: bySubstring };

  return { ambiguous: [] };
}

function project(candidate: ProjectCandidate, via: ResolvedProject["via"]): ResolvedProject {
  return { id: candidate.id, name: candidate.name, via, activeFileName: null };
}

export function uuidLike(ref: string): boolean {
  return /^[0-9a-f]{4,36}$/i.test(ref);
}

export function isUuidLike(ref: string): boolean {
  return /^[0-9a-f]{8,36}(-[0-9a-f]{4}){0,3}$/i.test(ref);
}

export async function resolveProject(
  ref: string | undefined,
  deps: { api: DaemonApi; offline: OfflineStore | null },
): Promise<ResolvedProject> {
  const wanted = ref?.trim();
  const useActive = wanted == null || wanted === "" || wanted.toLowerCase() === "active";

  if (!deps.api.offline) {
    const active = await fetchActiveContext(deps.api);
    if (useActive) {
      if (active == null) {
        throw new AxiError(
          "no active OpenDesign project right now (active context expires ~5 minutes after the last interaction with the app)",
          "NOT_FOUND",
          [
            "Pass a project id or name explicitly: `open-design-axi projects` lists them",
            "Click into a project in the OpenDesign app to make it active",
          ],
        );
      }
      return {
        id: active.projectId,
        name: active.projectName,
        via: "active",
        activeFileName: active.fileName,
      };
    }
    const candidates = await listProjectCandidates(deps.api);
    if (active != null && wanted === active.projectId) {
      return {
        id: active.projectId,
        name: active.projectName,
        via: "id",
        activeFileName: active.fileName,
      };
    }
    const matched = matchProject(candidates, wanted);
    return conclude(matched, wanted, active);
  }

  // Offline: no active context, resolve purely from the local catalog.
  const candidates: ProjectCandidate[] = deps.offline
    ? (await deps.offline.listProjects()).map((p) => ({ id: p.id, name: p.name }))
    : [];
  if (useActive) {
    throw new AxiError(
      "no daemon online, so there is no active-project context",
      "NOT_FOUND",
      ["Pass a project id or name explicitly: `open-design-axi projects` lists them (offline mode)"],
    );
  }
  return conclude(matchProject(candidates, wanted!), wanted!, null);
}

function conclude(
  matched: ResolvedProject | { ambiguous: ProjectCandidate[] },
  wanted: string,
  active: ActiveContext | null,
): ResolvedProject {
  if ("ambiguous" in matched) {
    const candidates = matched.ambiguous;
    if (candidates.length === 0) {
      throw new AxiError(
        `no project matches "${wanted}"`,
        "NOT_FOUND",
        ["Run `open-design-axi projects` to list ids and names"],
      );
    }
    const list = candidates
      .slice(0, 5)
      .map((c) => `${c.id.slice(0, 8)} ${c.name ?? "(unnamed)"}`)
      .join("; ");
    const more = candidates.length > 5 ? ` (+${candidates.length - 5} more)` : "";
    throw new AxiError(
      `"${wanted}" is ambiguous across ${candidates.length} projects: ${list}${more}`,
      "AMBIGUOUS",
      ["Use the full id or a longer, unique name substring"],
    );
  }
  if (active != null && active.projectId === matched.id) {
    return { ...matched, activeFileName: active.fileName };
  }
  return matched;
}
