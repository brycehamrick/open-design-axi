/**
 * Concise per-command help (AXI principle 10). Each entry documents
 * arguments, flags with defaults, and 2-3 examples — focused on the
 * requested command only.
 */

export const TOP_LEVEL_HELP = `open-design-axi — browse and operate OpenDesign projects, files, and generation runs from the shell

usage: open-design-axi <command> [args] [flags]

commands:
  (no command)     live dashboard: daemon state, active project, projects, recent runs
  status           daemon health, discovery source, data dir, offline capability
  projects         list projects (--fields, --limit); create/delete behind --confirm
  project <ref>    combined detail: entry file, aggregates, preview URL
  files <ref>      project file listing (--glob filter)
  read <ref> <p>   windowed file read (--offset/--limit/--full)
  artifact <ref>   full design bundle: entry + referenced siblings (--include, --max-bytes)
  search <ref> <q> case-insensitive content search (--glob, --max)
  write <ref> <p>  write a file from --stdin/--file (--confirm, --overwrite, --artifact)
  delete <ref> <p> delete a file (--confirm)
  runs [ref]       generation run history (--status filter)
  run start|view|watch|cancel   commission and follow generation runs
  skills           skill catalog (ids usable with run start --skill)
  agents           agent runtimes (ids usable with run start --agent)
  plugins          installed plugins
  design-systems   design system catalog
  setup            install/remove session-start ambient context hooks

global flags (all commands):
  --daemon-url <url>   explicit daemon base URL (default: discovered)
  --data-dir <path>    OpenDesign data directory for offline reads
  --help               per-command reference
  -v | -V | --version  print version

<ref> accepts a project id (8-char prefix works), an exact name, or a unique
name substring; omitted or "active" resolves the project open in the app.

auth: loopback desktop installs need no token; set OD_API_TOKEN when the
daemon requires one. Offline reads use the local data directory (OD_DATA_DIR
or the platform default) whenever the daemon is down.`;

