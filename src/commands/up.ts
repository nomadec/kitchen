// kitchen up: install and start this host's expeditor as a user service. With --foreground it is the
// expeditor itself: the long-lived process the service unit runs, ticking every interval until it is
// told to stop; --once runs one tick and waits for the turns it started, for a check by hand or a test.
// The foreground process also serves the UI, and the API behind it, behind a token file (story 69).
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { CliDeps, Command } from "../cli.ts";
import { expeditorLogFile, expeditorStateFile, hostConfigFile, readHostConfig, serveTokenFile } from "../config.ts";
import type { HostConfig } from "../config.ts";
import { claudeRunner } from "../expeditor/claude.ts";
import { openLog } from "../expeditor/log.ts";
import type { Log } from "../expeditor/log.ts";
import { DEFAULT_INTERVAL, DEFAULT_PORT } from "../expeditor/service.ts";
import { expeditorState } from "../expeditor/state.ts";
import { expeditor } from "../expeditor/tick.ts";
import { startUi } from "../expeditor/ui.ts";
import { runEach, unitFor } from "./service-unit.ts";

const USAGE = `Usage: kitchen up [options]

Installs this host's expeditor as a user service (systemd on Linux, launchd on macOS) and starts it.
The expeditor serves the UI on its port, bound to loopback, behind a token file it generates (docs/ui.md).

Options:
  --interval <seconds>   Seconds between ticks (default: ${DEFAULT_INTERVAL})
  --port <port>          The loopback port of the UI (default: ${DEFAULT_PORT}); 0 gives an ephemeral port,
                         for a check by hand
  --foreground           Run the expeditor in this process instead of installing the service
  --once                 With --foreground: one tick, then wait for the turns it started, then exit;
                         no UI is started for it
`;

export const up: Command = async (args, deps) => {
  const fail = (message: string): number => {
    deps.stderr(`kitchen up: ${message}\n\n${USAGE}`);
    return 1;
  };
  if (args.includes("--help") || args.includes("-h")) {
    deps.stdout(USAGE);
    return 0;
  }
  let options: ReturnType<typeof parseOptions>;
  try {
    options = parseOptions(args);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const interval = options.interval === undefined ? DEFAULT_INTERVAL : Number(options.interval);
  if (!Number.isInteger(interval) || interval < 1) return fail(`--interval must be a whole number of seconds, got ${options.interval}`);
  const port = options.port === undefined ? DEFAULT_PORT : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return fail(`--port must be a whole number from 0 to 65535, got ${options.port}`);
  const config = readHostConfig(deps.env);
  if (!config) return fail(`no host config at ${hostConfigFile(deps.env)}: run kitchen init first`);
  if (options.foreground) return foreground(deps, config, interval, port, options.once ?? false);
  if (options.once) return fail("--once goes with --foreground");

  const unit = unitFor(deps, { interval, port });
  if ("error" in unit) return fail(unit.error);
  fs.mkdirSync(path.dirname(unit.file), { recursive: true });
  fs.writeFileSync(unit.file, unit.content);
  if (!(await runEach(deps, "up", unit.install))) return 1;
  deps.stdout(`Wrote ${unit.file} and started the expeditor; its log is ${expeditorLogFile(deps.env)}; the UI is http://127.0.0.1:${port}\n`);
  return 0;
};

async function foreground(deps: CliDeps, config: HostConfig, interval: number, port: number, once: boolean): Promise<number> {
  const log = openLog(expeditorLogFile(deps.env), deps.clock);
  const run = expeditor({
    runner: deps.runner,
    env: deps.env,
    log,
    clock: deps.clock,
    turnRunner: claudeRunner({ runner: deps.runner, env: deps.env, config, pluginDir: deps.program.pluginDir }),
  });
  // What kitchen status reads: the pid, the last tick and its instant, and the stop when it is clean.
  const state = expeditorState(expeditorStateFile(deps.env), deps.clock, { pid: process.pid, owner: config.owner, host: config.host, interval });
  if (once) {
    // One tick for a check by hand: nothing is served for it.
    const report = await run.tick();
    state.ticked(report.tick);
    const ends = await run.settle();
    state.stopped();
    deps.stdout(`Tick ${report.tick}: laid ${report.laid.length}, started ${report.started.length}, waiting ${report.waiting.length}, ended ${ends.length}\n`);
    return 0;
  }
  let servers: { stop(): Promise<void> };
  try {
    servers = await serve(deps, config, log, port);
  } catch (error) {
    // A listen refused (the port taken): logged, the state left stopped, and the exit is the service's to report.
    const failed = error instanceof Error ? error.message : String(error);
    log.write({ step: "serve", failed });
    state.stopped();
    deps.stderr(`kitchen up: could not serve: ${failed}\n`);
    return 1;
  }
  try {
    // `kitchen down` stops the service, which signals this process: the loop ends after the current
    // tick and the claims stay as they are, reclaimable once their leases go stale.
    let stopping = false;
    const stop = (): void => {
      stopping = true;
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    log.write({ step: "start", interval, host: config.host, owner: config.owner });
    while (!stopping) {
      const report = await run.tick();
      state.ticked(report.tick);
      await deps.clock.sleep(interval * 1000);
    }
    log.write({ step: "stop" });
    state.stopped();
    return 0;
  } finally {
    await servers.stop();
  }
}

/** Starts the UI server with a fresh token and logs where it listens. */
async function serve(deps: CliDeps, config: HostConfig, log: Log, port: number): Promise<{ stop(): Promise<void> }> {
  const ui = await startUi({ uiDir: deps.program.uiDir, config, runner: deps.runner, env: deps.env, tokenFile: serveTokenFile(deps.env), port });
  log.write({ step: "serve", ui: ui.url, token: ui.tokenFile });
  return {
    stop: async () => {
      await ui.close();
      log.write({ step: "serve", stopped: true });
    },
  };
}

function parseOptions(args: readonly string[]) {
  const { values } = parseArgs({
    args: [...args],
    options: {
      interval: { type: "string" },
      port: { type: "string" },
      foreground: { type: "boolean" },
      once: { type: "boolean" },
    },
    allowPositionals: false,
    strict: true,
  });
  return values;
}
