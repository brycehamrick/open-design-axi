import { homedir } from "node:os";

/** Render user paths with `~` (AXI principle 10: identify yourself compactly). */
export function collapseHomeDirectory(path: string, homeDir: string = homedir()): string {
  if (!path.startsWith(homeDir)) return path;
  return `~${path.slice(homeDir.length)}`;
}
