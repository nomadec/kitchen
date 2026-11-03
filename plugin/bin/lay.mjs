#!/usr/bin/env node
// The lay helper the kitchen:turn skill calls: `node "${CLAUDE_PLUGIN_ROOT}/bin/lay.mjs" <subcommand> ...`.
// The mechanics live in the package (src/turn/lay.ts, built to dist/turn/lay.js, tested through the
// fake runner); this file wires the real runner, the session's environment and stdin to them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// <package>/plugin/bin/lay.mjs sits beside <package>/dist, which npm run build writes.
const built = path.resolve(here, "..", "..", "dist", "turn", "lay.js");
const runnerModule = path.resolve(here, "..", "..", "dist", "runner.js");
if (!fs.existsSync(built) || !fs.existsSync(runnerModule)) {
  process.stderr.write(`lay: ${built} is missing: run npm run build in the kitchen package the plugin sits in\n`);
  process.exit(1);
}

const { lay } = await import(pathToFileURL(built).href);
const { processRunner } = await import(pathToFileURL(runnerModule).href);

const readStdin = () =>
  new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => resolve(raw));
  });

process.exitCode = await lay(process.argv.slice(2), {
  runner: processRunner,
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  stdin: readStdin,
});
