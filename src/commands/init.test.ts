// kitchen init, exercised through the bd call it issues and the config file it writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../cli.ts";
import type { CliDeps } from "../cli.ts";
import { fakeClock, fakeRunner, TEST_PROGRAM } from "../testing/index.ts";
import type { ScriptedAnswer } from "../testing/index.ts";

/** The beads credentials file: one `[host:port]` section per server, in both spellings bd reads. */
const CREDENTIALS = "# servers\n[rbn3:3307]\npassword = the-rbn3-secret\n\n[10.0.0.5:3306]\npassword=team-secret\n\n[gone:3307]\npassword = gone\n";

function kitchen(t: { after(fn: () => void): void }, table: readonly ScriptedAnswer[]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-init-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // The default credentials file under the config root; a test that names another writes its own.
  fs.mkdirSync(path.join(home, ".config", "beads"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "beads", "credentials"), CREDENTIALS);
  const out: string[] = [];
  const err: string[] = [];
  const runner = fakeRunner(table);
  const deps: CliDeps = {
    runner,
    clock: fakeClock(),
    env: { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") },
    hostname: "sona-laptop",
    program: { platform: "linux", ...TEST_PROGRAM },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  const configDir = path.join(home, ".config", "kitchen");
  const run = (...argv: string[]) => main(argv, deps);
  return { home, run, runner, out, err, configDir, configFile: path.join(configDir, "config.json") };
}

const VERIFY_OK: ScriptedAnswer = { command: "bd", args: ["--actor", "sona", "init"] };
/** The two config values every space gets, set after the workspace exists. */
const CONFIGURED: ScriptedAnswer[] = [{ command: "bd", args: ["--actor", "sona", "config", "set"] }];
const SPACE_CONFIG_CALLS = (cwd: string, env: Record<string, string>) => [
  { argv: ["bd", "--actor", "sona", "config", "set", "types.custom", "phase,station,source"], cwd, env },
  { argv: ["bd", "--actor", "sona", "config", "set", "events-journal", "true"], cwd, env },
];

test("kitchen init writes the host config and verifies the connection with one bd call under the human actor", async (t) => {
  const k = kitchen(t, [VERIFY_OK, ...CONFIGURED]);
  // bd init reads the server password from BEADS_DOLT_PASSWORD only (the credentials file serves every
  // later command), so the init call carries the section's password; the config never holds it.
  const credential = path.join(k.home, "credentials");
  fs.writeFileSync(credential, CREDENTIALS);

  const code = await k.run("init", "--server", "rbn3:3307", "--owner", "sona", "--credential", credential);

  assert.equal(code, 0, k.err.join(""));
  assert.deepEqual(JSON.parse(fs.readFileSync(k.configFile, "utf8")), {
    server: { host: "rbn3", port: 3307, user: "sona", database: "kitchen" },
    credential,
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
        "--non-interactive", "--quiet", "--skip-agents", "--skip-hooks",
      ],
      cwd: path.join(k.configDir, "space"),
      env: { BEADS_CREDENTIALS_FILE: credential, BEADS_DOLT_PASSWORD: "the-rbn3-secret" },
    },
    // Kitchen's bead types and the journal, set on every init: the same values the server installer sets.
    ...SPACE_CONFIG_CALLS(path.join(k.configDir, "space"), { BEADS_CREDENTIALS_FILE: credential, BEADS_DOLT_PASSWORD: "the-rbn3-secret" }),
  ]);
  assert.match(k.out.join(""), /Connected to rbn3:3307 as sona/);
  assert.match(k.out.join(""), new RegExp(k.configFile));
});

test("kitchen init refuses a credentials file without the server's section, before any command is issued", async (t) => {
  const k = kitchen(t, []);

  assert.notEqual(await k.run("init", "--server", "rbn3:3308", "--owner", "sona"), 0);
  assert.match(k.err.join(""), /\[rbn3:3308\]/);
  assert.match(k.err.join(""), new RegExp(path.join(k.home, ".config", "beads", "credentials")));
  assert.notEqual(await k.run("init", "--server", "rbn3:3307", "--owner", "sona", "--credential", path.join(k.home, "absent")), 0);
  assert.match(k.err.join(""), /absent/);
  assert.deepEqual(k.runner.calls, []);
  assert.equal(fs.existsSync(k.configFile), false);
});

