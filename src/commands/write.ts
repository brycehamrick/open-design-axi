import { readFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import { parseCommandArgs } from "../args.js";
import { safeRelPath } from "../offline.js";
import { shortId } from "../format.js";
import { resolveProject } from "../project.js";
import { loadRuntime, requireOnline, requireConfirm } from "./shared.js";
import { encodePath, formatBytes } from "./project.js";

/**
 * `write` and `delete` — project file mutations. Both are gated behind
 * --confirm (network mutations print a would-change preview first), writes
 * refuse to clobber without --overwrite, and everything routes through the
 * daemon so version capture and artifact manifests stay consistent.
 * Offline writes are intentionally unsupported in Phase A.
 */

export async function writeCommand(argv: string[]): Promise<Record<string, unknown>> {
  const { positionals, flags } = parseCommandArgs(
    argv,
    { string: ["file"], boolean: ["confirm", "overwrite", "artifact", "stdin"] },
    [
      { name: "project" },
      { name: "path", required: true },
    ],
    "write",
  );
  const relPath = safeRelPath(positionals[1] ?? "");
  if (relPath == null) {
    throw new AxiError(
      `invalid path "${positionals[1]}" (absolute paths and ".." are not allowed)`,
      "VALIDATION_ERROR",
      ["Use a project-relative path like `index.html` or `assets/logo.svg`"],
    );
  }

  const hasSource = flags.stdin === true || (typeof flags.file === "string" && flags.file.length > 0);
  if (!hasSource) {
    throw new AxiError(
      "provide content via --stdin (pipe) or --file <path>",
      "VALIDATION_ERROR",
      ['Example: cat index.html | open-design-axi write <id|name> index.html --stdin --confirm'],
    );
  }

  const runtime = await loadRuntime(flags);
  requireOnline(runtime, "write project files");
  const resolved = await resolveProject(positionals[0], { api: runtime.api, offline: runtime.offline });

  let content: string;
  if (flags.stdin === true) {
    try {
      content = readFileSync(process.stdin.fd, "utf8");
    } catch (error) {
      throw new AxiError(
        `could not read content from stdin: ${error instanceof Error ? error.message : String(error)}`,
        "VALIDATION_ERROR",
        ["Pipe content in (`cat file.html | open-design-axi write ... --stdin`), or use --file <path>"],
      );
    }
  } else {
    try {
      content = readFileSync(flags.file as string, "utf8");
    } catch (error) {
      throw new AxiError(
        `cannot read --file ${String(flags.file)}: ${error instanceof Error ? error.message : String(error)}`,
        "VALIDATION_ERROR",
        ["Pass a readable local file path, or use --stdin to pipe content"],
      );
    }
  }

  requireConfirm(
    {
      project: resolved.name ?? shortId(resolved.id),
      path: relPath,
      size: formatBytes(Buffer.byteLength(content, "utf8")),
      overwrite: flags.overwrite === true,
      artifact: flags.artifact === true,
    },
    `write ${positionals[0] ?? ""} ${relPath}`.replace(/\s+/g, " ").trim(),
    flags.confirm,
  );

  const body: Record<string, unknown> = {
    name: relPath,
    content,
    encoding: "utf8",
    overwrite: flags.overwrite === true,
  };
  if (flags.artifact === true) body.artifact = true;

  const result = (await runtime.api.postJson(
    `/api/projects/${encodeURIComponent(resolved.id)}/files`,
    body,
    { workspace: true },
  )) as { file?: { name: string; size?: number }; version?: { version?: number } | null };

  const out: Record<string, unknown> = {
    written: result?.file?.name ?? relPath,
    project: resolved.name ?? shortId(resolved.id),
    size: formatBytes(Buffer.byteLength(content, "utf8")),
  };
  if (result?.version?.version != null) out.version_captured = result.version.version;
  if (flags.artifact === true) out.artifact = true;
  out.help = [
    `Run \`open-design-axi read ${shortId(resolved.id) ?? "<id>"} ${relPath}\` to verify the write`,
    `Preview: ${runtime.api.baseUrl}/api/projects/${encodeURIComponent(resolved.id)}/raw/${encodePath(relPath)}`,
  ];
  return out;
}

export async function deleteFileCommand(argv: string[]): Promise<Record<string, unknown>> {
  const { positionals, flags } = parseCommandArgs(
    argv,
    { boolean: ["confirm"] },
    [
      { name: "project", required: true },
      { name: "path", required: true },
    ],
    "delete",
  );
  const relPath = safeRelPath(positionals[1] ?? "");
  if (relPath == null) {
    throw new AxiError(
      `invalid path "${positionals[1]}" (absolute paths and ".." are not allowed)`,
      "VALIDATION_ERROR",
      ["Use a project-relative path"],
    );
  }

  const runtime = await loadRuntime(flags);
  requireOnline(runtime, "delete project files");
  const resolved = await resolveProject(positionals[0], { api: runtime.api, offline: runtime.offline });

  requireConfirm(
    {
      project: resolved.name ?? shortId(resolved.id),
      path: relPath,
      irreversible: "removes the file and its version history",
    },
    `delete ${positionals[0]} ${relPath}`,
    flags.confirm,
  );

  await runtime.api.deleteJson(
    `/api/projects/${encodeURIComponent(resolved.id)}/raw/${encodePath(relPath)}`,
    { workspace: true },
  );
  return {
    deleted: relPath,
    project: resolved.name ?? shortId(resolved.id),
  };
}
