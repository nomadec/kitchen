#!/usr/bin/env node
// The bin entry: wires the real runner and clock into the CLI.
import os from "node:os";
import { main } from "../cli.ts";
import { systemClock } from "../clock.ts";
import { processRunner } from "../runner.ts";

process.exitCode = await main(process.argv.slice(2), {
  runner: processRunner,
  clock: systemClock,
  env: process.env,
  hostname: os.hostname(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