test("kitchen init takes the database, SQL user and host name as options", async (t) => {
  const k = kitchen(t, [{ command: "bd", args: ["--actor", "raffy", "init"] }, { command: "bd", args: ["--actor", "raffy", "config", "set"] }]);

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
    ...CONFIGURED,
  ]);
  const space = path.join(k.configDir, "space");
  assert.equal(await k.run("init", "--server", "rbn3:3307", "--owner", "sona"), 0, k.err.join(""));
  fs.writeFileSync(path.join(space, "marker"), "the beads workspace bd set up");

  assert.equal(await k.run("init", "--server", "rbn3:3307", "--owner", "sona"), 0, k.err.join(""));
  assert.ok(k.runner.calls[3]?.argv.includes("--reinit-local"), "the second run re-initialises the existing workspace");
  assert.ok(!k.runner.calls[0]?.argv.includes("--reinit-local"), "the first run does not");

  assert.notEqual(await k.run("init", "--server", "gone:3307", "--owner", "sona"), 0);
  assert.equal(fs.readFileSync(path.join(space, "marker"), "utf8"), "the beads workspace bd set up", "an existing space survives a failed run");
  assert.equal(JSON.parse(fs.readFileSync(k.configFile, "utf8")).server.host, "rbn3", "the earlier config survives too");
});

test("kitchen init refuses to run without a server or --local, and without an owner, before any command is issued", async (t) => {
  const k = kitchen(t, []);

  assert.notEqual(await k.run("init", "--owner", "sona"), 0);
  assert.match(k.err.join(""), /--server <host:port> or --local/);
  assert.notEqual(await k.run("init", "--server", "rbn3:3307"), 0);
  assert.match(k.err.join(""), /--owner/);
  assert.notEqual(await k.run("init", "--server", "rbn3", "--owner", "sona"), 0);
  assert.match(k.err.join(""), /host:port/);
  assert.deepEqual(k.runner.calls, []);
  assert.equal(fs.existsSync(k.configFile), false);
});

test("kitchen init --local creates an embedded beads workspace under the config directory with no server, no credential and no password, sets Kitchen's types and the journal, and writes a config naming neither", async (t) => {
  const k = kitchen(t, [{ command: "bd", args: ["--actor", "sona", "init", "--prefix"] }, ...CONFIGURED]);

  const code = await k.run("init", "--local", "--owner", "sona");

  assert.equal(code, 0, k.err.join(""));
  assert.deepEqual(JSON.parse(fs.readFileSync(k.configFile, "utf8")), { owner: "sona", host: "sona-laptop" });
  const space = path.join(k.configDir, "space");
  assert.deepEqual(k.runner.calls, [
    {
      argv: ["bd", "--actor", "sona", "init", "--prefix", "kitchen", "--non-interactive", "--quiet", "--skip-agents", "--skip-hooks"],
      cwd: space,
      env: {},
    },
    ...SPACE_CONFIG_CALLS(space, {}),
  ]);
  assert.match(k.out.join(""), new RegExp(`Local space created at ${space}`));
  assert.ok(!fs.existsSync(path.join(k.home, ".config", "beads", "credentials.touched")), "no credentials file is needed");
});

test("kitchen init --local takes no server option, a failed bd init removes the new space and writes no config, and a second run re-initialises in place", async (t) => {
  const k = kitchen(t, [
    { command: "bd", args: ["--actor", "sona", "init", "--prefix"], exitCode: 1, stderr: "disk full\n", once: true },
    { command: "bd", args: ["--actor", "sona", "init", "--prefix"] },
    ...CONFIGURED,
  ]);
  const space = path.join(k.configDir, "space");

  assert.notEqual(await k.run("init", "--local", "--server", "rbn3:3307", "--owner", "sona"), 0);
  assert.match(k.err.join(""), /--local takes no --server/);
  assert.notEqual(await k.run("init", "--local", "--credential", "/x", "--user", "u", "--owner", "sona"), 0);
  assert.match(k.err.join(""), /--local takes no --user, --credential/);
  assert.equal(k.runner.calls.length, 0);

  assert.notEqual(await k.run("init", "--local", "--owner", "sona"), 0);
  assert.match(k.err.join(""), /could not create the local space[\s\S]*disk full/);
  assert.equal(fs.existsSync(space), false);
  assert.equal(fs.existsSync(k.configFile), false);

  assert.equal(await k.run("init", "--local", "--owner", "sona"), 0, k.err.join(""));
  assert.ok(!k.runner.calls.at(-3)?.argv.includes("--reinit-local"));
  assert.equal(await k.run("init", "--local", "--owner", "sona"), 0, k.err.join(""));
  assert.ok(k.runner.calls.at(-3)?.argv.includes("--reinit-local"), "an existing space is re-initialised in place");
});

test("a bd config set that fails ends kitchen init with its stderr and no config written", async (t) => {
  const k = kitchen(t, [
    { command: "bd", args: ["--actor", "sona", "init", "--prefix"] },
    { command: "bd", args: ["--actor", "sona", "config", "set", "types.custom"] },
    { command: "bd", args: ["--actor", "sona", "config", "set", "events-journal"], exitCode: 1, stderr: "config is read-only\n" },
  ]);

  assert.notEqual(await k.run("init", "--local", "--owner", "sona"), 0);
  assert.match(k.err.join(""), /bd config set events-journal failed[\s\S]*config is read-only/);
  assert.equal(fs.existsSync(k.configFile), false);
});
