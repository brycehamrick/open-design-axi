# Project agent memory

- `README.md` is the authoritative command, auth, discovery, safety-gate, and
  UNRESOLVED reference. Keep it aligned with `src/help.ts` and the command
  modules under `src/commands/`.
- Endpoint behavior must be verified against the OpenDesign daemon source
  (`apps/daemon/src/routes/`, `mcp.ts`, `packages/contracts/`) — never infer
  an endpoint from guesses; the MCP bridge in `mcp.ts` is the reference
  client for request/response shapes.
- The daemon's base URL is dynamic on desktop installs. Discovery order is
  `--daemon-url` → `OD_DAEMON_URL` → `OD_SIDECAR_CLIENT_ENDPOINT` IPC →
  sidecar socket scan → default 7456; every candidate is verified via
  `GET /api/daemon/status` before use. Keep the scan working — it is the fix
  for the stale-registration failure mode this tool exists to survive.
- Workspace isolation: headerless `GET /api/projects` returns only unbound
  projects. Resolve the directory (`GET /api/workspace/directory`), pick
  personal → first active, and send `x-od-workspace-id` +
  `x-od-workspace-member-id` on project/run calls. Headerless create retry
  on `WORKSPACE_*` errors is the daemon's own documented fallback.
- All credentials come from `OD_API_TOKEN` (env only). Never accept tokens
  on argv, never echo them, never commit real ids, names, paths, or tokens —
  tests use synthetic fixtures only.
- Every mutation rejects without `--confirm` before any network access, with
  a would-change preview. Reads are ungated. Exit codes: 0 success/no-op,
  1 runtime, 2 usage (including missing `--confirm`, unknown flags).
- Offline reads (dataDir fs + read-only `app.sqlite` via `node:sqlite`) must
  never write to the data directory.
- Validate changes with `npm test`, `npm run typecheck`, and
  `npm run skill:check`. Tests must not require a daemon or secrets.

## UNRESOLVED

- Offline writes are intentionally unsupported (version/artifact-manifest
  drift); all writes go through the daemon.
- Brief collection, Vela login, SSE streaming, studio deep links, and
  multi-workspace targeting are out of Phase A (see README).
