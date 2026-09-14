#!/usr/bin/env node
// Fast path: answer bare -v/-V/--version before the command graph loads.
import { tryFastPath } from "axi-sdk-js/fast-path";
import { VERSION } from "../dist/version.js";

if (!tryFastPath(process.argv.slice(2), { version: VERSION })) {
  const { main } = await import("../dist/cli.js");
  await main();
}
