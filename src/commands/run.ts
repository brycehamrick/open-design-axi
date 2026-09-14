import { randomUUID } from "node:crypto";
import { AxiError } from "axi-sdk-js";
import { parseCommandArgs } from "../args.js";
import { shortId, truncate } from "../format.js";
import { resolveProject } from "../project.js";
import { loadRuntime, requireOnline, requireConfirm, requireOfflineStore, type Runtime } from "./shared.js";

/**
 * `run start|view|watch|cancel` — commission and follow generation runs.
 * The daemon spawns its own agent (OpenCode/Claude/Codex/…) and the run
 * pipeline owns design quality; this CLI only starts it and reports status.
 * `run start` is confirm-gated (it spends agent tokens); `run watch` folds
 * the entire poll loop into one command with bounded interim status lines.
 */

interface RunStatusBody {
  id: string;
  projectId: string | null;
  status: string | null;
  agentId: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  terminalAt?: number | null;
  error?: string | null;
  failureAction?: string | null;
  retryable?: boolean | null;
  artifactPaths?: string[] | null;
  artifactCount?: number | null;
  cancelRequested?: boolean | null;
}

export async function runCommand(argv: string[], stdout?: { write: (chunk: string) => unknown }): Promise<Record<string, unknown> | string> {
  const sub = argv[0];
  if (sub !== "start" && sub !== "view" && sub !== "watch" && sub !== "cancel") {
    throw new AxiError(
      sub == null ? "run requires a subcommand" : `unknown run subcommand: ${sub}`,
      "VALIDATION_ERROR",
      ["Run `open-design-axi run --help` to see start, view, watch, cancel"],
    );
  }
  const rest = argv.slice(1);
  if (sub === "start") return await startRun(rest);
  if (sub === "cancel") return await cancelRun(rest);
  if (sub === "watch") return await watchRun(rest, stdout);
  return await viewRun(rest);
}

async function startRun(argv: string[]): Promise<Record<string, unknown>> {
  const { positionals, flags } = parseCommandArgs(
    argv,
    { string: ["prompt", "skill", "plugin", "agent", "model"], boolean: ["confirm"] },
    [{ name: "project", required: true }],
    "run start",
  );
  const prompt = typeof flags.prompt === "string" ? flags.prompt.trim() : "";
  if (!prompt) {
    throw new AxiError("--prompt is required", "VALIDATION_ERROR", [
      'Run `open-design-axi run start <id|name> --prompt "<brief>" --confirm`',
    ]);
  }

  const runtime = await loadRuntime(flags);
  requireOnline(runtime, "start a run");
  const resolved = await resolveProject(positionals[0], { api: runtime.api, offline: runtime.offline });

  const preview = truncate(prompt, 120, "chars");
  requireConfirm(
    {
      project: resolved.name ?? shortId(resolved.id),
      prompt: preview.text + (preview.hint ? ` (${preview.hint})` : ""),
      skill: flags.skill ?? "none",
      plugin: flags.plugin ?? "none",
      agent: flags.agent ?? "daemon default",
      model: flags.model ?? "agent default",
      cost: "the daemon spawns its own agent; typical runs take 5-30 minutes",
    },
    `run start ${positionals[0]}`,
    flags.confirm,
  );

  const body: Record<string, unknown> = {
    projectId: resolved.id,
    message: prompt,
    currentPrompt: prompt,
    clientRequestId: randomUUID(),
  };
  if (typeof flags.skill === "string" && flags.skill.length > 0) body.skillId = flags.skill;
  if (typeof flags.plugin === "string" && flags.plugin.length > 0) body.pluginId = flags.plugin;
  if (typeof flags.agent === "string" && flags.agent.length > 0) body.agentId = flags.agent;
  if (typeof flags.model === "string" && flags.model.length > 0) body.model = flags.model;

  const created = (await runtime.api.postJson("/api/runs", body, { workspace: true })) as {
    runId?: string;
    conversationId?: string | null;
    reused?: boolean;
  };
  if (created?.runId == null) {
    throw new AxiError("daemon did not return a runId", "DAEMON_ERROR", ["Check `open-design-axi runs` to see if the run started"]);
  }

  return {
    run: shortId(created.runId),
    full_id: created.runId,
    project: resolved.name ?? shortId(resolved.id),
    status: "queued",
    reused: created.reused === true,
    help: [
      `Run \`open-design-axi run watch ${created.runId}\` to follow it to completion`,
      `Run \`open-design-axi run view ${created.runId}\` for a one-shot status check`,
    ],
  };
}

