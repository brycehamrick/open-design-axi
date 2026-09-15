# open-design-axi

AXI-compliant CLI for [OpenDesign](https://github.com/nexu-io/open-design) — browse and operate design projects, files, artifacts, and generation runs from the shell, with offline reads straight from the local data directory when the daemon is down. Spec `axi/1.0-2026-07`, Node.js 22.5+, TypeScript, zero-database runtime deps.

Phase A exposes the verified daemon surface: project/file reads and writes, artifact bundling, search, project create/delete, and the generation-run loop (start/watch/cancel). It talks to the daemon's HTTP API directly — the same API the official MCP server wraps — and adds a filesystem fallback for reads.

## Why an AXI for OpenDesign

The default agent integration is a stdio MCP server. Two problems in practice:

- **Durability.** The MCP client resolves the daemon through an env chain that goes stale on desktop installs with dynamic ports; when discovery fails, every tool call dies even though the daemon is healthy. `open-design-axi` resolves the daemon through the full chain **plus a sidecar-socket scan** that finds the live daemon directly, and when nothing answers, read commands fall back to the on-disk data directory (`projects/`, `app.sqlite`, `runs/*/state.json`). The MCP server being down stops being your problem.
- **Tokens.** ~22 MCP tool schemas live in context all session. This CLI ships none, emits TOON rows with 3–4 fields, prints 8-char id prefixes, folds multi-step flows (`project`, `artifact`, `run watch`) into single calls, and pre-computes the aggregates agents otherwise round-trip for.

## Install

```
npm install -g open-design-axi
open-design-axi --help
```

Without a global install, run `npx -y open-design-axi <command>`.

## Authentication and discovery

Loopback desktop installs serve the daemon unauthenticated — nothing to configure. When the daemon requires a token (e.g. Docker deployments), supply it only through the environment:

```
export OD_API_TOKEN="<daemon API token>"    # sent as Authorization: Bearer
```

`OD_API_TOKEN` is the daemon's own documented variable (`Authorization: Bearer`); it is never accepted on argv and never echoed in output.

Daemon URL discovery, in order: `--daemon-url` flag → `OD_DAEMON_URL` env → `OD_SIDECAR_CLIENT_ENDPOINT` sidecar IPC → scan of `<tmpdir>/od-sidecar-<uid>/*.sock` (each socket answers a newline-JSON status frame whose `result.url` is the daemon base URL; when several are live, the one whose `/api/daemon/status` port matches its URL wins over web proxies) → default `http://127.0.0.1:7456`. Every candidate is verified against `GET /api/daemon/status` before use.

Offline reads resolve the data directory from `OD_DATA_DIR` or the platform default (`~/Library/Application Support/Open Design/namespaces/<ns>/data` on macOS, `%APPDATA%/Open Design/...` on Windows, `$XDG_CONFIG_HOME/Open Design/...` on Linux), preferring the `release-stable` namespace. Project display names come from `app.sqlite` (read-only, via `node:sqlite`); projects and run state come straight from disk.

## Commands

```
# Orientation
open-design-axi                       # live dashboard: daemon, active project, projects, recent runs
open-design-axi status                # daemon health, discovery source, data dir, offline capability

# Projects
open-design-axi projects              # count + {id,name,updated} rows (--fields, --limit 0)
open-design-axi projects create --name "landing-page" --design-system linear --confirm
open-design-axi projects delete 1a2b3c4d --confirm          # irreversible
open-design-axi project <ref>         # entry file, totals, preview URL — one call

# Files and artifacts
open-design-axi files <ref> --glob '*.html'
open-design-axi read <ref> index.html --offset 500
open-design-axi artifact <ref>        # entry + every referenced sibling (BFS, 1.5 MB budget)
open-design-axi artifact <ref> --include all --max-bytes 3000000
open-design-axi search <ref> "hero section" --glob '*.css'

# Writes (through the daemon; version capture stays consistent)
cat index.html | open-design-axi write <ref> index.html --stdin --confirm
open-design-axi write <ref> assets/logo.svg --file ./logo.svg --confirm
open-design-axi write <ref> index.html --stdin --artifact --confirm   # register as artifact
open-design-axi delete <ref> draft.html --confirm
# Note: the daemon sanitizes leading-dot path segments (".x.html" → "_x.html").
# `write` prints the sanitized name as `written` (plus `requested` when it
# differs) and points help/preview URLs at it — always use the returned name.

# Generation runs (the daemon spawns its own agent; 5–30 min typical)
open-design-axi run start <ref> --prompt "Redesign the hero" --skill deck-swiss --confirm
open-design-axi run watch <run-id> --timeout 1800
open-design-axi run view <run-id> --full
open-design-axi run cancel <run-id> --confirm
open-design-axi runs <ref> --status failed

# Catalogs and ambient context
open-design-axi skills | agents | plugins | design-systems
open-design-axi setup                 # install SessionStart hooks (Claude Code, Codex, OpenCode)
open-design-axi setup --remove
```

`<ref>` accepts a project id (the 8-char prefix list views print — this works for slug ids like `aurora-site-…` as well as uuids), an exact name, or a unique name substring; omitted or `active` resolves the project open in the app. An ambiguous prefix/substring fails with `AMBIGUOUS` and lists the matching projects. Help lines always print a paste-safe ref: the 8-char prefix when it resolves uniquely, otherwise the full id. Every command takes the globals `--daemon-url` and `--data-dir`. `--help` on any command prints its concise reference.

## Safety gate

Every network mutation requires `--confirm` and prints a would-change preview first: `projects create`, `projects delete`, `write`, `delete`, `run start`, `run cancel`. The gate authorizes one invocation only; there are no prompts and no remembered consent. Missing confirmation and invalid input fail before any network request. Reads are ungated. Canceling an already-terminal run is an idempotent no-op (exit 0).

## Output and exit codes

Compact TOON is the default on stdout; errors are structured TOON with `help[]` next steps on stdout.

| Code | Meaning |
| --- | --- |
| `0` | Success, empty result, or idempotent no-op |
| `1` | Runtime error (daemon unreachable, API failure, file missing) |
| `2` | Usage error (unknown flag, missing argument, missing `--confirm`) |

Unknown flags are rejected by name with the command's valid flag list inline. `-v`/`-V`/`--version` answer before the command graph loads.

## Session hooks and skill

`open-design-axi setup` installs a managed SessionStart hook for Claude Code, Codex, and OpenCode that runs the content-first home view at session start (explicit opt-in, idempotent, path-repairing). An installable skill ships at [`skills/open-design-axi/SKILL.md`](skills/open-design-axi/SKILL.md) — generated from the same source as the CLI's guidance, guarded by `npm run skill:check`:

```
npx skills add brycehamrick/open-design-axi
```

Install the hook or the skill, not both — they solve the same discovery problem.

## Development

```
npm install
npm test            # vitest — mocked HTTP + fixture data dir, no daemon or secrets needed
npm run typecheck
npm run skill:check
```

## UNRESOLVED / intentionally not implemented

- **Offline writes.** Files could be written directly into `projects/<id>/` and reconciled by the daemon's watcher, but version capture and artifact manifests would drift. Phase A routes all writes through the daemon and fails structured (`DAEMON_UNAVAILABLE`) when it is down.
- **Brief collection.** The MCP `collect_brief`/`confirm_brief` interactive card flow is not replicated; `run start --prompt` is the non-interactive equivalent.
- **Cloud/Vela login tools.** `start_vela_login`/`get_vela_login_status` are app-embedded flows; when a run fails with `failure_action: recharge`, the CLI points back at the app instead.
- **SSE run streaming.** `run watch` polls `GET /api/runs/:id` on an interval instead of consuming the events stream — one connection, bounded output, no reconnect logic.
- **Preview/studio deep links.** `preview_url` is the deterministic raw-file URL; the studio deep link (which needs the web base + conversation id) is out of Phase A.
- **Workspace switching.** The CLI resolves the daemon's default workspace (personal → first active). Multi-workspace targeting via flag is future work.
- **`--json`.** TOON only in Phase A.

## Official sources used

Endpoint shapes and behaviors were verified against the OpenDesign source and live daemon (v0.22.2):

- [nexu-io/open-design](https://github.com/nexu-io/open-design) — `apps/daemon/src/routes/` (projects, files, runs), `mcp.ts` (the MCP bridge this CLI mirrors), `daemon-url.ts` (discovery order), `api-token-auth.ts` (bearer), `mcp-workspace-context.ts` (workspace header dance), `packages/sidecar/` (JSON IPC protocol and socket paths), `packages/contracts/` (schemas)
- [AXI](https://axi.md/) / [axi-sdk-js](https://github.com/kunchenguid/axi/tree/main/packages/axi-sdk-js) — principles, shared runtime, hooks
- [canva-axi](https://github.com/ardaatahan/canva-axi) — reference structure for a REST-backed design-tool AXI

## License

MIT
