import { AxiError } from "axi-sdk-js";
import type { ResolvedEndpoint } from "./config.js";

/**
 * HTTP client for the OpenDesign daemon's REST API — the same API the
 * official MCP server wraps. Loopback desktop installs serve it
 * unauthenticated; remote/docker installs take `Authorization: Bearer` from
 * OD_API_TOKEN (env only, never argv, never echoed).
 */

export class DaemonApi {
  readonly baseUrl: string;
  readonly version: string | null;
  readonly dataDir: string | null;
  readonly offline: boolean;
  readonly explicitUrl: boolean;
  readonly discoveredVia: string;
  #token: string | null;
  #fetchImpl: typeof fetch;
  #timeoutMs: number;
  #workspace: WorkspaceContext | null | undefined;

  constructor(endpoint: ResolvedEndpoint, options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    this.baseUrl = endpoint.baseUrl ?? "";
    this.version = typeof endpoint.daemon?.version === "string" ? endpoint.daemon.version : null;
    this.dataDir = endpoint.dataDir;
    this.offline = endpoint.mode === "offline";
    this.explicitUrl = endpoint.explicit;
    this.discoveredVia = endpoint.discoveredVia;
    const env = options.env ?? process.env;
    this.#token = env.OD_API_TOKEN?.trim() || null;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async getJson<T = unknown>(path: string, options: { workspace?: boolean } = {}): Promise<T> {
    return await this.request<T>("GET", path, undefined, options);
  }

  async postJson<T = unknown>(path: string, body: unknown, options: { workspace?: boolean } = {}): Promise<T> {
    return await this.request<T>("POST", path, body, options);
  }

  async deleteJson<T = unknown>(path: string, options: { workspace?: boolean } = {}): Promise<T> {
    return await this.request<T>("DELETE", path, undefined, options);
  }

  async getText(path: string, options: { workspace?: boolean } = {}): Promise<{ text: string; mime: string }> {
    const resp = await this.#raw("GET", path, undefined, options);
    if (!resp.ok) await throwApiError(resp, path);
    const mime = (resp.headers.get("content-type") ?? "application/octet-stream").split(";")[0]?.trim()
      ?? "application/octet-stream";
    return { text: await resp.text(), mime };
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { workspace?: boolean } = {},
  ): Promise<T> {
    const resp = await this.#raw(method, path, body, options);
    if (!resp.ok) await throwApiError(resp, path);
    if (resp.status === 204) return undefined as T;
    return (await resp.json()) as T;
  }

  /**
   * Workspace scoping: since 0.18.0 the no-scope `GET /api/projects` only
   * returns never-claimed projects, and bound projects 400/empty for
   * headerless callers. The daemon's own MCP bridge resolves the signed-in
   * workspace once via the headerless directory endpoint and stamps
   * `x-od-workspace-*` headers on project/run calls; we mirror that.
   */
  async workspaceHeaders(): Promise<Record<string, string>> {
    const ctx = await this.#workspaceContext();
    return ctx?.headers ?? {};
  }

  async #workspaceContext(): Promise<WorkspaceContext | null> {
    if (this.#workspace !== undefined) return this.#workspace;
    try {
      const resp = await this.#raw("GET", "/api/workspace/directory");
      if (!resp.ok) {
        this.#workspace = null;
        return null;
      }
      const data = (await resp.json()) as WorkspaceDirectory;
      const active = (data.items ?? []).filter(
        (item) => item.memberStatus === "active" && item.lifecycleState === "active",
      );
      const selected =
        active.find((item) => item.workspaceType === "personal") ?? active[0];
      this.#workspace = selected
        ? {
            workspaceId: selected.workspaceId,
            workspaceMemberId: selected.workspaceMemberId,
            headers: {
              "x-od-workspace-id": selected.workspaceId,
              "x-od-workspace-member-id": selected.workspaceMemberId,
            },
          }
        : null;
    } catch {
      this.#workspace = null;
    }
    return this.#workspace;
  }

  async #raw(method: string, path: string, body?: unknown, options: { workspace?: boolean } = {}): Promise<Response> {
    if (this.offline || this.baseUrl.length === 0) {
      throw offlineError(this.explicitUrl ? this.baseUrl : null);
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (options.workspace) {
      Object.assign(headers, await this.workspaceHeaders());
    }
    let resp: Response;
    try {
      resp = await this.#fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw networkError(error, this.baseUrl);
    }
    if ((resp.status === 401 || resp.status === 403) && this.#token == null) {
      await resp.body?.cancel().catch(() => undefined);
      throw new AxiError(
        `daemon at ${this.baseUrl} rejected the request (${resp.status}); it requires an API token`,
        "AUTH_REQUIRED",
        ["Set OD_API_TOKEN in the environment (the daemon's documented bearer token env) and retry"],
      );
    }
    return resp;
  }
}

interface WorkspaceDirectory {
  items?: Array<{
    workspaceId: string;
    workspaceMemberId: string;
    workspaceType?: string;
    memberStatus?: string;
    lifecycleState?: string;
  }>;
}

interface WorkspaceContext {
  workspaceId: string;
  workspaceMemberId: string;
  headers: Record<string, string>;
}

export function offlineError(explicitUrl: string | null): AxiError {
  const at = explicitUrl ? ` at ${explicitUrl}` : "";
  return new AxiError(
    `OpenDesign daemon is unreachable${at}; this command needs it online`,
    "DAEMON_UNAVAILABLE",
    [
      "Open the OpenDesign desktop app (or start the daemon) and retry",
      "Read-only commands fall back to the local data directory automatically",
    ],
  );
}

export function networkError(error: unknown, baseUrl: string): AxiError {
  const detail = error instanceof Error ? error.message : String(error);
  return new AxiError(
    `cannot reach the OpenDesign daemon at ${baseUrl} (${detail})`,
    "DAEMON_UNAVAILABLE",
    [
      "Open the OpenDesign desktop app (or start the daemon) and retry",
      "Pass --daemon-url <url> if the daemon listens on a non-default port",
    ],
  );
}

async function throwApiError(resp: Response, path: string): Promise<never> {
  let code = "DAEMON_ERROR";
  let message = `${resp.status} ${resp.statusText}`.trim();
  try {
    const body = (await resp.json()) as { error?: { code?: string; message?: string } } | { error?: string };
    if (typeof body?.error === "string") {
      message = body.error;
    } else if (body?.error && typeof body.error === "object") {
      if (typeof body.error.code === "string") code = body.error.code;
      if (typeof body.error.message === "string") message = body.error.message;
    }
  } catch {
    // keep the status-line fallback
  }
  const notFound = resp.status === 404 || code.includes("NOT_FOUND");
  const conflict = resp.status === 409 || code === "FILE_EXISTS";
  const suggestions: string[] = [];
  if (notFound) {
    suggestions.push("Check the id/name with `open-design-axi projects` or `open-design-axi runs`");
  }
  if (code === "WORKSPACE_CONTEXT_REQUIRED") {
    suggestions.push("The daemon could not verify workspace membership; open the OpenDesign app once and retry");
  }
  if (conflict) suggestions.push("Re-run with --overwrite to replace the existing file");
  throw new AxiError(
    message,
    notFound ? "NOT_FOUND" : conflict ? "CONFLICT" : code,
    suggestions,
  );
}