async function fetchRun(runtime: Runtime, runId: string): Promise<RunStatusBody> {
  if (!runtime.api.offline) {
    return (await runtime.api.getJson(`/api/runs/${encodeURIComponent(runId)}`)) as RunStatusBody;
  }
  requireOfflineStore(runtime);
  const state = await runtime.offline.getRun(runId);
  if (state == null) throw runNotFound(runId);
  return {
    id: state.id,
    projectId: state.projectId,
    status: state.status,
    agentId: state.agentId,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    error: state.error,
    artifactPaths: state.artifactPaths,
  };
}

export async function resolveRunId(runtime: Runtime, input: string): Promise<string> {
  if (input.length >= 32) return input;
  // Short prefixes (what `runs` prints) resolve against the local run store.
  if (runtime.offline != null) {
    const runs = await runtime.offline.listRuns(null);
    const matches = runs.filter((run) => run.id.toLowerCase().startsWith(input.toLowerCase()));
    if (matches.length === 1) return matches[0]!.id;
    if (matches.length > 1) {
      throw new AxiError(
        `run id "${input}" is ambiguous across ${matches.length} runs`,
        "AMBIGUOUS",
        ["Use the full run id from `open-design-axi runs --fields full_id`"],
      );
    }
  }
  return input;
}

function runNotFound(runId: string): AxiError {
  return new AxiError(`run not found: ${runId}`, "NOT_FOUND", [
    "Run `open-design-axi runs` to list run ids",
  ]);
}

export async function renderRunBlock(run: RunStatusBody, runtime: Runtime, full: boolean): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {
    run: shortId(run.id) ?? run.id,
    status: run.status ?? "unknown",
  };
  if (run.projectId) out.project = shortId(run.projectId);
  if (run.agentId) out.agent = run.agentId;
  if (run.createdAt != null && run.updatedAt != null) {
    out.elapsed = `${Math.max(0, Math.round(((run.terminalAt ?? run.updatedAt) - run.createdAt) / 1000))}s`;
  }
  const artifacts = run.artifactPaths ?? [];
  if (artifacts.length > 0) {
    out.artifacts = artifacts;
    if (!runtime.api.offline && run.projectId != null) {
      const entry = artifacts[0]!;
      out.preview_url = `${runtime.api.baseUrl}/api/projects/${encodeURIComponent(run.projectId)}/raw/${entry.split("/").map(encodeURIComponent).join("/")}`;
    }
  } else if (run.artifactCount != null) {
    out.artifacts = `${run.artifactCount} (paths not recorded)`;
  }
  if (run.error != null && run.error.length > 0) {
    const shown = truncate(run.error, full ? Number.MAX_SAFE_INTEGER : 400, full ? "full" : "chars");
    out.error = shown.text + (shown.hint ? ` (${shown.hint})` : "");
  }
  if (run.failureAction != null && run.failureAction !== "none") {
    out.failure_action = run.failureAction;
    if (run.failureAction === "recharge") out.help_hint = "top up in the OpenDesign app, then re-run start with the same --prompt";
    if (run.failureAction === "relogin") out.help_hint = "re-login in the OpenDesign app, then retry";
  }

  const help: string[] = [];
  if (isTerminal(run.status)) {
    if (run.status === "succeeded" && run.projectId != null) {
      help.push(`Run \`open-design-axi artifact ${shortId(run.projectId)}\` to pull the generated design`);
    }
    if (run.status === "failed" && run.retryable !== false) {
      help.push('Run `open-design-axi run start <id|name> --prompt "<brief>" --confirm` to retry');
    }
  } else {
    help.push(`Run \`open-design-axi run watch ${run.id}\` to follow it`);
    help.push(`Run \`open-design-axi run cancel ${shortId(run.id)} --confirm\` to stop it`);
  }
  if (help.length > 0) out.help = help;
  return out;
}

