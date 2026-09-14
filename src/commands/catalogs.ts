import { AxiError } from "axi-sdk-js";
import { parseCommandArgs } from "../args.js";
import { selectRows, limitHelpLine } from "../format.js";
import { loadRuntime, requireOnline } from "./shared.js";

/**
 * Catalog commands — `skills`, `agents`, `plugins`, `design-systems`.
 * Read-only daemon listings with minimal default schemas. The daemon
 * exposes large catalogs (hundreds of skills/plugins), so counts + limits
 * matter; `--fields` pulls extra columns on demand.
 */

interface CatalogSpec {
  command: string;
  path: string;
  key: string;
  defaults: string[];
  fields: string[];
  limit: number;
  rowMapper: (item: Record<string, unknown>) => Record<string, unknown>;
}

const CATALOGS: Record<string, CatalogSpec> = {
  skills: {
    command: "skills",
    path: "/api/skills",
    key: "skills",
    defaults: ["id", "mode"],
    fields: ["id", "mode", "name", "description", "surface", "category", "source", "example_prompt"],
    limit: 50,
    rowMapper: (item) => ({
      id: item.id,
      mode: item.mode,
      name: item.displayName ?? item.name,
      description: clip(String(item.description ?? "")),
      surface: item.surface,
      category: item.category,
      source: item.source,
      example_prompt: item.examplePrompt,
    }),
  },
  agents: {
    command: "agents",
    path: "/api/agents",
    key: "agents",
    defaults: ["id", "available", "version"],
    fields: ["id", "available", "version", "name", "auth_status", "models_source", "path"],
    limit: 30,
    rowMapper: (item) => ({
      id: item.id,
      available: item.available,
      version: item.version,
      name: item.name,
      auth_status: item.authStatus,
      models_source: item.modelsSource,
      path: item.path,
    }),
  },
  plugins: {
    command: "plugins",
    path: "/api/plugins",
    key: "plugins",
    defaults: ["id", "title", "version"],
    fields: ["id", "title", "version", "source_kind", "installed_at"],
    limit: 50,
    rowMapper: (item) => ({
      id: item.id,
      title: item.title,
      version: item.version,
      source_kind: item.sourceKind,
      installed_at: item.installedAt ? Math.floor(Number(item.installedAt) / 1000) : null,
    }),
  },
  "design-systems": {
    command: "design-systems",
    path: "/api/design-systems",
    key: "designSystems",
    defaults: ["id", "title", "category"],
    fields: ["id", "title", "category", "summary", "source", "status", "surface"],
    limit: 50,
    rowMapper: (item) => ({
      id: item.id,
      title: item.title,
      category: item.category,
      summary: clip(String(item.summary ?? "")),
      source: item.source,
      status: item.status,
      surface: item.surface,
    }),
  },
};

function clip(text: string, limit = 140): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export async function catalogCommand(command: string, argv: string[]): Promise<Record<string, unknown>> {
  const spec = CATALOGS[command];
  if (spec == null) throw new Error(`unknown catalog: ${command}`);
  const { flags } = parseCommandArgs(
    argv,
    { string: ["fields"], number: ["limit"], defaults: { limit: spec.limit } },
    [],
    command,
  );
  const runtime = await loadRuntime(flags);
  requireOnline(runtime, `list ${command}`);

  const data = (await runtime.api.getJson(spec.path, { workspace: command === "design-systems" })) as Record<
    string,
    Array<Record<string, unknown>> | undefined
  >;
  const items = data?.[spec.key] ?? [];
  if (items.length === 0) {
    return { [spec.key]: `0 ${command.replace("-", " ")} found` };
  }

  const selection = selectRows(
    items.map((item) => ({ raw: item })),
    spec.defaults,
    { fields: flags.fields as string | undefined, limit: flags.limit as number | undefined },
    spec.fields,
    (row) => spec.rowMapper(row.raw as Record<string, unknown>),
  );

  const out: Record<string, unknown> = {
    count: selection.total,
    [spec.key]: selection.rows,
  };
  const hint = limitHelpLine(command, selection.shown, selection.total, flags.limit as number);
  const next: string[] = [];
  if (hint) next.push(hint);
  if (command === "skills") {
    next.push('Use one: `open-design-axi run start <id|name> --skill <skill-id> --prompt "<brief>" --confirm`');
  }
  if (command === "agents") {
    next.push('Use one: `open-design-axi run start <id|name> --agent <agent-id> --prompt "<brief>" --confirm`');
  }
  if (command === "design-systems") {
    next.push('Bind one: `open-design-axi projects create --name "<name>" --design-system <id> --confirm`');
  }
  if (next.length > 0) out.help = next.slice(0, 2);
  return out;
}

export function catalogCommands(): Record<string, (argv: string[]) => Promise<Record<string, unknown>>> {
  const out: Record<string, (argv: string[]) => Promise<Record<string, unknown>>> = {};
  for (const command of Object.keys(CATALOGS)) {
    out[command] = async (argv: string[]) => catalogCommand(command, argv);
  }
  return out;
}
