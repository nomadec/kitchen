// The kitchen command's front door: the help the bin entry prints and how it dispatches by name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./cli.ts";
import type { CliDeps } from "./cli.ts";
import { fakeClock, fakeRunner } from "./testing/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, "bin", "kitchen.ts");

// The ten v1 commands as the spec lists them. Nothing else.
const V1_COMMANDS = ["init", "up", "down", "order add", "recipe add", "station add", "source add", "turn", "pass", "status"];

test("the bin entry runs kitchen --help, listing the ten v1 commands and nothing else", () => {
  const result = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const listed = result.stdout
    .split("\n")
    .filter((line) => /^ {2}\S/.test(line))
    .map((line) => line.trim().split(/ {2,}/)[0]);
  assert.deepEqual(listed, V1_COMMANDS);
});

function kitchen() {
  const err: string[] = [];
  const runner = fakeRunner([]);
  const deps: CliDeps = {
    runner,
    clock: fakeClock(),
    env: {},
    hostname: "oven",
    program: { platform: "linux", argv: ["/usr/bin/node", "/opt/kitchen/dist/bin/kitchen.js"], pluginDir: "/opt/kitchen/plugin" },
    stdout: () => {},
    stderr: (text) => err.push(text),
  };
  return { run: (...argv: string[]) => main(argv, deps), runner, err };
}

test("a v1 command this release does not implement yet says so, issues nothing and exits non-zero", async () => {
  const k = kitchen();
  assert.notEqual(await k.run("status"), 0);
  assert.match(k.err.join(""), /kitchen status is not implemented yet/);
  assert.notEqual(await k.run("turn", "kitchen-1"), 0);
  assert.match(k.err.join(""), /kitchen turn is not implemented yet/);
  assert.deepEqual(k.runner.calls, []);
});

test("an unknown command is refused with the help, and a bare group names its subcommand", async () => {
  const k = kitchen();
  assert.notEqual(await k.run("cook"), 0);
  assert.match(k.err.join(""), /unknown command: cook/);
  assert.match(k.err.join(""), /Commands:/);
  assert.notEqual(await k.run("order"), 0);
  assert.match(k.err.join(""), /kitchen order needs a subcommand: kitchen order add/);
  assert.notEqual(await k.run(), 0);
  assert.deepEqual(k.runner.calls, []);
});
