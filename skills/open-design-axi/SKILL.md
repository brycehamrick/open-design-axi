---
name: open-design-axi
description: >
  Operate OpenDesign from the shell - list projects, read and write design files, pull full artifact bundles, search, and drive generation runs (start/watch/cancel) through open-design-axi. Use whenever a task touches OpenDesign or the Open Design app: finding a project, pulling its HTML/CSS sources, editing a design file, or commissioning a generation run.
---

# open-design-axi

## What this gives you

A token-cheap, durable shell surface over a local OpenDesign daemon: TOON
output, 3-field list rows, combined views, and offline reads straight from
the data directory when the daemon is down. Mutations are gated behind
`--confirm`.

## Orientation

```sh
npx -y open-design-axi                       # live dashboard: daemon, active project, projects, recent runs
npx -y open-design-axi status                # daemon health, discovery source, data dir, offline capability
npx -y open-design-axi projects              # list projects (8-char id prefixes work as refs)
```

`<ref>` everywhere accepts a project id prefix, an exact name, or a unique
name substring; omit it (or pass `active`) to target the project open in
the app.

## Reading designs

```sh
npx -y open-design-axi project <ref>         # entry file, file/byte totals, preview URL — one call
npx -y open-design-axi files <ref>           # file listing with byte total (--glob '*.html')
npx -y open-design-axi read <ref> <path>     # 500-line windowed read (--offset/--limit/--full)
npx -y open-design-axi artifact <ref>        # full bundle: entry + referenced siblings (BFS)
npx -y open-design-axi search <ref> <query>  # content search (--glob, --max)
```

`artifact` follows HTML/CSS/JS references (depth 3, 1.5 MB budget default).
`--include shallow|all`, `--entry <path>`, `--max-bytes <n>`, `--full`
control the bundle.

## Writing files

```sh
cat index.html | npx -y open-design-axi write <ref> index.html --stdin --confirm
npx -y open-design-axi write <ref> assets/logo.svg --file ./logo.svg --confirm
npx -y open-design-axi delete <ref> draft.html --confirm
```

Writes go through the daemon so version capture and artifact manifests stay
consistent. `--overwrite` replaces existing files; `--artifact` registers
the file as a design artifact (manifest inferred for html/deck/md/svg).

## Generation runs

```sh
npx -y open-design-axi run start <ref> --prompt "<brief>" --confirm   # daemon spawns its own agent
npx -y open-design-axi run watch <run-id>              # poll loop to terminal (--timeout 1800 for long runs)
npx -y open-design-axi run view <run-id> --full        # one-shot status, artifacts, errors
npx -y open-design-axi run cancel <run-id> --confirm
npx -y open-design-axi runs <ref> --status failed      # history
```

Pick the inputs first: `npx -y open-design-axi skills`, `npx -y open-design-axi agents`,
`npx -y open-design-axi design-systems`, `npx -y open-design-axi plugins`. Typical runs take 5-30
minutes; `watch` prints compact interim status lines and a final block
with artifact paths and a preview URL.

## Projects

```sh
npx -y open-design-axi projects create --name "<name>" --design-system <id> --confirm
npx -y open-design-axi projects delete <ref> --confirm   # irreversible: row + files on disk
```

## Offline mode

When the daemon is unreachable, every read command falls back to the local
data directory (`OD_DATA_DIR` or the platform default), reading project
files, sqlite project names, and run state from disk. Writes and runs then
fail with a structured `DAEMON_UNAVAILABLE` error and recovery hints.

## Conventions

- Output is TOON; timestamps are unix seconds; ids print as 8-char prefixes.
- Exit codes: 0 success/no-op, 1 runtime error, 2 usage error (missing
  `--confirm`, unknown flag, bad values).
- Errors are structured on stdout with `help[]` next steps.
- `--help` on any command prints its concise reference.
- Auth: loopback needs nothing; set `OD_API_TOKEN` when the daemon requires
  a token. Override discovery with `--daemon-url`/`OD_DAEMON_URL`.

