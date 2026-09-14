import { createConnection } from "node:net";
import { readdir } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

/**
 * Sidecar IPC discovery.
 *
 * The OpenDesign daemon publishes itself through newline-delimited JSON IPC
 * sockets under `<tmpdir>/od-sidecar-<principal>/<digest>.sock` (Windows:
 * named pipes `\\.\pipe\open-design-sidecar-<digest>`). Each socket answers
 * `{"type":"sidecar:status"}` with `{ok,result}` where `result.url` is the
 * daemon's HTTP base URL.
 *
 * The digest hashes the principal plus a five-field stamp (channel,
 * namespace, source, mode, app), so a machine can host several stamps (dev
 * checkout, packaged release, prerelease). Rather than guessing the stamp,
 * we scan every socket in the directory and ask each one for its status.
 */

export interface SidecarStatus {
  url?: string | null;
  state?: string;
  pid?: number;
  [key: string]: unknown;
}

const STATUS_TIMEOUT_MS = 900;

export async function sidecarStatus(
  socketPath: string,
  timeoutMs = STATUS_TIMEOUT_MS,
): Promise<SidecarStatus | null> {
  return await new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (value: SidecarStatus | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ type: "sidecar:status" })}\n`);
    });
    socket.on("data", (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const reply = JSON.parse(buffer.slice(0, newline)) as {
          ok?: boolean;
          result?: SidecarStatus;
        };
        finish(reply?.ok === true && reply.result ? reply.result : null);
      } catch {
        finish(null);
      }
    });
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}

/** Directory holding this principal's sidecar sockets (POSIX). */
export function sidecarSocketDir(platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "win32") return null;
  const principal = (() => {
    try {
      return String(userInfo().uid);
    } catch {
      return process.env.USER ?? "unknown";
    }
  })();
  return join(tmpdir(), `od-sidecar-${principal}`);
}

/**
 * Ask every sidecar socket for its status. Windows support relies on the
 * digest (principal + stamp) and is not enumerable the same way, so callers
 * fall back to env/default discovery there.
 */
export async function scanSidecarSockets(
  platform: NodeJS.Platform = process.platform,
  timeoutMs = STATUS_TIMEOUT_MS,
): Promise<Array<{ socketPath: string; status: SidecarStatus }>> {
  const dir = sidecarSocketDir(platform);
  if (dir == null) return [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const sockets = entries.filter((entry) => entry.endsWith(".sock"));
  const results = await Promise.all(
    sockets.map(async (entry) => {
      const status = await sidecarStatus(join(dir, entry), timeoutMs);
      return status ? { socketPath: join(dir, entry), status } : null;
    }),
  );
  return results.filter((entry): entry is { socketPath: string; status: SidecarStatus } => entry != null);
}
