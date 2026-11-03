// kitchen up and kitchen down, exercised through the service unit they write under a temporary home
// and the service manager commands they issue: systemd on Linux, launchd on macOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { main } from "../cli.ts";
import { initialisedHost } from "../testing/index.ts";
import type { ScriptedAnswer } from "../testing/index.ts";

const SYSTEMD: ScriptedAnswer[] = [{ command: "systemctl", args: ["--user"] }];
const LAUNCHD: ScriptedAnswer[] = [{ command: "launchctl", args: [] }];

function kitchen(t: { after(fn: () => void): void }, table: readonly ScriptedAnswer[], platform = "linux") {
  const host = initialisedHost(t, table, { platform });
  const run = (...argv: string[]) => main(argv, host.deps);
  const argv = () => host.runner.calls.map((c) => c.argv);
  return { ...host, run, argv };
}

test("on Linux, kitchen up writes the systemd user unit running kitchen up --foreground and enables it now; kitchen down disables it and removes the unit", async (t) => {
  const k = kitchen(t, SYSTEMD);
  const unit = path.join(k.home, ".config", "systemd", "user", "kitchen-expeditor.service");

  assert.equal(await k.run("up", "--interval", "3"), 0, k.err.join(""));

  const content = fs.readFileSync(unit, "utf8");
  assert.match(content, /^\[Unit\]\nDescription=Kitchen expeditor on sona-laptop\n/);
  assert.match(content, /\nExecStart=\/usr\/bin\/node \/opt\/kitchen\/dist\/bin\/kitchen\.js up --foreground --interval 3\n/);
  assert.match(content, /\nRestart=on-failure\n/);
  assert.match(content, /\nEnvironment=PATH=\/usr\/local\/bin:\/usr\/bin\n/);
  assert.match(content, new RegExp(`\nEnvironment=XDG_CONFIG_HOME=${path.join(k.home, ".config")}\n`));
  assert.match(content, /\n\[Install\]\nWantedBy=default\.target\n$/);
  assert.deepEqual(k.argv(), [
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", "kitchen-expeditor.service"],
  ]);
  assert.match(k.out.join(""), new RegExp(`Wrote ${unit} and started the expeditor; its log is ${path.join(k.home, ".local", "state", "kitchen", "expeditor.jsonl")}\n`));

  assert.equal(await k.run("down"), 0, k.err.join(""));

  assert.ok(!fs.existsSync(unit), "the unit is removed");
  assert.deepEqual(k.argv().slice(2), [
    ["systemctl", "--user", "disable", "--now", "kitchen-expeditor.service"],
    ["systemctl", "--user", "daemon-reload"],
  ]);
  assert.match(k.out.join(""), /Stopped the expeditor and removed /);
});

test("on macOS, kitchen up writes the launchd agent and loads it; kitchen down unloads it and removes the plist", async (t) => {
  const k = kitchen(t, LAUNCHD, "darwin");
  const plist = path.join(k.home, "Library", "LaunchAgents", "ai.nomadec.kitchen.expeditor.plist");

  assert.equal(await k.run("up"), 0, k.err.join(""));

  const content = fs.readFileSync(plist, "utf8");
  assert.match(content, /<key>Label<\/key>\n\s*<string>ai\.nomadec\.kitchen\.expeditor<\/string>/);
  assert.match(content, /<key>ProgramArguments<\/key>\n\s*<array>\n\s*<string>\/usr\/bin\/node<\/string>\n\s*<string>\/opt\/kitchen\/dist\/bin\/kitchen\.js<\/string>\n\s*<string>up<\/string>\n\s*<string>--foreground<\/string>\n\s*<string>--interval<\/string>\n\s*<string>5<\/string>\n\s*<\/array>/);
  assert.match(content, /<key>KeepAlive<\/key>\n\s*<true\/>/);
  assert.match(content, /<key>PATH<\/key>\n\s*<string>\/usr\/local\/bin:\/usr\/bin<\/string>/);
  assert.deepEqual(k.argv(), [["launchctl", "load", "-w", plist]]);

  assert.equal(await k.run("down"), 0, k.err.join(""));

  assert.ok(!fs.existsSync(plist));
  assert.deepEqual(k.argv().slice(1), [["launchctl", "unload", "-w", plist]]);
});

