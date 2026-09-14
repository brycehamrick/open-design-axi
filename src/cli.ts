import { AxiError, runAxiCli } from "axi-sdk-js";
import { encode } from "@toon-format/toon";
import { VERSION } from "./version.js";
import { TOP_LEVEL_HELP, commandHelp } from "./help.js";
import { homeView } from "./commands/home.js";
import { statusView } from "./commands/status.js";
import { projectsCommand } from "./commands/projects.js";
import { projectCommand } from "./commands/project.js";
import { filesCommand } from "./commands/files.js";
import { readCommand } from "./commands/read.js";
import { artifactCommand } from "./commands/artifact.js";
import { searchCommand } from "./commands/search.js";
import { writeCommand, deleteFileCommand } from "./commands/write.js";
import { runsCommand } from "./commands/runs.js";
import { runCommand } from "./commands/run.js";
import { catalogCommands } from "./commands/catalogs.js";
import { setupCommand } from "./commands/setup.js";
import { loadRuntime } from "./commands/shared.js";

export async function main(): Promise<void> {
  await runAxiCli({
    description:
      "Browse and operate OpenDesign projects, files, artifacts, and generation runs — online via the daemon API, offline via the local data directory",
    version: VERSION,
    topLevelHelp: TOP_LEVEL_HELP,
    getCommandHelp: commandHelp,
    // A missing --confirm is a usage error (AXI principle 6: exit 2, same as
    // a missing required flag) even though it carries a change preview.
    formatError: (error) => {
      if (error instanceof AxiError) {
        const block: Record<string, unknown> = { error: error.message, code: error.code };
        if (error.suggestions.length > 0) block.help = error.suggestions;
        const exitCode = error.code === "VALIDATION_ERROR" || error.code === "CONFIRM_REQUIRED" ? 2 : 1;
        return { output: `${encode(block)}\n`, exitCode };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { output: `${encode({ error: message, code: "UNKNOWN" })}\n`, exitCode: 1 };
    },
    home: async () => homeView(await loadRuntime({})),
    commands: {
      status: async (args) => statusView(await loadRuntime(flagsOf(args))),
      projects: projectsCommand,
      project: projectCommand,
      files: filesCommand,
      read: readCommand,
      artifact: artifactCommand,
      search: searchCommand,
      write: writeCommand,
      delete: deleteFileCommand,
      runs: runsCommand,
      run: async (args) => runCommand(args),
      ...catalogCommands(),
      setup: setupCommand,
    },
  });
}

/** Best-effort global flag extraction for `status` (parses its own args anyway). */
function flagsOf(args: string[]): Record<string, string | boolean | number> {
  const flags: Record<string, string | boolean | number> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--daemon-url" && args[i + 1]) flags["daemon-url"] = args[i + 1]!;
    if (args[i] === "--data-dir" && args[i + 1]) flags["data-dir"] = args[i + 1]!;
  }
  return flags;
}
