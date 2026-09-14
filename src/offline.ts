import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isTextualKind, kindForPath } from "./format.js";

/**
 * Offline store: read-only views over the OpenDesign data directory.
 *
 * OpenDesign is local-first — every project is a plain directory under
 * `<dataDir>/projects/<uuid>/` (entry HTML, sibling files, `.artifact.json`
 * manifests, `.file-versions/` history), run state lives in
 * `<dataDir>/runs/<id>/state.json`, and display names live in the sqlite
 * catalog. When the daemon is down we can still list, read, search, and
 * bundle from disk; the daemon's file watcher reconciles any external
 * changes the next time it runs.
 *
 * The database is opened read-only; on failure we degrade to names from the
 * filesystem (uuid + manifest titles) rather than failing the command.
 */

export interface OfflineProject {
  id: string;
  name: string | null;
  skillId: string | null;
  designSystemId: string | null;
  entryFile: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface OfflineFile {
  name: string;
  size: number;
  mtime: number;
  kind: string;
}

export interface OfflineRun {
  id: string;
  status: string | null;
  projectId: string | null;
  agentId: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  error: string | null;
  artifactPaths: string[] | null;
}

type Row = Record<string, unknown>;

export class OfflineStore {
  readonly dataDir: string;
  #db: unknown | null | undefined;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  async listProjects(): Promise<OfflineProject[]> {
    const dirEntries = await this.listProjectDirs();
    const byId = new Map<string, OfflineProject>();
    for (const id of dirEntries) {
      byId.set(id, {
        id,
        name: null,
        skillId: null,
        designSystemId: null,
        entryFile: null,
        createdAt: null,
        updatedAt: null,
      });
    }
    for (const row of await this.queryProjects()) {
      const id = String(row.id ?? "");
      if (!id) continue;
      const metadata = parseJson(row.metadata_json);
      byId.set(id, {
        id,
        name: typeof row.name === "string" ? row.name : null,
        skillId: typeof row.skill_id === "string" ? row.skill_id : null,
        designSystemId: typeof row.design_system_id === "string" ? row.design_system_id : null,
        entryFile: typeof metadata?.entryFile === "string" ? metadata.entryFile : null,
        createdAt: numberOrNull(row.created_at),
        updatedAt: numberOrNull(row.updated_at),
      });
    }
    const projects = [...byId.values()];
    for (const project of projects) {
      if (project.updatedAt == null || project.name == null || project.entryFile == null) {
        const fill = await this.fillFromDir(project);
        project.updatedAt = project.updatedAt ?? fill.updatedAt;
        project.entryFile = project.entryFile ?? fill.entryFile;
      }
    }
    return projects.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  async projectDir(projectId: string): Promise<string> {
    return join(this.dataDir, "projects", projectId);
  }

