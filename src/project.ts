import { AxiError } from "axi-sdk-js";
import type { DaemonApi } from "./api.js";
import type { OfflineStore } from "./offline.js";

/**
 * Project resolution: accept a full UUID, an 8-char id prefix (what list
 * views print), an exact name, or a unique name substring. When the caller
 * omits the reference (or passes "active"), resolve the daemon's active
 * context — the project the user has open in the app right now.
 *
 * Every resolution also carries a paste-safe `displayRef` for help lines:
 * the printed 8-char prefix when unique, otherwise the full id.
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
  /**
   * Paste-safe ref for help lines: the 8-char prefix list views print,
   * unless that prefix is shared with another project (slug ids often
   * collide), in which case the full id. Anything printed in help[]
   * resolves when pasted back.
   */
  displayRef: string;
}

/** A resolution before displayRef is checked against the catalog. */
export type MatchedProject = Omit<ResolvedProject, "displayRef">;

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

export function matchProject(candidates: ProjectCandidate[], ref: string): MatchedProject | { ambiguous: ProjectCandidate[] } {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    return { ambiguous: [] };
  }
  const byId = candidates.find((c) => c.id.toLowerCase() === trimmed.toLowerCase());
  if (byId) return project(byId, "id");

  const byName = candidates.filter((c) => c.name != null && c.name.toLowerCase() === trimmed.toLowerCase());
  if (byName.length === 1) return project(byName[0]!, "name");
  if (byName.length > 1) return { ambiguous: byName };

  // Prefix-match every ref: list views print 8-char id prefixes, and ids
  // are often slugs ("aurora-site-…"), not uuids, so a hex-shape guard would
  // make copied prefixes unresolvable.
  const byPrefix = candidates.filter((c) => c.id.toLowerCase().startsWith(trimmed.toLowerCase()));
  if (byPrefix.length === 1) return project(byPrefix[0]!, "id-prefix");
  if (byPrefix.length > 1) return { ambiguous: byPrefix };

  const bySubstring = candidates.filter(
    (c) => c.name != null && c.name.toLowerCase().includes(trimmed.toLowerCase()),
  );
  if (bySubstring.length === 1) return project(bySubstring[0]!, "name-substring");
  if (bySubstring.length > 1) return { ambiguous: bySubstring };

  return { ambiguous: [] };
}

function project(candidate: ProjectCandidate, via: MatchedProject["via"]): MatchedProject {
  return { id: candidate.id, name: candidate.name, via, activeFileName: null };
}

/**
 * The ref to print in help lines: what list views print (8-char prefix), or
 * the full id when that prefix is shared with another project. Without a
 * catalog in hand (active-context resolution), uuid prefixes are trusted
 * and slug ids print in full because their prefixes can collide.
 */
export function displayRefFor(id: string, candidates: ProjectCandidate[] | null): string {
  const printed = id.length > 12 ? id.slice(0, 8) : id;
  if (printed === id) return id;
  if (candidates != null) {
    const shared = candidates.some(
      (c) => c.id !== id && c.id.toLowerCase().startsWith(printed.toLowerCase()),
    );
    return shared ? id : printed;
  }
  return looksUuid(id) ? printed : id;
}

function looksUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
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
        displayRef: displayRefFor(active.projectId, null),
      };
    }
    const candidates = await listProjectCandidates(deps.api);
    if (active != null && wanted === active.projectId) {
      return {
        id: active.projectId,
        name: active.projectName,
        via: "id",
        activeFileName: active.fileName,
        displayRef: displayRefFor(active.projectId, candidates),
      };
    }
    const matched = conclude(matchProject(candidates, wanted), wanted, active);
    return { ...matched, displayRef: displayRefFor(matched.id, candidates) };
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
  const resolved = conclude(matchProject(candidates, wanted!), wanted!, null);
  return { ...resolved, displayRef: displayRefFor(resolved.id, candidates) };
}

export function conclude(
  matched: MatchedProject | { ambiguous: ProjectCandidate[] },
  wanted: string,
  active: ActiveContext | null,
): MatchedProject {
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
