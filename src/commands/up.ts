// kitchen up: install and start this host's expeditor as a user service. With --foreground it is the
// expeditor itself: the long-lived process the service unit runs, ticking every interval until it is
// told to stop; --once runs one tick and waits for the turns it started, for a check by hand or a test.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { CliDeps, Command } from "../cli.ts";
import { expeditorLogFile, hostConfigFile, readHostConfig } from "../config.ts";
import { claudeRunner } from "../expeditor/claude.ts";
import { openLog } from "../expeditor/log.ts";
import { DEFAULT_INTERVAL } from "../expeditor/service.ts";
import { expeditor } from "../expeditor/tick.ts";
import { runEach, unitFor } from "./service-unit.ts";

const USAGE = `Usage: kitchen up [options]

Installs this host's expeditor as a user service (systemd on Linux, launchd on macOS) and starts it.

Options:
  --interval <seconds>   Seconds between ticks (default: ${DEFAULT_INTERVAL})
  --foreground           Run the expeditor in this process instead of installing the service
  --once                 With --foreground: one tick, then wait for the turns it started, then exit
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
  if (!readHostConfig(deps.env)) return fail(`no host config at ${hostConfigFile(deps.env)}: run kitchen init first`);
  if (options.foreground) return foreground(deps, interval, options.once ?? false);
  if (options.once) return fail("--once goes with --foreground");

  const unit = unitFor(deps, interval);
  if ("error" in unit) return fail(unit.error);
  fs.mkdirSync(path.dirname(unit.file), { recursive: true });
  fs.writeFileSync(unit.file, unit.content);
  if (!(await runEach(deps, "up", unit.install))) return 1;
  deps.stdout(`Wrote ${unit.file} and started the expeditor; its log is ${expeditorLogFile(deps.env)}\n`);
  return 0;
};

async function foreground(deps: CliDeps, interval: number, once: boolean): Promise<number> {
  const config = readHostConfig(deps.env);
  if (!config) return 1;
  const log = openLog(expeditorLogFile(deps.env), deps.clock);
  const run = expeditor({
    runner: deps.runner,
    env: deps.env,
    log,
    clock: deps.clock,
    turnRunner: claudeRunner({ runner: deps.runner, env: deps.env, config, pluginDir: deps.program.pluginDir }),
  });
  if (once) {
    const report = await run.tick();
    const ends = await run.settle();
    deps.stdout(`Tick ${report.tick}: started ${report.started.length}, waiting ${report.waiting.length}, ended ${ends.length}\n`);
    return 0;
  }
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
    await run.tick();
    await deps.clock.sleep(interval * 1000);
  }
  log.write({ step: "stop" });
  return 0;
}

function parseOptions(args: readonly string[]) {
  const { values } = parseArgs({
    args: [...args],
    options: {
      interval: { type: "string" },
      foreground: { type: "boolean" },
      once: { type: "boolean" },
    },
    allowPositionals: false,
    strict: true,
  });
  return values;
}
