import { installSessionStartHooks, sessionStartHookStatus, uninstallSessionStartHooks } from "axi-sdk-js";
import { parseCommandArgs } from "../args.js";

/**
 * `setup` / `setup --remove` — ambient context (AXI principle 7). Installs
 * a managed SessionStart hook for Claude Code, Codex, and OpenCode that
 * runs the content-first home view at session start. Explicit opt-in,
 * idempotent, and repairable: re-running updates the executable path.
 */

export async function setupCommand(argv: string[]): Promise<Record<string, unknown>> {
  const { flags } = parseCommandArgs(argv, { boolean: ["remove"] }, [], "setup");

  if (flags.remove === true) {
    uninstallSessionStartHooks();
    const status = sessionStartHookStatus();
    return {
      removed: true,
      claude: status.claude.installed ? "still present" : "removed",
      codex: status.codex.installed ? "still present" : "removed",
      opencode: status.opencode.installed ? "still present" : "removed",
    };
  }

  const errors: string[] = [];
  installSessionStartHooks({ onError: (message) => errors.push(message) });
  const status = sessionStartHookStatus();

  return {
    installed: {
      claude: describe(status.claude.installed, status.claude.path),
      codex: describe(status.codex.installed, status.codex.path),
      opencode: describe(status.opencode.installed, status.opencode.path),
    },
    hook: "SessionStart → `open-design-axi` (compact project/run dashboard each session)",
    ...(errors.length > 0 ? { warnings: errors } : {}),
    help: ["Run `open-design-axi setup --remove` to uninstall the hooks"],
  };
}

function describe(installed: boolean, path: string): string {
  return installed ? `installed → ${path}` : "not installed";
}
