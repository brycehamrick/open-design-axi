import { AxiError } from "axi-sdk-js";
import { resolveEndpoint, type ResolvedEndpoint } from "../config.js";
import { DaemonApi } from "../api.js";
import { OfflineStore } from "../offline.js";

/** Per-invocation runtime: one endpoint resolution, API client + offline store. */
export interface Runtime {
  endpoint: ResolvedEndpoint;
  api: DaemonApi;
  offline: OfflineStore | null;
}

export async function loadRuntime(flags: Record<string, string | boolean | number>): Promise<Runtime> {
  const endpoint = await resolveEndpoint({
    daemonUrlFlag: typeof flags["daemon-url"] === "string" ? flags["daemon-url"] : undefined,
    dataDirFlag: typeof flags["data-dir"] === "string" ? flags["data-dir"] : undefined,
  });
  const api = new DaemonApi(endpoint);
  const offline = endpoint.dataDir != null ? new OfflineStore(endpoint.dataDir) : null;
  return { endpoint, api, offline };
}

/** Read commands run online and fall back to the offline store when the daemon is down. */
export interface OnlineOrOffline<T> {
  online: T | null;
  offline: boolean;
}

export function requireOnline(runtime: Runtime, action: string): void {
  if (!runtime.api.offline) return;
  const at = runtime.endpoint.baseUrl ? ` at ${runtime.endpoint.baseUrl}` : "";
  throw new AxiError(
    `cannot ${action}: OpenDesign daemon is unreachable${at}`,
    "DAEMON_UNAVAILABLE",
    [
      "Open the OpenDesign desktop app (or start the daemon) and retry",
      runtime.offline
        ? "Read-only commands still work offline against the local data directory"
        : "Set OD_DATA_DIR so offline reads can find your projects",
    ],
  );
}

export function dataDirNote(endpoint: ResolvedEndpoint): string | null {
  return endpoint.dataDir ?? null;
}

/** Offline reads need a resolved data directory; give the actionable error when missing. */
export function requireOfflineStore(
  runtime: Runtime,
): asserts runtime is Runtime & { offline: NonNullable<Runtime["offline"]> } {
  if (runtime.offline == null) {
    throw new AxiError(
      "daemon offline and no local data directory resolved",
      "DAEMON_UNAVAILABLE",
      ["Pass --data-dir <path> or set OD_DATA_DIR to enable offline reads"],
    );
  }
}

/** Mutation gate: print the would-change preview, then fail until --confirm. */
export function requireConfirm(
  preview: Record<string, unknown>,
  commandPath: string,
  confirmFlag: string | boolean | number | undefined,
): void {
  if (confirmFlag === true) return;
  const lines = Object.entries(preview)
    .map(([key, value]) => `  ${key}: ${formatPreviewValue(value)}`)
    .join("\n");
  const rerun = `open-design-axi ${commandPath} --confirm`;
  throw new AxiError(
    `--confirm is required to apply this change\nwould_change:\n${lines}\nhelp: re-run as \`${rerun}\``,
    "CONFIRM_REQUIRED",
    [`Re-run as \`${rerun}\` to apply`],
  );}

function formatPreviewValue(value: unknown): string {
  if (value == null) return "none";
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 120)}… (${value.length} chars total)` : value;
  return String(value);
}