const HELP: Record<string, string> = {
  status: `command: status
description: daemon health, URL discovery source, data dir, offline capability
flags:
  --daemon-url <url>   explicit daemon base URL
  --data-dir <path>    data directory for offline reads
examples:
  open-design-axi status
  open-design-axi status --daemon-url http://127.0.0.1:7456`,

  projects: `command: projects [create|delete] [args] [flags]
description: list, create, or delete projects (create/delete need --confirm)
list flags:
  --fields <a,b,c>   extra/alternate row fields (id, name, updated, created, skill, design_system, full_id)
  --limit <n>        cap rows, default 50; 0 = all
create flags:
  --name <n>         required project name
  --skill <id>       bind a skill
  --design-system <id> bind a design system
  --confirm          required to apply
delete flags:
  --confirm          required (irreversible: removes DB row + files on disk)
examples:
  open-design-axi projects
  open-design-axi projects --limit 0 --fields id,name,updated
  open-design-axi projects create --name "landing-page" --design-system linear --confirm
  open-design-axi projects delete 1a2b3c4d --confirm`,

  project: `command: project [<ref>]
description: combined project detail — entry file, file/byte aggregates, preview URL
args:
  <ref>   project id/name; omitted or "active" uses the project open in the app
examples:
  open-design-axi project active
  open-design-axi project landing-page`,

  files: `command: files [<ref>]
description: list a project's files with pre-computed byte total
flags:
  --glob <pattern>   filter by name, e.g. --glob '*.html'
  --fields <a,b,c>   extra fields (name, size, kind, mtime)
  --limit <n>        cap rows, default 100; 0 = all
examples:
  open-design-axi files active
  open-design-axi files 1a2b3c4d --glob '*.html'`,

  read: `command: read [<ref>] <path>
description: windowed file read — 500 lines by default with a next-window hint
flags:
  --offset <n>   first line (0-based), default 0
  --limit <n>    lines per window, default 500; 0 = unlimited
  --full         disable windowing entirely
examples:
  open-design-axi read active index.html
  open-design-axi read 1a2b3c4d index.html --offset 500
  cat badge.svg | open-design-axi read active badge.svg --full | head -20`,

  artifact: `command: artifact [<ref>]
description: pull a full design bundle — entry file plus every referenced sibling
flags:
  --entry <path>     explicit entry file (default: active file / project entry / first html)
  --include <mode>   auto (BFS from entry), all (every file), shallow (entry only); default auto
  --max-bytes <n>    byte budget, default 1500000
  --full             skip per-file content truncation (20k chars default)
examples:
  open-design-axi artifact active
  open-design-axi artifact landing-page --include all --max-bytes 3000000
  open-design-axi artifact 1a2b3c4d --entry index.html --full`,

  search: `command: search [<ref>] <query>
description: case-insensitive substring search across a project's textual files
flags:
  --glob <pattern>   filter by file name, e.g. --glob '*.css'
  --max <n>          cap matches, default 50
examples:
  open-design-axi search active "hero section"
  open-design-axi search 1a2b3c4d "#0f172a" --glob '*.css'`,

  write: `command: write [<ref>] <path>
description: write a project file through the daemon (version capture + manifests stay consistent)
flags:
  --stdin        read content from stdin
  --file <path>  read content from a local file
  --overwrite    allow replacing an existing file (409 without it)
  --artifact     register as a design artifact (manifest inferred for html/deck/md/svg)
  --confirm      required to apply
examples:
  cat index.html | open-design-axi write active index.html --stdin --confirm
  open-design-axi write landing-page assets/logo.svg --file ./logo.svg --confirm`,

  delete: `command: delete <ref> <path>
description: delete a project file (irreversible — removes version history too)
flags:
  --confirm   required to apply
examples:
  open-design-axi delete landing-page draft.html --confirm`,

  runs: `command: runs [<ref>]
description: generation run history, newest first (offline: last persisted state)
flags:
  --status <s>    filter: queued, running, succeeded, failed, canceled
  --fields <a,b>  extra fields (id, status, agent, project, updated, error, full_id)
  --limit <n>     cap rows, default 20; 0 = all
examples:
  open-design-axi runs active
  open-design-axi runs --status failed --limit 5`,

  run: `command: run <start|view|watch|cancel> [args] [flags]
description: commission and follow generation runs (the daemon spawns its own agent)
start flags:
  --prompt <p>    required brief for the run
  --skill <id>    skill to apply (see \`open-design-axi skills\`)
  --plugin <id>   plugin workflow to run
  --agent <id>    agent runtime (see \`open-design-axi agents\`)
  --model <id>    model override
  --confirm       required (runs spend agent tokens; typical run 5-30 min)
view flags:
  --full          untruncated error text
watch flags:
  --timeout <s>   watch window, default 600s
  --interval <s>  poll interval, default 15s (min 3)
cancel flags:
  --confirm       required unless the run already ended (then no-op)
examples:
  open-design-axi run start landing-page --prompt "Redesign the hero with the linear design system" --confirm
  open-design-axi run watch 3fa8c2b1
  open-design-axi run view 3fa8c2b1-... --full
  open-design-axi run cancel 3fa8c2b1 --confirm`,

  skills: `command: skills
description: skill catalog — ids usable with \`run start --skill\`
flags:
  --fields <a,b>   extra fields (id, mode, name, description, surface, category, source, example_prompt)
  --limit <n>      cap rows, default 50; 0 = all
examples:
  open-design-axi skills
  open-design-axi skills --limit 0 --fields id,mode,description`,

  agents: `command: agents
description: agent runtimes available to the daemon — ids usable with \`run start --agent\`
flags:
  --fields <a,b>   extra fields (id, available, version, name, auth_status, models_source, path)
  --limit <n>      cap rows, default 30; 0 = all
examples:
  open-design-axi agents
  open-design-axi agents --fields id,available,name`,

  plugins: `command: plugins
description: installed plugins — workflows runnable via \`run start --plugin\`
flags:
  --fields <a,b>   extra fields (id, title, version, source_kind, installed_at)
  --limit <n>      cap rows, default 50; 0 = all
examples:
  open-design-axi plugins`,

  "design-systems": `command: design-systems
description: design system catalog — bind one at project creation with --design-system
flags:
  --fields <a,b>   extra fields (id, title, category, summary, source, status, surface)
  --limit <n>      cap rows, default 50; 0 = all
examples:
  open-design-axi design-systems
  open-design-axi design-systems --fields id,title,summary --limit 20`,

  setup: `command: setup [--remove]
description: install (or remove) session-start ambient context hooks for Claude Code, Codex, and OpenCode
flags:
  --remove   uninstall the managed hooks instead
examples:
  open-design-axi setup
  open-design-axi setup --remove`,
};

export function commandHelp(command: string): string | null | undefined {
  return HELP[command];
}
