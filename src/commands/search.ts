import { parseCommandArgs } from "../args.js";
import { shortId } from "../format.js";
import { compileGlob } from "../offline.js";
import { resolveProject } from "../project.js";
import { loadRuntime, requireOfflineStore } from "./shared.js";

/**
 * `search <id|name> <query>` — case-insensitive substring search across a
 * project's textual files. Mirrors the daemon endpoint online
 * (`/api/projects/:id/search?q=`) and greps the local directory offline.
 */

export async function searchCommand(argv: string[]): Promise<Record<string, unknown>> {
  const { positionals, flags } = parseCommandArgs(
    argv,
    { string: ["glob"], number: ["max"], defaults: { max: 50 } },
    [
      { name: "project" },
      { name: "query", required: true },
    ],
    "search",
  );
  const runtime = await loadRuntime(flags);
  const resolved = await resolveProject(positionals[0], { api: runtime.api, offline: runtime.offline });
  const query = positionals[1]!;
  const max = flags.max as number;

  let matches: Array<{ file: string; line: number; snippet: string }>;
  if (!runtime.api.offline) {
    const params = new URLSearchParams({ q: query, max: String(Math.min(max, 1000)) });
    const glob = typeof flags.glob === "string" && flags.glob.length > 0 ? flags.glob : null;
    if (glob) params.set("pattern", glob);
    const data = (await runtime.api.getJson(
      `/api/projects/${encodeURIComponent(resolved.id)}/search?${params.toString()}`,
      { workspace: true },
    )) as { matches?: Array<{ file: string; line: number; snippet: string }> };
    matches = data.matches ?? [];
  } else {
    requireOfflineStore(runtime);
    const glob = typeof flags.glob === "string" && flags.glob.length > 0 ? flags.glob : null;
    matches = await runtime.offline.search(resolved.id, query, glob, max);
  }

  if (matches.length === 0) {
    return {
      query,
      matches: `0 matches for "${query}" in ${resolved.name ?? shortId(resolved.id)}`,
      help: ['Try a shorter query, or `open-design-axi search <id|name> <query> --glob "*.html"`'],
    };
  }

  const shown = matches.slice(0, max);
  return {
    query,
    count: matches.length,
    matches: shown.map((m) => ({ file: m.file, line: m.line, snippet: m.snippet })),
    ...(shown.length < matches.length
      ? { note: `showing ${shown.length} of ${matches.length} — raise --max for more` }
      : {}),
    help: [`Run \`open-design-axi read ${shortId(resolved.id) ?? "<id>"} <path>\` to view a hit in context`],
  };
}
