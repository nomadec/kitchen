// kitchen up: install and start this host's expeditor as a user service. With --foreground it is the
// expeditor itself: the long-lived process the service unit runs, ticking every interval until it is
// told to stop; --once runs one tick and waits for the turns it started, for a check by hand or a test.
// The foreground process also runs bd serve behind a token file and serves the UI beside it (story 69).
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";
import type { CliDeps, Command } from "../cli.ts";
import { expeditorLogFile, expeditorStateFile, hostConfigFile, readHostConfig } from "../config.ts";
import type { HostConfig } from "../config.ts";
import { claudeRunner } from "../expeditor/claude.ts";
import { openLog } from "../expeditor/log.ts";
import type { Log } from "../expeditor/log.ts";
import { startServe } from "../expeditor/serve.ts";
import { DEFAULT_INTERVAL, DEFAULT_PORT } from "../expeditor/service.ts";
import { expeditorState } from "../expeditor/state.ts";
import { expeditor } from "../expeditor/tick.ts";
import { startUi } from "../expeditor/ui.ts";
import { runEach, unitFor } from "./service-unit.ts";

const USAGE = `Usage: kitchen up [options]

Installs this host's expeditor as a user service (systemd on Linux, launchd on macOS) and starts it.
The expeditor serves the UI on its port, bound to loopback, and runs bd serve on the next port behind
a token file it generates (docs/ui.md).

Options:
  --interval <seconds>   Seconds between ticks (default: ${DEFAULT_INTERVAL})
  --port <port>          The loopback port of the UI; bd serve takes the next one (default: ${DEFAULT_PORT});
                         0 gives both an ephemeral port, for a check by hand
  --foreground           Run the expeditor in this process instead of installing the service
  --once                 With --foreground: one tick, then wait for the turns it started, then exit;
                         no UI and no bd serve are started for it
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
    // The port probe or a listen refused: logged, the state left stopped, and the exit is the service's to report.
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

/** Starts bd serve and the UI server, logs where they listen, and reports a bd serve that ends on its own. */
async function serve(deps: CliDeps, config: HostConfig, log: Log, port: number): Promise<{ stop(): Promise<void> }> {
  // bd serve needs a fixed port (an ephemeral one is only printed on its stdout): the one after the UI's,
  // and a free one of this host's choosing when the UI takes an ephemeral port, so two runs by hand do not collide.
  const api = startServe({ runner: deps.runner, env: deps.env, config }, port === 0 ? await freePort() : port + 1);
  let stopped = false;
  void api.done.then((result) => {
    if (!stopped) log.write({ step: "serve", ended: `bd serve exited ${result.exitCode}`, stderr: result.stderr.trim() });
  });
  const ui = await startUi({ uiDir: deps.program.uiDir, owner: config.owner, host: config.host, port, api: api.url });
  log.write({ step: "serve", ui: ui.url, api: api.url, token: api.tokenFile });
  return {
    stop: async () => {
      stopped = true;
      api.stop();
      await ui.close();
      log.write({ step: "serve", stopped: true });
    },
  };
}

/** A loopback port nothing listens on now: bound to 0 and released, for bd serve to take next. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
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
