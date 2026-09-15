import { AxiError } from "axi-sdk-js";
import { parseCommandArgs } from "../args.js";
import { shortId } from "../format.js";
import { safeRelPath } from "../offline.js";
import { resolveProject } from "../project.js";
import { loadRuntime, requireOfflineStore } from "./shared.js";
import { encodePath, formatBytes } from "./project.js";
import { extractRelativeRefs, isTextualMime } from "../refs.js";

/**
 * `artifact <id|name>` — full design bundle in one call (principle 4):
 * entry file plus every referenced sibling, assembled by BFS over
 * HTML/CSS/JS references. `--include shallow` returns just the entry,
 * `--include all` returns every project file. Byte budget defaults to
 * 1.5 MB with per-file content truncation and size hints (principle 3).
 */

const DEFAULT_MAX_BYTES = 1_500_000;
const MAX_FILES = 200;
const MAX_DEPTH = 3;
const PER_FILE_CHARS = 20_000;

interface BundleEntry {
  name: string;
  mime: string;
  size: number | null;
  content: string | null;
  binary: boolean;
}

export async function artifactCommand(argv: string[]): Promise<string> {
  const { positionals, flags } = parseCommandArgs(
    argv,
    {
      string: ["entry", "include"],
      boolean: ["full"],
      number: ["max-bytes"],
      defaults: { include: "auto", "max-bytes": DEFAULT_MAX_BYTES },
    },
    [{ name: "project" }],
    "artifact",
  );
  const include = String(flags.include);
  if (!["auto", "all", "shallow"].includes(include)) {
    throw new AxiError(
      `invalid --include "${include}"; expected one of: auto, all, shallow`,
      "VALIDATION_ERROR",
      ["Run `open-design-axi artifact --help` for usage"],
    );
  }
  const maxBytes = flags["max-bytes"] as number;

  const runtime = await loadRuntime(flags);
  const resolved = await resolveProject(positionals[0], { api: runtime.api, offline: runtime.offline });

  const entryArg =
    typeof flags.entry === "string" && flags.entry.length > 0 ? safeRelPath(flags.entry) : null;
  if (flags.entry != null && flags.entry !== "" && entryArg == null) {
    throw new AxiError(
      `invalid --entry "${flags.entry}" (absolute paths and ".." are not allowed)`,
      "VALIDATION_ERROR",
      ["Use a project-relative path like `index.html`"],
    );
  }

  // Resolve the entry: explicit > active file > project default > first html.
  let entry = entryArg ?? resolved.activeFileName;
  if (entry == null) {
    entry = await defaultEntry(runtime, resolved.id);
  }
  if (entry == null) {
    throw new AxiError(
      "no entry file: pass --entry <path> or set the project's entry file",
      "VALIDATION_ERROR",
      ["Run `open-design-axi files <id|name>` to pick an entry"],
    );
  }

  const loader = makeLoader(runtime, resolved.id);
  const entries: BundleEntry[] = [];
  let truncated = false;
  let skipped = 0;

  if (include === "shallow") {
    const first = await loader(entry, Infinity);
    if (first == null) throw entryMissing(entry, resolved.name ?? resolved.id);
    entries.push(first);
  } else if (include === "all") {
    const names = await listAllFiles(runtime, resolved.id);
    for (const name of names) {
      if (entries.length >= MAX_FILES || usedBytes(entries) >= maxBytes) {
        truncated = true;
        break;
      }
      const loaded = await loader(name, maxBytes - usedBytes(entries));
      if (loaded == null) skipped += 1;
      else entries.push(loaded);
    }
  } else {
    const first = await loader(entry, Infinity);
    if (first == null) throw entryMissing(entry, resolved.name ?? resolved.id);
    entries.push(first);
    let frontier: string[] = isTextualMime(first.mime)
      ? extractRelativeRefs(first.content ?? "", entry, first.mime)
      : [];
    const visited = new Set([entry]);
    for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const ref of frontier) {
        if (visited.has(ref)) continue;
        visited.add(ref);
        if (entries.length >= MAX_FILES || usedBytes(entries) >= maxBytes) {
          truncated = true;
          break;
        }
        const loaded = await loader(ref, maxBytes - usedBytes(entries));
        if (loaded == null) {
          skipped += 1;
          continue;
        }
        entries.push(loaded);
        if (isTextualMime(loaded.mime)) {
          next.push(...extractRelativeRefs(loaded.content ?? "", loaded.name, loaded.mime));
        }
      }
      frontier = next;
    }
  }

  const header: string[] = [
    `project: ${resolved.name ?? shortId(resolved.id)}`,
    `entry: ${entry}`,
    `include: ${include}`,
    `files[${entries.length}]{name,mime,size}:`,
    ...entries.map((e) => `  ${e.name},${e.mime},${e.size ?? "?"}`),
    `bytes: ${usedBytes(entries)} of ${maxBytes} budget`,
  ];
  if (truncated) header.push("truncated: true (byte budget or file cap reached — raise --max-bytes)");
  if (skipped > 0) header.push(`skipped: ${skipped} file(s) could not be read`);

  const blocks: string[] = [];
  for (const entryFile of entries) {
    if (entryFile.binary || entryFile.content == null) continue;
    const content = entryFile.content;
    if (flags.full === true || content.length <= PER_FILE_CHARS) {
      blocks.push(`--- file: ${entryFile.name} (${entryFile.mime}, ${content.length} chars) ---\n${content}`);
    } else {
      blocks.push(
        `--- file: ${entryFile.name} (${entryFile.mime}) ---\n${content.slice(0, PER_FILE_CHARS)}\n[truncated, ${content.length} chars total — use --full to see complete file]`,
      );
    }
  }

  const help = [`Run \`open-design-axi read ${resolved.displayRef} <path>\` for a windowed view of one file`];
  if (include !== "all") help.push("Run `open-design-axi artifact <id|name> --include all` for every project file");
  const helpBlock = `help[${help.length}]: ${help.join(" | ")}`;

  return [...header, "contents:", ...blocks, helpBlock].join("\n");
}

