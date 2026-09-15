// Leaf module: pulls in no project code, so the --version fast path stays
// cheap. The version is read from package.json at require time so an npm
// release bump can never drift from what `--version` prints.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const VERSION: string = (require("../package.json") as { version: string }).version;
