#!/usr/bin/env node
// The bin entry: wires the real runner and clock into the CLI.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../cli.ts";
import { systemClock } from "../clock.ts";
import { processRunner } from "../runner.ts";

const script = fileURLToPath(import.meta.url);

process.exitCode = await main(process.argv.slice(2), {
  runner: processRunner,
  clock: systemClock,
  env: process.env,
  hostname: os.hostname(),
  program: {
    platform: process.platform,
    argv: [process.execPath, script],
    // <package>/dist/bin/kitchen.js and <package>/src/bin/kitchen.ts both sit two levels under the package root.
    pluginDir: path.resolve(path.dirname(script), "..", "..", "plugin"),
  },
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