function isTerminal(status: string | null | undefined): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

async function viewRun(argv: string[]): Promise<Record<string, unknown>> {
  const { positionals, flags } = parseCommandArgs(
    argv,
    { boolean: ["full"] },
    [{ name: "run-id", required: true }],
    "run view",
  );
  const runtime = await loadRuntime(flags);
  const runId = await resolveRunId(runtime, positionals[0]!);
  const run = await fetchRun(runtime, runId);
  return await renderRunBlock(run, runtime, flags.full === true);
}

async function watchRun(
  argv: string[],
  stdout?: { write: (chunk: string) => unknown },
): Promise<Record<string, unknown>> {
  const { positionals, flags } = parseCommandArgs(
    argv,
    { boolean: ["full"], number: ["timeout", "interval"], defaults: { timeout: 600, interval: 15 } },
    [{ name: "run-id", required: true }],
    "run watch",
  );
  const runtime = await loadRuntime(flags);
  const runId = await resolveRunId(runtime, positionals[0]!);
  const timeoutSeconds = flags.timeout as number;
  const intervalSeconds = Math.max(3, flags.interval as number);
  const startedAt = Date.now();
  const write: (chunk: string) => unknown = stdout
    ? (chunk) => stdout.write(chunk)
    : (chunk) => process.stdout.write(chunk);
  const offline = runtime.api.offline;

  if (offline) {
    throw new AxiError(
      "cannot watch live progress while the daemon is offline",
      "DAEMON_UNAVAILABLE",
      ["Start the OpenDesign app and retry", "Run `open-design-axi run view <run-id>` for the last persisted state"],
    );
  }

  for (;;) {
    const run = await fetchRun(runtime, runId);
    if (isTerminal(run.status)) {
      return await renderRunBlock(run, runtime, flags.full === true);
    }
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (elapsed >= timeoutSeconds) {
      const block = await renderRunBlock(run, runtime, flags.full === true);
      block.timeout = `${timeoutSeconds}s watch window elapsed; run still ${run.status}`;
      block.help = [
        `Run \`open-design-axi run watch ${runId} --timeout 1800\` to keep waiting`,
        `Run \`open-design-axi run view ${shortId(runId)}\` for a one-shot check`,
      ];
      return block;
    }
    const artifacts = run.artifactPaths?.length ?? run.artifactCount ?? 0;
    write(`status: ${run.status ?? "unknown"} · elapsed ${elapsed}s · artifacts ${artifacts}\n`);
    await sleep(Math.min(intervalSeconds, Math.max(0, timeoutSeconds - elapsed)) * 1000);
  }
}

async function cancelRun(argv: string[]): Promise<Record<string, unknown>> {
  const { positionals, flags } = parseCommandArgs(
    argv,
    { boolean: ["confirm"] },
    [{ name: "run-id", required: true }],
    "run cancel",
  );
  const runtime = await loadRuntime(flags);
  requireOnline(runtime, "cancel a run");
  const runId = await resolveRunId(runtime, positionals[0]!);
  const current = await fetchRun(runtime, runId);
  if (isTerminal(current.status)) {
    return {
      run: shortId(runId) ?? runId,
      status: current.status,
      note: `already ${current.status} (no-op)`,
    };
  }
  requireConfirm({ run: runId, status: current.status ?? "unknown" }, `run cancel ${positionals[0]}`, flags.confirm);
  const result = (await runtime.api.postJson(`/api/runs/${encodeURIComponent(runId)}/cancel`, {}, {
    workspace: true,
  })) as { run?: RunStatusBody };
  return {
    run: shortId(runId) ?? runId,
    cancel_requested: true,
    status: result?.run?.status ?? "canceling",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
