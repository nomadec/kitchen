// The package surface: the CLI entry and the two seams later slices and tests build on.
export { main, help, COMMANDS } from "./cli.ts";
export type { CliDeps, Command } from "./cli.ts";
export { processRunner } from "./runner.ts";
export type { CommandRunner, CommandResult, CommandOptions } from "./runner.ts";
export { systemClock } from "./clock.ts";
export type { Clock } from "./clock.ts";
