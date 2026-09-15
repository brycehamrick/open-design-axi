#!/usr/bin/env node
// Regenerates skills/open-design-axi/SKILL.md from src/skill/content.ts.
// `--check` exits non-zero when the committed copy has drifted (CI guard).
//
// The content is imported from the compiled dist/ module so the generator and
// the CLI share one source of truth. On a fresh clone dist/ does not exist
// yet, so build it first when missing — this keeps `npm run skill:check`
// (and therefore `prepublishOnly`) working before the first `npm test`.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "skills", "open-design-axi", "SKILL.md");
const compiled = join(root, "dist", "skill", "content.js");

if (!existsSync(compiled)) {
  const build = spawnSync("npm", ["run", "build"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (build.status !== 0 || !existsSync(compiled)) {
    console.error("skill:gen requires a successful build (npm run build) first");
    process.exit(1);
  }
}

const { SKILL_NAME, SKILL_DESCRIPTION, skillBody } = await import(
  join(root, "dist", "skill", "content.js")
);

const body = `---
name: ${SKILL_NAME}
description: >
  ${SKILL_DESCRIPTION}
---

# open-design-axi

${skillBody("npx -y open-design-axi")}
`;

if (process.argv.includes("--check")) {
  const committed = existsSync(target) ? readFileSync(target, "utf8") : null;
  if (committed !== body) {
    console.error("skills/open-design-axi/SKILL.md is stale; run `npm run skill:gen` and commit");
    process.exit(1);
  }
  console.log("SKILL.md is up to date");
  process.exit(0);
}

await mkdir(dirname(target), { recursive: true });
writeFileSync(target, body);
console.log(`wrote ${target}`);
