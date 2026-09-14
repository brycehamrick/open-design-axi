import { stat, readdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { scanSidecarSockets, sidecarStatus } from "./sidecar.js";

/**
 * Endpoint + data-directory resolution.
 *
 * Discovery order mirrors the daemon's own `resolveDaemonUrl` chain, then
 * goes one step further: scanning the sidecar socket directory finds a live
 * daemon even when the MCP registration's env went stale (the most common
 * "MCP stopped working" failure on desktop installs with dynamic ports).
 *
 *  1. --daemon-url flag
 *  2. OD_DAEMON_URL env
 *  3. OD_SIDECAR_CLIENT_ENDPOINT env (sidecar IPC status)
 *  4. scan <tmpdir>/od-sidecar-<uid>/*.sock, status each
 *  5. default http://127.0.0.1:7456
 *
 * Every candidate is verified against GET /api/daemon/status; the first live
 * one wins. When scanning yields several, prefer the one whose dataDir
 * matches the resolved local data directory.
 */

export const DEFAULT_DAEMON_URL = "http://127.0.0.1:7456";

export type DiscoverySource =
  | "flag"
  | "env"
  | "ipc-env"
  | "sidecar-scan"
  | "default"
  | "none";

export interface DaemonStatus {
  ok: boolean;
  version?: string;
  port?: number;
  pid?: number;
  dataDir?: string;
  [key: string]: unknown;
}

export interface ResolvedEndpoint {
  mode: "online" | "offline";
  baseUrl: string | null;
  discoveredVia: DiscoverySource;
  /** True when the URL came from --daemon-url or OD_DAEMON_URL. */
  explicit: boolean;
  daemon: DaemonStatus | null;
  dataDir: string | null;
  dataDirVia: "flag" | "env" | "platform-default" | "none";
}

export interface EndpointOptions {
  daemonUrlFlag?: string | undefined;
  dataDirFlag?: string | undefined;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  probeTimeoutMs?: number;
  scanSockets?: typeof scanSidecarSockets;
  platform?: NodeJS.Platform;
  homeDir?: string;
}

export async function resolveEndpoint(options: EndpointOptions = {}): Promise<ResolvedEndpoint> {
  const env = options.env ?? process.env;
  const doFetch = options.fetchImpl ?? fetch;
  const probeTimeoutMs = options.probeTimeoutMs ?? 1500;

  const dataDirResolution = await resolveDataDir({
    flag: options.dataDirFlag,
    env,
    platform: options.platform,
    homeDir: options.homeDir,
  });
  const dataDir = dataDirResolution.dir;

  type Candidate = { url: string; via: DiscoverySource; explicit: boolean };
  const candidates: Candidate[] = [];

  const flagUrl = options.daemonUrlFlag?.trim();
  if (flagUrl) candidates.push({ url: normalizeUrl(flagUrl), via: "flag", explicit: true });
  const envUrl = env.OD_DAEMON_URL?.trim();
  if (envUrl && !flagUrl) candidates.push({ url: normalizeUrl(envUrl), via: "env", explicit: true });

  const ipcEndpoint = env.OD_SIDECAR_CLIENT_ENDPOINT?.trim();
  if (ipcEndpoint) {
    const status = await sidecarStatus(ipcEndpoint, probeTimeoutMs);
    if (typeof status?.url === "string" && status.url.length > 0) {
      candidates.push({ url: normalizeUrl(status.url), via: "ipc-env", explicit: false });
    }
  }

  if (candidates.length === 0 || !candidates.some((c) => c.explicit)) {
    const scan = options.scanSockets ?? scanSidecarSockets;
    const found = await scan(options.platform ?? platform(), probeTimeoutMs);
    const withUrl = found
      .filter((entry) => typeof entry.status.url === "string" && entry.status.url.length > 0)
      .map((entry) => ({
        url: normalizeUrl(entry.status.url as string),
        via: "sidecar-scan" as DiscoverySource,
        explicit: false,
      }));
    if (withUrl.length > 1) {
      // Several stamps can be live at once (daemon, trusted web proxy, app).
      // Probe each in parallel and prefer the daemon proper: its status
      // reports the same port as its URL, while a proxy's forwarded status
      // names the daemon's port instead.
      const probed = await Promise.all(
        withUrl.map(async (entry) => ({
          entry,
          status: await probeDaemon(entry.url, doFetch, probeTimeoutMs),
        })),
      );
      const ranked = probed
        .filter((p) => p.status != null)
        .sort((a, b) => {
          const score = (p: { entry: { url: string }; status: DaemonStatus | null }): number =>
            p.status != null && urlPort(p.entry.url) === p.status.port ? 1 : 0;
          return score(b) - score(a);
        });
      for (const p of ranked) candidates.push(p.entry);
    } else {
      candidates.push(...withUrl);
    }
  }

  candidates.push({ url: DEFAULT_DAEMON_URL, via: "default", explicit: false });

  for (const candidate of candidates) {
    const status = await probeDaemon(candidate.url, doFetch, probeTimeoutMs);
    if (status != null) {
      return {
        mode: "online",
        baseUrl: candidate.url,
        discoveredVia: candidate.via,
        explicit: candidate.explicit,
        daemon: status,
        dataDir: dataDir ?? (typeof status.dataDir === "string" ? status.dataDir : null),
        dataDirVia: dataDir != null ? dataDirResolution.via : (typeof status.dataDir === "string" ? "platform-default" : "none"),
      };
    }
  }

  const first = candidates[0];
  if (first?.explicit) {
    return {
      mode: "offline",
      baseUrl: first.url,
      discoveredVia: first.via,
      explicit: true,
      daemon: null,
      dataDir,
      dataDirVia: dataDirResolution.via,
    };
  }
  return {
    mode: "offline",
    baseUrl: null,
    discoveredVia: "none",
    explicit: false,
    daemon: null,
    dataDir,
    dataDirVia: dataDirResolution.via,
  };
}

async function probeDaemon(
  baseUrl: string,
  doFetch: typeof fetch,
  timeoutMs: number,
): Promise<DaemonStatus | null> {
  try {
    const resp = await doFetch(`${baseUrl}/api/daemon/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as DaemonStatus;
    return body?.ok === true ? body : null;
  } catch {
    return null;
  }
}

function normalizeUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

function urlPort(url: string): number | null {
  const match = /:(\d+)$/.exec(url);
  return match ? Number(match[1]) : null;
}

export interface DataDirResolution {
  dir: string | null;
  via: "flag" | "env" | "platform-default" | "none";
}

/** `<userData>/Open Design/namespaces/<ns>/data` roots, per platform. */
export function defaultNamespaceRoots(
  platformType: NodeJS.Platform = platform(),
  homeDir: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platformType === "darwin") {
    return [join(homeDir, "Library", "Application Support", "Open Design", "namespaces")];
  }
  if (platformType === "win32") {
    const appData = env.APPDATA ?? join(homeDir, "AppData", "Roaming");
    return [join(appData, "Open Design", "namespaces")];
  }
  const xdg = env.XDG_CONFIG_HOME ?? join(homeDir, ".config");
  return [join(xdg, "Open Design", "namespaces")];
}

const PREFERRED_NAMESPACES = ["release-stable"];

export async function resolveDataDir(input: {
  flag?: string | undefined;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
}): Promise<DataDirResolution> {
  const env = input.env ?? process.env;
  const flag = input.flag?.trim();
  if (flag) return { dir: flag, via: "flag" };
  const envDir = env.OD_DATA_DIR?.trim();
  if (envDir) return { dir: envDir, via: "env" };

  const roots = defaultNamespaceRoots(
    input.platform ?? platform(),
    input.homeDir ?? homedir(),
    env,
  );
  for (const root of roots) {
    let namespaces: string[];
    try {
      namespaces = await readdir(root);
    } catch {
      continue;
    }
    const ordered = [
      ...PREFERRED_NAMESPACES.filter((ns) => namespaces.includes(ns)),
      ...namespaces.filter((ns) => !PREFERRED_NAMESPACES.includes(ns)).sort(),
    ];
    for (const ns of ordered) {
      const candidate = join(root, ns, "data");
      if (await looksLikeDataDir(candidate)) return { dir: candidate, via: "platform-default" };
    }
  }
  return { dir: null, via: "none" };
}

async function looksLikeDataDir(dir: string): Promise<boolean> {
  const markers = ["app.sqlite", "projects"];
  for (const marker of markers) {
    try {
      await stat(join(dir, marker));
      return true;
    } catch {
      // keep checking other markers
    }
  }
  return false;
}
