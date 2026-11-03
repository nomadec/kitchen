#!/usr/bin/env node
// The merge gate helper a recipe's merge phase calls from the order's worktree:
// `node "${CLAUDE_PLUGIN_ROOT}/bin/merge-gate.mjs" <phase>`. The mechanics live in the package
// (src/merge-gate.ts, built to dist/merge-gate.js, tested through the fake runner); this file wires the
// real runner, the clock, the session's environment and the working directory to them. See docs/merge-gate.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// <package>/plugin/bin/merge-gate.mjs sits beside <package>/dist, which npm run build writes.
const dist = path.resolve(here, "..", "..", "dist");
const modules = ["merge-gate.js", "runner.js", "clock.js"].map((name) => path.join(dist, name));
const missing = modules.find((file) => !fs.existsSync(file));
if (missing) {
  process.stderr.write(`merge-gate: ${missing} is missing: run npm run build in the kitchen package the plugin sits in\n`);
  process.exit(1);
}

const [{ mergeGate }, { processRunner }, { systemClock }] = await Promise.all(modules.map((file) => import(pathToFileURL(file).href)));

process.exitCode = await mergeGate(process.argv.slice(2), {
  runner: processRunner,
  clock: systemClock,
  env: process.env,
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
