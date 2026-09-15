import { AxiError } from "axi-sdk-js";
import { parseCommandArgs } from "../args.js";
import { selectRows, shortId, limitHelpLine } from "../format.js";
import { compileGlob } from "../offline.js";
import { resolveProject } from "../project.js";
import { loadRuntime, requireOfflineStore } from "./shared.js";
import { formatBytes } from "./project.js";

/**
 * `files <id|name>` — project file listing. Default schema
 * {name,size,kind}; `--glob *.html` filters by name; byte total is
 * pre-computed. Works online and offline.
 */

const LIST_FIELDS = ["name", "size", "kind", "mtime"];

interface FileRow {
  name: string;
  size: number;
  kind: string;
  mtime: number | null;
}

export async function filesCommand(argv: string[]): Promise<Record<string, unknown>> {
  const { positionals, flags } = parseCommandArgs(
    argv,
    { string: ["fields", "glob"], number: ["limit"], defaults: { limit: 100 } },
    [{ name: "project" }],
    "files",
  );
  const runtime = await loadRuntime(flags);
  const resolved = await resolveProject(positionals[0], { api: runtime.api, offline: runtime.offline });
  const pattern = typeof flags.glob === "string" && flags.glob.length > 0 ? compileGlob(flags.glob) : null;

  const rows: FileRow[] = [];
  if (!runtime.api.offline) {
    const data = (await runtime.api.getJson(`/api/projects/${encodeURIComponent(resolved.id)}/files`, {
      workspace: true,
    })) as {
      files?: Array<{ name: string; size: number; kind?: string; mtime?: number }>;
    };
    for (const file of data.files ?? []) {
      rows.push({
        name: file.name,
        size: file.size ?? 0,
        kind: file.kind ?? "text",
        mtime: file.mtime ?? null,
      });
    }
  } else {
    requireOfflineStore(runtime);
    for (const file of await runtime.offline.listFiles(resolved.id)) {
      rows.push({ name: file.name, size: file.size, kind: file.kind, mtime: file.mtime });
    }
  }

  const filtered = pattern ? rows.filter((row) => pattern.test(row.name)) : rows;
  if (filtered.length === 0) {
    return {
      files: `0 files${pattern ? " matching --glob" : ""} in ${resolved.name ?? shortId(resolved.id)}`,
      help: ['Run `open-design-axi write <id|name> <path> --stdin --confirm` to add a file'],
    };
  }

  const totalBytes = filtered.reduce((sum, row) => sum + row.size, 0);
  const selection = selectRows(
    filtered,
    ["name", "size", "kind"],
    { fields: flags.fields as string | undefined, limit: flags.limit as number | undefined },
    LIST_FIELDS,
    (row) => ({
      name: row.name,
      size: row.size,
      kind: row.kind,
      mtime: row.mtime ? Math.floor(row.mtime / 1000) : null,
    }),
  );

  const out: Record<string, unknown> = {
    project: resolved.name ?? shortId(resolved.id),
    count: selection.total,
    bytes: formatBytes(totalBytes),
    files: selection.rows,
  };
  const hint = limitHelpLine("files", selection.shown, selection.total, flags.limit as number);
  out.help = [
    ...(hint ? [hint] : []),
    `Run \`open-design-axi read ${resolved.displayRef} <path>\` to view a file`,
  ];
  return out;
}
