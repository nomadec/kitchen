// A host that ran kitchen init, for tests of the commands that come after it: a temporary home holding
// the host config, a fake runner and clock, and the CLI deps wired to them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CliDeps } from "../cli.ts";
import type { HostConfig } from "../config.ts";
import { fakeClock } from "./fake-clock.ts";
import { fakeRunner } from "./fake-runner.ts";
import type { FakeRunner, ScriptedAnswer } from "./fake-runner.ts";

export const TEST_HOST_CONFIG: HostConfig = {
  server: { host: "rbn3", port: 3307, user: "sona", database: "kitchen" },
  credential: "/home/sona/.config/beads/credentials",
  owner: "sona",
  host: "sona-laptop",
};

export interface InitialisedHost {
  deps: CliDeps;
  runner: FakeRunner;
  /** What the command printed, one entry per write. */
  out: string[];
  err: string[];
  home: string;
  configDir: string;
  configFile: string;
  /** The connection every bd call from this host runs over. */
  connection: { cwd: string; env: { BEADS_CREDENTIALS_FILE: string } };
}

export interface HostOptions {
  /** Entries laid over the environment, such as the `BEADS_ACTOR` a session Kitchen started carries. */
  sessionEnv?: Record<string, string>;
  config?: HostConfig;
  /** The platform `kitchen up` writes a service unit for; `linux` unless a test says `darwin`. */
  platform?: string;
}

/** Where the test host's kitchen program lives: the service unit and the runner name these. */
export const TEST_PROGRAM = {
  argv: ["/usr/bin/node", "/opt/kitchen/dist/bin/kitchen.js"],
  pluginDir: "/opt/kitchen/plugin",
  uiDir: "/opt/kitchen/dist/ui",
} as const;

/** A host with its config written, removed when the test ends. */
export function initialisedHost(t: { after(fn: () => void): void }, table: readonly ScriptedAnswer[], options: HostOptions = {}): InitialisedHost {
  const config = options.config ?? TEST_HOST_CONFIG;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-host-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, ".config", "kitchen");
  fs.mkdirSync(configDir, { recursive: true });
  const configFile = path.join(configDir, "config.json");
  fs.writeFileSync(configFile, JSON.stringify(config));
  const out: string[] = [];
  const err: string[] = [];
  const clock = fakeClock();
  const runner = fakeRunner(table, clock);
  const deps: CliDeps = {
    runner,
    clock,
    env: { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), PATH: "/usr/local/bin:/usr/bin", ...options.sessionEnv },
    hostname: config.host,
    program: { platform: options.platform ?? "linux", ...TEST_PROGRAM },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return {
    deps, runner, out, err, home, configDir, configFile,
    connection: { cwd: path.join(configDir, "space"), env: { BEADS_CREDENTIALS_FILE: config.credential } },
  };
}