type Loader = (relPath: string, budget: number) => Promise<BundleEntry | null>;

function makeLoader(runtime: Awaited<ReturnType<typeof loadRuntime>>, projectId: string): Loader {
  return async (relPath, budget) => {
    try {
      if (!runtime.api.offline) {
        const { text, mime } = await runtime.api.getText(
          `/api/projects/${encodeURIComponent(projectId)}/raw/${encodePath(relPath)}`,
          { workspace: true },
        );
        if (!isTextualMime(mime)) {
          return { name: relPath, mime, size: Buffer.byteLength(text, "utf8"), content: null, binary: true };
        }
        if (Buffer.byteLength(text, "utf8") > budget) return null;
        return { name: relPath, mime, size: Buffer.byteLength(text, "utf8"), content: text, binary: false };
      }
      requireOfflineStore(runtime);
      const read = await runtime.offline.readTextFile(projectId, relPath);
      if (read == null) return null;
      const mime = kindToMime(read.kind);
      if (read.kind === "image" || read.kind === "video" || read.kind === "audio") {
        return { name: relPath, mime, size: Buffer.byteLength(read.text, "utf8"), content: null, binary: true };
      }
      if (Buffer.byteLength(read.text, "utf8") > budget) return null;
      return { name: relPath, mime, size: Buffer.byteLength(read.text, "utf8"), content: read.text, binary: false };
    } catch {
      return null;
    }
  };
}

async function defaultEntry(
  runtime: Awaited<ReturnType<typeof loadRuntime>>,
  projectId: string,
): Promise<string | null> {
  if (!runtime.api.offline) {
    const data = (await runtime.api.getJson(`/api/projects/${encodeURIComponent(projectId)}`, {
      workspace: true,
    })) as { project?: { metadata?: { entryFile?: string } } };
    if (typeof data?.project?.metadata?.entryFile === "string") return data.project.metadata.entryFile;
    const files = (await runtime.api.getJson(`/api/projects/${encodeURIComponent(projectId)}/files`, {
      workspace: true,
    })) as { files?: Array<{ name: string; kind?: string }> };
    return files.files?.find((file) => file.kind === "html")?.name ?? null;
  }
  requireOfflineStore(runtime);
  const project = (await runtime.offline.listProjects()).find((p) => p.id === projectId) ?? null;
  if (project?.entryFile) return project.entryFile;
  const manifests = await runtime.offline.artifactManifests(projectId);
  const complete = manifests.find((m) => m.status === "complete") ?? manifests[0];
  if (complete) return complete.entry;
  const files = await runtime.offline.listFiles(projectId);
  return files.find((file) => file.kind === "html")?.name ?? null;
}

async function listAllFiles(
  runtime: Awaited<ReturnType<typeof loadRuntime>>,
  projectId: string,
): Promise<string[]> {
  if (!runtime.api.offline) {
    const data = (await runtime.api.getJson(`/api/projects/${encodeURIComponent(projectId)}/files`, {
      workspace: true,
    })) as { files?: Array<{ name: string }> };
    return (data.files ?? []).map((file) => file.name);
  }
  requireOfflineStore(runtime);
  return (await runtime.offline.listFiles(projectId)).map((file) => file.name);
}

function usedBytes(entries: BundleEntry[]): number {
  return entries.reduce((sum, entry) => sum + (entry.content != null ? Buffer.byteLength(entry.content, "utf8") : 0), 0);
}

function entryMissing(entry: string, project: string): AxiError {
  return new AxiError(
    `entry file not found: ${entry} (project ${project})`,
    "NOT_FOUND",
    ["Run `open-design-axi files <id|name>` to list files"],
  );
}

function kindToMime(kind: string): string {
  switch (kind) {
    case "html": return "text/html";
    case "code": return "text/javascript";
    case "image": return "image/*";
    default: return "text/plain";
  }
}
