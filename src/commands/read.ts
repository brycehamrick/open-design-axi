import { AxiError } from "axi-sdk-js";
import { parseCommandArgs } from "../args.js";
import { safeRelPath } from "../offline.js";
import { shortId } from "../format.js";
import { resolveProject } from "../project.js";
import { loadRuntime, requireOfflineStore } from "./shared.js";
import { encodePath } from "./project.js";

/**
 * `read <id|name> <path>` — windowed file read. Default window is 500 lines
 * with a next-window hint (principle 3); `--offset`/`--limit` page through
 * and `--full` disables windowing. Binary files report their size instead
 * of dumping bytes.
 */

export const DEFAULT_READ_LINES = 500;

export async function readCommand(argv: string[]): Promise<string> {
  const { positionals, flags } = parseCommandArgs(
    argv,
    { boolean: ["full"], number: ["offset", "limit"], defaults: { offset: 0, limit: DEFAULT_READ_LINES } },
    [
      { name: "project" },
      { name: "path", required: true },
    ],
    "read",
  );
  const relPath = safeRelPath(positionals[1] ?? "");
  if (relPath == null) {
    throw new AxiError(
      `invalid path "${positionals[1]}" (absolute paths and ".." are not allowed)`,
      "VALIDATION_ERROR",
      ["Use a project-relative path like `index.html` or `assets/logo.svg`"],
    );
  }

  const runtime = await loadRuntime(flags);
  const resolved = await resolveProject(positionals[0], { api: runtime.api, offline: runtime.offline });

  let text: string;
  let mime: string;
  if (!runtime.api.offline) {
    const result = await runtime.api.getText(
      `/api/projects/${encodeURIComponent(resolved.id)}/raw/${encodePath(relPath)}`,
      { workspace: true },
    );
    text = result.text;
    mime = result.mime;
  } else {
    requireOfflineStore(runtime);
    const result = await runtime.offline.readTextFile(resolved.id, relPath);
    if (result == null) {
      throw fileNotFound(relPath, resolved.name ?? resolved.id);
    }
    text = result.text;
    mime = kindToMime(result.kind);
  }

  if (looksBinary(text, mime)) {
    return [
      `file: ${relPath}`,
      `project: ${resolved.name ?? shortId(resolved.id)}`,
      `binary: true (${Buffer.byteLength(text, "utf8")} bytes as text; use the daemon raw URL or the app to export)`,
    ].join("\n");
  }

  const lines = text.split("\n");
  const total = lines.length;
  const full = flags.full === true;
  const offset = Math.max(0, flags.offset as number);
  const limit = flags.limit as number;
  const windowEnd = full ? total : limit === 0 ? total : Math.min(total, offset + limit);
  const slice = lines.slice(offset, windowEnd);

  const header = [
    `file: ${relPath}`,
    `project: ${resolved.name ?? shortId(resolved.id)}`,
    `lines: ${offset + 1}-${windowEnd} of ${total}`,
  ];
  if (!full && windowEnd < total) {
    header.push(`window: use --offset ${windowEnd} for the next window, or --full for all ${total} lines`);
  }
  if (total > 2000 && full) {
    header.push(`note: ${total} lines — consider piping through head/grep to trim output`);
  }
  return `${header.join("\n")}\n---\n${slice.join("\n")}`;
}

function fileNotFound(relPath: string, project: string): AxiError {
  return new AxiError(
    `file not found: ${relPath} (project ${project})`,
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

/** Binary payloads surface as replacement-char heavy text; detect that. */
function looksBinary(text: string, mime: string): boolean {
  if (/^(?:image|video|audio|font)\//i.test(mime) && !/svg/i.test(mime)) return true;
  if (text.length === 0) return false;
  const sample = text.slice(0, 2000);
  let suspicious = 0;
  for (const char of sample) {
    if (char === "\uFFFD" || (char.charCodeAt(0) < 9 && char !== "\t")) suspicious++;
  }
  return suspicious / sample.length > 0.05;
}
