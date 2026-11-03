// kitchen init, exercised through the bd call it issues and the config file it writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../cli.ts";
import type { CliDeps } from "../cli.ts";
import { fakeClock, fakeRunner } from "../testing/index.ts";
import type { ScriptedAnswer } from "../testing/index.ts";

function kitchen(t: { after(fn: () => void): void }, table: readonly ScriptedAnswer[]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-init-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const out: string[] = [];
  const err: string[] = [];
  const runner = fakeRunner(table);
  const deps: CliDeps = {
    runner,
    clock: fakeClock(),
    env: { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") },
    hostname: "sona-laptop",
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  const configDir = path.join(home, ".config", "kitchen");
  const run = (...argv: string[]) => main(argv, deps);
  return { run, runner, out, err, configDir, configFile: path.join(configDir, "config.json") };
}

const VERIFY_OK: ScriptedAnswer = { command: "bd", args: ["--actor", "sona", "init"] };

test("kitchen init writes the host config and verifies the connection with one bd call under the human actor", async (t) => {
  const k = kitchen(t, [VERIFY_OK]);

  const code = await k.run("init", "--server", "rbn3:3307", "--owner", "sona", "--credential", "/home/sona/.config/beads/credentials");

  assert.equal(code, 0, k.err.join(""));
  assert.deepEqual(JSON.parse(fs.readFileSync(k.configFile, "utf8")), {
    server: { host: "rbn3", port: 3307, user: "sona", database: "kitchen" },
    credential: "/home/sona/.config/beads/credentials",
    owner: "sona",
    host: "sona-laptop",
  });
  assert.deepEqual(k.runner.calls, [
    {
      argv: [
        "bd", "--actor", "sona", "init",
        "--server", "--external",
        "--server-host", "rbn3", "--server-port", "3307", "--server-user", "sona",
        "--database", "kitchen", "--prefix", "kitchen",
        "--non-interactive", "--quiet",
      ],
      cwd: path.join(k.configDir, "space"),
      env: { BEADS_CREDENTIALS_FILE: "/home/sona/.config/beads/credentials" },
    },
  ]);
  assert.match(k.out.join(""), /Connected to rbn3:3307 as sona/);
  assert.match(k.out.join(""), new RegExp(k.configFile));
});

test("kitchen init takes the database, SQL user and host name as options", async (t) => {
  const k = kitchen(t, [{ command: "bd", args: ["--actor", "raffy", "init"] }]);

  const code = await k.run("init", "--server", "10.0.0.5:3306", "--owner", "raffy", "--database", "team", "--user", "svc", "--host", "oven");

  assert.equal(code, 0, k.err.join(""));
  const config = JSON.parse(fs.readFileSync(k.configFile, "utf8"));
  assert.deepEqual(config.server, { host: "10.0.0.5", port: 3306, user: "svc", database: "team" });
  assert.equal(config.host, "oven");
  assert.equal(config.credential, path.join(k.configDir, "..", "beads", "credentials"));
  const argv = k.runner.calls[0]?.argv ?? [];
  assert.equal(argv[argv.indexOf("--database") + 1], "team");
  assert.equal(argv[argv.indexOf("--server-user") + 1], "svc");
});

test("a failing verification prints the command's stderr, exits non-zero and writes no config", async (t) => {
  const k = kitchen(t, [
    { command: "bd", args: ["--actor", "sona", "init"], exitCode: 1, stderr: "Error: Dolt server unreachable at rbn3:3307\n" },
  ]);

  const code = await k.run("init", "--server", "rbn3:3307", "--owner", "sona");

  assert.notEqual(code, 0);
  assert.match(k.err.join(""), /Dolt server unreachable at rbn3:3307/);
  assert.equal(fs.existsSync(k.configFile), false);
  assert.equal(fs.existsSync(path.join(k.configDir, "space")), false);
});

test("running kitchen init again re-initialises the existing space in place and keeps it when verification fails", async (t) => {
  const k = kitchen(t, [
    { command: "bd", args: ["--actor", "sona", "init", "--server", "--external", "--server-host", "rbn3"] },
    { command: "bd", args: ["--actor", "sona", "init", "--server", "--external", "--server-host", "gone"], exitCode: 1, stderr: "unreachable\n" },
  ]);
  const space = path.join(k.configDir, "space");
  assert.equal(await k.run("init", "--server", "rbn3:3307", "--owner", "sona"), 0, k.err.join(""));
  fs.writeFileSync(path.join(space, "marker"), "the beads workspace bd set up");

  assert.equal(await k.run("init", "--server", "rbn3:3307", "--owner", "sona"), 0, k.err.join(""));
  assert.ok(k.runner.calls[1]?.argv.includes("--reinit-local"), "the second run re-initialises the existing workspace");
  assert.ok(!k.runner.calls[0]?.argv.includes("--reinit-local"), "the first run does not");

  assert.notEqual(await k.run("init", "--server", "gone:3307", "--owner", "sona"), 0);
  assert.equal(fs.readFileSync(path.join(space, "marker"), "utf8"), "the beads workspace bd set up", "an existing space survives a failed run");
  assert.equal(JSON.parse(fs.readFileSync(k.configFile, "utf8")).server.host, "rbn3", "the earlier config survives too");
});

test("kitchen init refuses to run without a server and an owner, before any command is issued", async (t) => {
  const k = kitchen(t, []);

  assert.notEqual(await k.run("init", "--owner", "sona"), 0);
  assert.match(k.err.join(""), /--server/);
  assert.notEqual(await k.run("init", "--server", "rbn3:3307"), 0);
  assert.match(k.err.join(""), /--owner/);
  assert.notEqual(await k.run("init", "--server", "rbn3", "--owner", "sona"), 0);
  assert.match(k.err.join(""), /host:port/);
  assert.deepEqual(k.runner.calls, []);
  assert.equal(fs.existsSync(k.configFile), false);
});
