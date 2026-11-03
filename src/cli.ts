// The kitchen command: ten v1 subcommands, dispatched by name. Everything external comes in through deps.
import type { Clock } from "./clock.ts";
import type { CommandRunner } from "./runner.ts";
import { down } from "./commands/down.ts";
import { init } from "./commands/init.ts";
import { orderAdd } from "./commands/order-add.ts";
import { recipeAdd } from "./commands/recipe-add.ts";
import { sourceAdd } from "./commands/source-add.ts";
import { stationAdd } from "./commands/station-add.ts";
import { up } from "./commands/up.ts";

/** The kitchen program itself, as the expeditor's service unit and the runner need to name it. */
export interface Program {
  /** `linux` or `darwin`: which service manager `kitchen up` writes for. */
  platform: string;
  /** The argv that starts kitchen: node and the bin script. */
  argv: readonly string[];
  /** The Kitchen plugin directory the runner loads into every session: the turn driver and the Stop hook. */
  pluginDir: string;
}

export interface CliDeps {
  runner: CommandRunner;
  clock: Clock;
  env: Record<string, string | undefined>;
  /** The name of this host, written into the host config by `kitchen init`. */
  hostname: string;
  program: Program;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export type Command = (args: readonly string[], deps: CliDeps) => Promise<number>;

interface CommandEntry {
  name: string;
  summary: string;
  run?: Command;
}

/** The v1 commands, in the order `kitchen --help` lists them. Nothing else. */
export const COMMANDS: readonly CommandEntry[] = [
  { name: "init", summary: "Write this host's config and verify the connection to the space", run: init },
  { name: "up", summary: "Start this host's expeditor as a user service", run: up },
  { name: "down", summary: "Stop this host's expeditor, leaving claimed phases reclaimable", run: down },
  { name: "order add", summary: "Add an order from a source URL, a file or a sentence", run: orderAdd },
  { name: "recipe add", summary: "Register a recipe from a plugin directory, a file or a URL", run: recipeAdd },
  { name: "station add", summary: "Register a station on this host from a template and values", run: stationAdd },
  { name: "source add", summary: "Register a polled source with its kind, target, recipe and class", run: sourceAdd },
  { name: "turn", summary: "Run one waiting phase on an attended station in this terminal" },
  { name: "pass", summary: "List briefed passes and close one with your word" },
  { name: "status", summary: "Show the expeditor, running turns, waiting phases, open passes and caps" },
];

export function help(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  const lines = COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`);
  return ["Usage: kitchen <command> [options]", "", "Commands:", ...lines, ""].join("\n");
}

/** Runs the kitchen command for an argv (without the node and script entries). Resolves to the exit code. */
export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  const first = argv[0];
  if (first === undefined) {
    deps.stderr(help());
    return 1;
  }
  if (first === "--help" || first === "-h" || first === "help") {
    deps.stdout(help());
    return 0;
  }
  const match = COMMANDS.find((c) => c.name === `${argv[0]} ${argv[1]}`) ?? COMMANDS.find((c) => c.name === first);
  if (!match) {
    const group = COMMANDS.filter((c) => c.name.startsWith(`${first} `)).map((c) => `kitchen ${c.name}`);
    const hint = group.length ? `kitchen ${first} needs a subcommand: ${group.join(", ")}` : `unknown command: ${first}`;
    deps.stderr(`kitchen: ${hint}\n\n${help()}`);
    return 1;
  }
  if (!match.run) {
    deps.stderr(`kitchen ${match.name} is not implemented yet.\n`);
    return 1;
  }
  const rest = argv.slice(match.name.split(" ").length);
  return match.run(rest, deps);
}