  async listFiles(projectId: string): Promise<OfflineFile[]> {
    const root = await this.projectDir(projectId);
    const out: OfflineFile[] = [];
    let entries: string[];
    try {
      entries = await readdirRecursive(root, root);
    } catch {
      return out;
    }
    for (const rel of entries) {
      if (hiddenProjectEntry(rel)) continue;
      let info;
      try {
        info = await stat(join(root, rel));
      } catch {
        continue;
      }
      if (!info.isFile()) continue;
      out.push({ name: rel, size: info.size, mtime: info.mtimeMs, kind: kindForPath(rel) });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async readTextFile(projectId: string, relPath: string): Promise<{ text: string; kind: string } | null> {
    const safe = safeRelPath(relPath);
    if (safe == null) return null;
    try {
      const text = await readFile(join(this.dataDir, "projects", projectId, safe), "utf8");
      return { text, kind: kindForPath(safe) };
    } catch {
      return null;
    }
  }

  async search(
    projectId: string,
    query: string,
    glob: string | null,
    max: number,
  ): Promise<Array<{ file: string; line: number; snippet: string }>> {
    const needle = query.toLowerCase();
    const pattern = glob ? compileGlob(glob) : null;
    const matches: Array<{ file: string; line: number; snippet: string }> = [];
    for (const file of await this.listFiles(projectId)) {
      if (!isTextualKind(file.kind)) continue;
      if (pattern && !pattern.test(file.name)) continue;
      const read = await this.readTextFile(projectId, file.name);
      if (read == null) continue;
      const lines = read.text.split("\n");
      for (let i = 0; i < lines.length && matches.length < max; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        const lower = line.toLowerCase();
        if (lower.includes(needle)) {
          matches.push({ file: file.name, line: i + 1, snippet: snippet(line) });
        }
      }
      if (matches.length >= max) break;
    }
    return matches;
  }

  async listRuns(projectId: string | null): Promise<OfflineRun[]> {
    const runsDir = join(this.dataDir, "runs");
    let ids: string[];
    try {
      ids = await readdir(runsDir);
    } catch {
      return [];
    }
    const runs: OfflineRun[] = [];
    for (const id of ids) {
      const run = await this.getRun(id);
      if (run && (projectId == null || run.projectId === projectId)) runs.push(run);
    }
    return runs.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  async getRun(runId: string): Promise<OfflineRun | null> {
    const raw = await this.readJsonFile(join(this.dataDir, "runs", runId, "state.json"));
    if (raw == null) return null;
    return {
      id: String(raw.id ?? runId),
      status: typeof raw.status === "string" ? raw.status : null,
      projectId: typeof raw.projectId === "string" ? raw.projectId : null,
      agentId: typeof raw.agentId === "string" ? raw.agentId : null,
      createdAt: numberOrNull(raw.createdAt),
      updatedAt: numberOrNull(raw.updatedAt),
      error: typeof raw.error === "string" ? raw.error : null,
      artifactPaths: Array.isArray(raw.artifactPaths)
        ? raw.artifactPaths.filter((p): p is string => typeof p === "string")
        : null,
    };
  }

  async artifactManifests(projectId: string): Promise<Array<{ entry: string; kind: string; title: string; status: string }>> {
    const manifests: Array<{ entry: string; kind: string; title: string; status: string }> = [];
    // Manifest sidecars are hidden from listFiles by design; enumerate them
    // directly so entry discovery keeps working.
    const root = join(this.dataDir, "projects", projectId);
    let entries: string[];
    try {
      entries = await readdir(root, { recursive: true });
    } catch {
      return manifests;
    }
    for (const rel of entries) {
      if (!rel.endsWith(".artifact.json")) continue;
      // Skip dot directories (.file-versions, .od-skills), keep manifest sidecars.
      if (rel.split("/").some((segment) => segment.startsWith("."))) continue;
      const read = await this.readTextFile(projectId, rel);
      if (read == null) continue;
      const parsed = parseJson(read.text) as Record<string, unknown> | null;
      if (parsed == null) continue;
      const base = rel.slice(0, -".artifact.json".length);
      manifests.push({
        entry: typeof parsed.entry === "string" ? parsed.entry : base,
        kind: typeof parsed.kind === "string" ? parsed.kind : "html",
        title: typeof parsed.title === "string" ? parsed.title : base,
        status: typeof parsed.status === "string" ? parsed.status : "unknown",
      });
    }
    return manifests;
  }

  async #dbHandle(): Promise<unknown | null> {
    if (this.#db !== undefined) return this.#db;
    try {
      const dbPath = join(this.dataDir, "app.sqlite");
      await stat(dbPath).catch(() => {
        throw new Error("missing");
      });
      const { DatabaseSync } = (await import("node:sqlite")) as {
        DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
          prepare: (sql: string) => { all: (...args: unknown[]) => Row[] };
          close: () => void;
        };
      };
      let handle;
      try {
        handle = new DatabaseSync(dbPath, { readOnly: true });
      } catch {
        handle = new DatabaseSync(dbPath);
      }
      this.#db = handle;
    } catch {
      this.#db = null;
    }
    return this.#db ?? null;
  }

  async queryProjects(): Promise<Row[]> {
    const db = (await this.#dbHandle()) as
      | { prepare: (sql: string) => { all: (...args: unknown[]) => Row[] } }
      | null;
    if (db == null) return [];
    try {
      return db.prepare("SELECT id, name, skill_id, design_system_id, metadata_json, created_at, updated_at FROM projects").all();
    } catch {
      return [];
    }
  }

  private async listProjectDirs(): Promise<string[]> {
    try {
      const entries = await readdir(join(this.dataDir, "projects"), { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  private async fillFromDir(project: OfflineProject): Promise<{ updatedAt: number | null; entryFile: string | null }> {
    const files = await this.listFiles(project.id);
    let updatedAt: number | null = null;
    for (const file of files) {
      if (updatedAt == null || file.mtime > updatedAt) updatedAt = file.mtime;
    }
    const manifests = await this.artifactManifests(project.id);
    const complete = manifests.find((m) => m.status === "complete") ?? manifests[0];
    const entryFile = complete?.entry ?? files.find((f) => /\.html?$/i.test(f.name))?.name ?? null;
    return { updatedAt, entryFile };
  }

  private async readJsonFile(path: string): Promise<Record<string, unknown> | null> {
    try {
      return parseJson(await readFile(path, "utf8"));
    } catch {
      return null;
    }
  }
}

function parseJson(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function snippet(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > 220 ? `${trimmed.slice(0, 220)}…` : trimmed;
}

async function readdirRecursive(root: string, _dir: string): Promise<string[]> {
  // Node's recursive readdir returns root-relative paths ("sub/file.html").
  return (await readdir(root, { recursive: true })) as string[];
}

/** Reject traversal and absolute paths before touching the filesystem. */
export function safeRelPath(input: string): string | null {
  if (input.length === 0 || input.includes("\0")) return null;
  if (input.startsWith("/") || input.startsWith("~")) return null;
  const segments = input.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments.join("/");
}

/** The daemon hides dot-entries and artifact manifests from file listings. */
export function hiddenProjectEntry(rel: string): boolean {
  const segments = rel.split("/");
  return segments.some((segment) => segment.startsWith(".") || segment.endsWith(".artifact.json"));
}

/** Simple `*`/`**` glob → RegExp, matching the daemon's `pattern` filter. */
export function compileGlob(pattern: string): RegExp {
  let source = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i] ?? "";
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i += 2;
        if (pattern[i] === "/") i += 1;
      } else {
        source += "[^/]*";
        i += 1;
      }
    } else if (/[a-zA-Z0-9]/.test(char)) {
      source += char;
      i += 1;
    } else {
      source += `\\${char}`;
      i += 1;
    }
  }
  return new RegExp(`^${source}$`, "i");
}