test("the unit is written and the service left alone when the service manager refuses, and the refusal is reported", async (t) => {
  const k = kitchen(t, [
    { command: "systemctl", args: ["--user", "daemon-reload"] },
    { command: "systemctl", args: ["--user", "enable"], stderr: "Failed to connect to bus\n", exitCode: 1 },
  ]);
  assert.notEqual(await k.run("up"), 0);
  assert.match(k.err.join(""), /systemctl --user enable --now kitchen-expeditor.service failed \(exit 1\): Failed to connect to bus/);
});

test("kitchen down with no service installed, kitchen up on a host without kitchen init, a bad interval and an unsupported platform are each refused naming the gap", async (t) => {
  const k = kitchen(t, SYSTEMD);
  assert.notEqual(await k.run("down"), 0);
  assert.match(k.err.at(-1) ?? "", /no expeditor service at .*kitchen-expeditor\.service: nothing to stop/);
  assert.notEqual(await k.run("up", "--interval", "0"), 0);
  assert.match(k.err.at(-1) ?? "", /--interval must be a whole number of seconds, got 0/);
  assert.notEqual(await k.run("up", "--once"), 0);
  assert.match(k.err.at(-1) ?? "", /--once goes with --foreground/);
  assert.equal(k.runner.calls.length, 0);
  fs.rmSync(k.configFile);
  assert.notEqual(await k.run("up"), 0);
  assert.match(k.err.at(-1) ?? "", /run kitchen init first/);

  const w = kitchen(t, [], "win32");
  assert.notEqual(await w.run("up"), 0);
  assert.match(w.err.at(-1) ?? "", /no user service manager for win32/);
  assert.notEqual(await w.run("down"), 0);
  assert.match(w.err.at(-1) ?? "", /no user service manager for win32/);
});

/** A tick over an empty space: no stations on this host, nothing to reclaim, no order held. */
const QUIET_TICK: ScriptedAnswer[] = [
  { command: "bd", args: ["--actor", "sona/expeditor", "list", "--type", "station"], stdout: "[]" },
  { command: "bd", args: ["--actor", "sona/expeditor", "reclaim", "--json"], stdout: '{"count":0,"reclaimed":null}' },
  { command: "bd", args: ["--actor", "sona/expeditor", "list", "--type", "epic"], stdout: "[]" },
];

test("kitchen up --foreground keeps the expeditor's state file current: written after every tick with the tick count and the instant, and marked stopped when the service is told to stop", async (t) => {
  const k = kitchen(t, QUIET_TICK);
  const stateFile = path.join(k.home, ".local", "state", "kitchen", "expeditor.json");
  const state = () => JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, unknown>;

  const running = k.run("up", "--foreground", "--interval", "2");
  for (let turns = 0; !fs.existsSync(stateFile) || (state().tick as number) < 2; turns++) {
    assert.ok(turns < 1000, `no second tick recorded at ${stateFile}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
  const seen = state();
  const tick = seen.tick as number;
  assert.deepEqual(seen, {
    pid: process.pid, owner: "sona", host: "sona-laptop", interval: 2,
    started: "2026-01-01T00:00:00.000Z", tick, at: new Date(Date.UTC(2026, 0, 1, 0, 0, 2 * (tick - 1))).toISOString(),
  }, "one tick every interval on the clock, the file written at each tick's end");

  process.emit("SIGTERM");
  assert.equal(await running, 0, k.err.join(""));
  const stopped = state();
  assert.equal(typeof stopped.stopped, "string", "the stop is recorded");
  assert.ok((stopped.tick as number) >= tick);
});
