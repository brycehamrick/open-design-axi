/**
 * Single source of truth for the installable skill. `scripts/gen-skill.mjs`
 * renders SKILL.md from this content and `npm run skill:check` fails CI if
 * the committed skill drifts. Static only: no live state, `npx -y` command
 * forms so it works without a global install.
 */

export const SKILL_NAME = "open-design-axi";

export const SKILL_DESCRIPTION =
  "Operate OpenDesign from the shell - list projects, read and write design files, pull full artifact bundles, search, and drive generation runs (start/watch/cancel) through open-design-axi. Use whenever a task touches OpenDesign or the Open Design app: finding a project, pulling its HTML/CSS sources, editing a design file, or commissioning a generation run.";

export function skillBody(bin: string): string {
  const run = (args: string): string => `${bin} ${args}`;
  return `## What this gives you

A token-cheap, durable shell surface over a local OpenDesign daemon: TOON
output, 3-field list rows, combined views, and offline reads straight from
the data directory when the daemon is down. Mutations are gated behind
\`--confirm\`.

## Orientation

\`\`\`sh
${run("")}                      # live dashboard: daemon, active project, projects, recent runs
${run("status")}                # daemon health, discovery source, data dir, offline capability
${run("projects")}              # list projects (8-char id prefixes work as refs)
\`\`\`

\`<ref>\` everywhere accepts a project id prefix, an exact name, or a unique
name substring; omit it (or pass \`active\`) to target the project open in
the app.

## Reading designs

\`\`\`sh
${run("project <ref>")}         # entry file, file/byte totals, preview URL — one call
${run("files <ref>")}           # file listing with byte total (--glob '*.html')
${run("read <ref> <path>")}     # 500-line windowed read (--offset/--limit/--full)
${run("artifact <ref>")}        # full bundle: entry + referenced siblings (BFS)
${run("search <ref> <query>")}  # content search (--glob, --max)
\`\`\`

\`artifact\` follows HTML/CSS/JS references (depth 3, 1.5 MB budget default).
\`--include shallow|all\`, \`--entry <path>\`, \`--max-bytes <n>\`, \`--full\`
control the bundle.

## Writing files

\`\`\`sh
cat index.html | ${run("write <ref> index.html --stdin --confirm")}
${run("write <ref> assets/logo.svg --file ./logo.svg --confirm")}
${run("delete <ref> draft.html --confirm")}
\`\`\`

Writes go through the daemon so version capture and artifact manifests stay
consistent. \`--overwrite\` replaces existing files; \`--artifact\` registers
the file as a design artifact (manifest inferred for html/deck/md/svg).

## Generation runs

\`\`\`sh
${run("run start <ref> --prompt \"<brief>\" --confirm")}   # daemon spawns its own agent
${run("run watch <run-id>")}              # poll loop to terminal (--timeout 1800 for long runs)
${run("run view <run-id> --full")}        # one-shot status, artifacts, errors
${run("run cancel <run-id> --confirm")}
${run("runs <ref> --status failed")}      # history
\`\`\`

Pick the inputs first: \`${run("skills")}\`, \`${run("agents")}\`,
\`${run("design-systems")}\`, \`${run("plugins")}\`. Typical runs take 5-30
minutes; \`watch\` prints compact interim status lines and a final block
with artifact paths and a preview URL.

## Projects

\`\`\`sh
${run("projects create --name \"<name>\" --design-system <id> --confirm")}
${run("projects delete <ref> --confirm")}   # irreversible: row + files on disk
\`\`\`

## Offline mode

When the daemon is unreachable, every read command falls back to the local
data directory (\`OD_DATA_DIR\` or the platform default), reading project
files, sqlite project names, and run state from disk. Writes and runs then
fail with a structured \`DAEMON_UNAVAILABLE\` error and recovery hints.

## Conventions

- Output is TOON; timestamps are unix seconds; ids print as 8-char prefixes.
- Exit codes: 0 success/no-op, 1 runtime error, 2 usage error (missing
  \`--confirm\`, unknown flag, bad values).
- Errors are structured on stdout with \`help[]\` next steps.
- \`--help\` on any command prints its concise reference.
- Auth: loopback needs nothing; set \`OD_API_TOKEN\` when the daemon requires
  a token. Override discovery with \`--daemon-url\`/\`OD_DAEMON_URL\`.
`;
}
